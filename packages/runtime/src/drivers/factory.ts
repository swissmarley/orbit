import { join } from 'node:path';
import { type OrbitConfig, OrbitError } from '@orbit/core';
import {
  type EngineCredential,
  HostKeyProxy,
  type HostKeyProxyStatus,
  type ProxyRefusal,
} from '@orbit/sandbox';
import type { AuthResolution } from '../auth/resolver';
import { assertCliDriverAllowed } from '../auth/guard';
import type { Env } from '../env';
import { apiUpstream, keyProxyCredential } from '../workspaces';
import { CliDriver } from './cli';
import { HookBridge } from './hook-bridge';
import { MockDriver, type MockDriverOptions } from './mock';
import { SdkDriver, type QueryFn, engineKeyDelivery } from './sdk';
import type { AgentDriver } from './types';

export interface DriverHandle {
  driver: AgentDriver;
  /** The host engine's key proxy (SDK driver with an API key or apiKeyHelper). */
  keyProxy?: { status(): HostKeyProxyStatus };
  close(): Promise<void>;
}

function hostKeyProxy(
  env: Env,
  credential: EngineCredential,
  onRefusal: ((refusal: ProxyRefusal) => void) | undefined,
): HostKeyProxy {
  if (credential.kind !== 'key') {
    throw new OrbitError('auth_required', 'orbitd has no API key for the SDK engine', {
      hint: 'Set ANTHROPIC_API_KEY or ORBIT_API_KEY_HELPER for orbitd, then retry.',
    });
  }
  return new HostKeyProxy({
    upstream: apiUpstream(env),
    key: credential.source,
    ...(onRefusal ? { onRefusal } : {}),
  });
}

/** Instantiate the driver chosen by the AuthResolver. */
export async function createDriver(
  resolution: AuthResolution,
  config: OrbitConfig,
  env: Env,
  deps: {
    queryFn?: QueryFn;
    mock?: MockDriverOptions;
    secrets?: { addSecret(value: string): void; removeSecret?(value: string): void };
    /** Where the key proxy gets the key (shared with the Docker sandbox's; default: from env). */
    credential?: EngineCredential;
    /** Told about requests the host key proxy refused (route and reason only). */
    onKeyProxyRefusal?: (refusal: ProxyRefusal) => void;
  } = {},
): Promise<DriverHandle> {
  switch (resolution.driver) {
    case 'mock':
      return { driver: new MockDriver(deps.mock), close: () => Promise.resolve() };
    case 'sdk': {
      // An API key or apiKeyHelper output stays in orbitd: host engines reach
      // the API through the loopback key proxy (ADR-018). Bedrock and Vertex
      // credentials cannot be proxied and still go to the engine.
      const proxy =
        engineKeyDelivery(resolution.authMethod) === 'proxied'
          ? hostKeyProxy(
              env,
              deps.credential ?? keyProxyCredential(env, config.sdk.apiKeyHelper),
              deps.onKeyProxyRefusal,
            )
          : null;
      return {
        driver: new SdkDriver({
          authMethod: resolution.authMethod,
          env,
          bare: config.sdk.bare,
          apiKeyHelper: config.sdk.apiKeyHelper,
          keyProxy: proxy,
          ...(deps.secrets ? { secrets: deps.secrets } : {}),
          ...(deps.queryFn ? { queryFn: deps.queryFn } : {}),
        }),
        ...(proxy ? { keyProxy: proxy } : {}),
        close: () => proxy?.close() ?? Promise.resolve(),
      };
    }
    case 'cli': {
      // Re-check at construction time: config may have changed since resolution.
      assertCliDriverAllowed(config);
      if (!resolution.cli?.path)
        throw new OrbitError('driver_unavailable', 'claude CLI path unknown');
      const bridge = await HookBridge.start();
      return {
        driver: new CliDriver({
          claudePath: resolution.cli.path,
          authMethod: resolution.authMethod,
          env,
          bridge,
          runDir: join(config.home, 'run'),
          ...(deps.secrets ? { secrets: deps.secrets } : {}),
        }),
        close: () => bridge.close(),
      };
    }
    case null:
      throw new OrbitError(
        resolution.refusal?.code ?? 'auth_required',
        resolution.refusal?.message ?? resolution.onboarding?.reason ?? 'No usable credentials',
        { hint: resolution.refusal?.hint ?? resolution.onboarding?.steps.join('\n') ?? '' },
      );
  }
}
