import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * Clients talk to orbitd only through @orbit/sdk-client (CLAUDE.md). The CLI
 * may use @orbit/core (types, errors, redaction) and a few process-level
 * helpers from @orbit/runtime (ORBIT_HOME, the orbitd child-env allowlist,
 * the name-only OAuth presence check, help text, where the orbitd bin is) — never the store, policy, sandbox,
 * orchestrator or API internals, which would let it bypass the daemon.
 */
const ALLOWED_RUNTIME_IMPORTS = new Set([
  'defaultHome',
  'buildChildEnv',
  'hasOAuthTokenEnv',
  // where the orbitd bin lives: the dev tree or the npm package (ADR-017)
  'orbitLayout',
  // static help text for `orbit login-help`
  'ONBOARDING_STEPS',
  // the variable naming how orbitd gets its API key (a constant, never the key)
  'API_KEY_HANDOVER_VAR',
]);
const FORBIDDEN_PACKAGES = ['@orbit/store', '@orbit/policy', '@orbit/sandbox', '@orbit/memory'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

interface ImportUse {
  file: string;
  from: string;
  names: string[];
}

export function importsOf(file: string, text: string): ImportUse[] {
  const uses: ImportUse[] = [];
  const re = /import\s+(type\s+)?([\s\S]*?)\s+from\s+'([^']+)'/g;
  for (const m of text.matchAll(re)) {
    const names = (m[2] ?? '')
      .replace(/[{}]/g, '')
      .split(',')
      .map((n) => n.trim().replace(/^type\s+/, ''))
      .filter(Boolean);
    uses.push({ file, from: m[3] ?? '', names });
  }
  for (const m of text.matchAll(/import\(\s*'([^']+)'\s*\)/g)) {
    uses.push({ file, from: m[1] ?? '', names: ['*'] });
  }
  return uses;
}

export function violations(uses: ImportUse[]): string[] {
  const out: string[] = [];
  for (const u of uses) {
    if (FORBIDDEN_PACKAGES.some((p) => u.from === p || u.from.startsWith(`${p}/`))) {
      out.push(`${u.file}: imports ${u.from}`);
    }
    if (u.from === '@orbit/api' || u.from === '@orbit/orbitd') {
      out.push(`${u.file}: imports ${u.from} (use @orbit/sdk-client)`);
    }
    if (u.from === '@orbit/runtime') {
      for (const n of u.names) {
        if (!ALLOWED_RUNTIME_IMPORTS.has(n))
          out.push(`${u.file}: imports ${n} from @orbit/runtime`);
      }
    }
  }
  return out;
}

describe('thin-client invariant (apps/orbit-tui)', () => {
  it('the CLI reaches orbitd only through @orbit/sdk-client', () => {
    const dir = join(ROOT, 'apps/orbit-tui/src');
    const uses = sourceFiles(dir).flatMap((f) =>
      importsOf(relative(ROOT, f), readFileSync(f, 'utf8')),
    );
    expect(uses.some((u) => u.from === '@orbit/sdk-client')).toBe(true);
    expect(violations(uses)).toEqual([]);
  });

  it('positive control: the guard fires on a CLI that bypasses the daemon', () => {
    const bad = importsOf(
      'apps/orbit-tui/src/bad.ts',
      [
        "import { EventStore } from '@orbit/store';",
        "import { Orchestrator, defaultHome } from '@orbit/runtime';",
        "import { OrbitService } from '@orbit/api';",
        "const m = await import('@orbit/policy');",
      ].join('\n'),
    );
    expect(violations(bad)).toEqual([
      'apps/orbit-tui/src/bad.ts: imports @orbit/store',
      'apps/orbit-tui/src/bad.ts: imports Orchestrator from @orbit/runtime',
      'apps/orbit-tui/src/bad.ts: imports @orbit/api (use @orbit/sdk-client)',
      'apps/orbit-tui/src/bad.ts: imports @orbit/policy',
    ]);
  });
});

/** The App (a browser) may use only the browser-safe entries (ADR-011). */
const APP_ALLOWED = new Set(['@orbit/core/browser', '@orbit/sdk-client/browser']);

export function appViolations(uses: ImportUse[]): string[] {
  return uses
    .filter((u) => u.from.startsWith('@orbit/') && !APP_ALLOWED.has(u.from))
    .map(
      (u) =>
        `${u.file}: imports ${u.from} (the App uses @orbit/core/browser and @orbit/sdk-client/browser only)`,
    );
}

describe('thin-client invariant (apps/orbit-app)', () => {
  it('the App reaches orbitd only through the browser client', () => {
    const dir = join(ROOT, 'apps/orbit-app/src');
    const files = sourceFiles(dir).filter((f) => !f.includes(join('src', 'test')));
    const uses = files.flatMap((f) => importsOf(relative(ROOT, f), readFileSync(f, 'utf8')));
    expect(uses.some((u) => u.from === '@orbit/sdk-client/browser')).toBe(true);
    expect(appViolations(uses)).toEqual([]);
  });

  it('positive control: the guard fires on server or node-only imports', () => {
    const bad = importsOf(
      'apps/orbit-app/src/bad.ts',
      [
        "import { localClient } from '@orbit/sdk-client';",
        "import { sha256Hex } from '@orbit/core';",
        "import { routes } from '@orbit/api/contract';",
      ].join('\n'),
    );
    expect(appViolations(bad)).toHaveLength(3);
  });
});
