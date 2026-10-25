import { readFileSync } from 'node:fs';
import { OrbitError, defaultRedactor } from '@orbit/core';
import type { RouteResponse } from '@orbit/sdk-client';
import type { Context } from '../context';
import { painter } from '../io';
import { scrubControls } from '../render';

export type SetupMode = 'demo' | 'api' | 'cli';

export interface SetupOptions {
  mode?: string;
  model?: string;
  apiKeyStdin?: boolean;
  forgetApiKey?: boolean;
  json?: boolean;
  /** Test seam; production reads the piped key directly from stdin. */
  stdin?: () => string;
}

function setupMode(value: string): SetupMode {
  if (value === 'demo' || value === 'api' || value === 'cli') return value;
  throw new OrbitError('invalid_input', 'Choose api, cli or demo for --mode', {
    hint: 'Run `orbit setup` in a terminal for guided setup.',
  });
}

function showStatus(ctx: Context, s: RouteResponse<'getSetup'>): void {
  const p = painter(ctx.io);
  ctx.io.out(p('bold', 'Set up Orbit'));
  ctx.io.out(`  Engine: ${scrubControls(s.doctor.authLabel)}`);
  ctx.io.out(`  Model:  ${scrubControls(s.doctor.models.default)}`);
  ctx.io.out(
    s.doctor.driver === 'mock'
      ? '  Demo mode replays recorded replies. No model calls or charges.'
      : s.doctor.ok
        ? '  Credentials detected. No paid model request has been made by setup.'
        : '  Connect an engine before starting a real Bot.',
  );
  if (s.reason) ctx.io.out(`  ${scrubControls(s.reason)}`);
}

/** One setup flow for a fresh install or switching an existing demo to a real engine. */
export async function setup(ctx: Context, o: SetupOptions): Promise<number> {
  if (o.apiKeyStdin && o.mode !== 'api') {
    throw new OrbitError('invalid_input', '--api-key-stdin requires --mode api');
  }
  if (o.forgetApiKey && o.mode !== 'demo') {
    throw new OrbitError('invalid_input', '--forget-api-key requires --mode demo');
  }
  const client = await ctx.client();
  const status = await client.call('getSetup');
  let mode = o.mode === undefined ? undefined : setupMode(o.mode);
  const interactive = ctx.io.interactive === true && o.json !== true;
  if (mode === undefined && !interactive) {
    if (o.json) ctx.io.out(JSON.stringify(status));
    else {
      showStatus(ctx, status);
      ctx.io.out('\nChoose an engine with `orbit setup --mode api|cli|demo`.');
      ctx.io.out('For a key from a pipe: `orbit setup --mode api --api-key-stdin`.');
    }
    return 0;
  }
  if (!status.canConfigure) {
    throw new OrbitError(
      'blocked',
      scrubControls(status.reason ?? 'Engine setup is unavailable right now'),
    );
  }
  if (!o.json) showStatus(ctx, status);
  if (!o.json) ctx.io.out('Engine setup applies to every Bot, including scheduled work.');
  if (mode === undefined) {
    if (!ctx.io.ask) throw new OrbitError('invalid_input', 'Interactive setup needs a terminal');
    ctx.io.out('\n  1. Anthropic API key — real replies, billed to your API account');
    ctx.io.out('  2. Existing Claude Code login — local personal use');
    ctx.io.out('  3. Demo — try Orbit without credentials');
    const choice = (await ctx.io.ask('Choose an engine [1/2/3, q to cancel]: ')).trim();
    if (choice === 'q') {
      ctx.io.out('Setup cancelled. Your engine is unchanged.');
      return 0;
    }
    mode = setupMode(
      ({ '1': 'api', '2': 'cli', '3': 'demo' } as Record<string, string>)[choice] ?? choice,
    );
  }
  let model = o.model?.trim();
  if (!model && interactive && ctx.io.ask) {
    model = (await ctx.io.ask('Default model alias or ID [sonnet]: ')).trim() || 'sonnet';
  }
  model ??= 'sonnet';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model) || model.startsWith('sk-ant-')) {
    throw new OrbitError('invalid_input', 'Enter a model alias or ID, such as sonnet');
  }
  let apiKey: string | undefined;
  if (o.apiKeyStdin) {
    apiKey = (o.stdin ?? (() => readFileSync(0, 'utf8')))().trim();
    if (!apiKey) throw new OrbitError('invalid_input', 'The API key on stdin is empty');
  } else if (mode === 'api' && interactive) {
    if (!ctx.io.askSecret) {
      throw new OrbitError('invalid_input', 'This terminal cannot hide a credential', {
        hint: 'Use `orbit setup --mode api --api-key-stdin` with a key from a secure source.',
      });
    }
    ctx.io.out('Create an API key at https://platform.claude.com/settings/keys.');
    const canKeep = status.apiKeyStored || status.doctor.apiCredential !== null;
    apiKey =
      (
        await ctx.io.askSecret(
          canKeep
            ? 'API key (hidden; Enter keeps the existing credential): '
            : 'API key (hidden): ',
        )
      ).trim() || undefined;
    if (!apiKey && !canKeep) {
      throw new OrbitError('invalid_input', 'An Anthropic API key is required for API mode');
    }
  }
  if (apiKey) defaultRedactor.addSecret(apiKey);
  if (mode === 'cli' && !o.json) {
    ctx.io.out(
      'Orbit uses your existing official Claude Code login; it never copies OAuth credentials.',
    );
    ctx.io.out(
      'If it is not ready, run `claude auth login`, then run `orbit setup --mode cli` again.',
    );
  }
  const configured = await client.call('configureSetup', {
    body: {
      mode,
      model,
      ...(apiKey ? { apiKey } : {}),
      ...(o.forgetApiKey ? { forgetApiKey: true } : {}),
    },
  });
  if (o.json) ctx.io.out(JSON.stringify(configured));
  else {
    ctx.io.out('\nSetup saved. It applies now and after Orbit restarts.');
    showStatus(ctx, configured);
    ctx.io.out(
      '\nNext: create a Bot with `orbit bot create --name Assistant --goal "Help with my tasks"`.',
    );
    ctx.io.out('Open `orbit` for the terminal UI, or `orbit app` for the browser.');
  }
  return 0;
}
