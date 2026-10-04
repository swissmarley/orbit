import { type OrbitConfig, OrbitError } from '@orbit/core';
import type { AuthResolution } from '../auth/resolver';
import { assertCliDriverAllowed } from '../auth/guard';
import type { Env } from '../env';
import { CliDriver } from './cli';
import { HookBridge } from './hook-bridge';
import { MockDriver, type MockDriverOptions } from './mock';
import { SdkDriver, type QueryFn } from './sdk';
import type { AgentDriver } from './types';

export interface DriverHandle {
  driver: AgentDriver;
  close(): Promise<void>;
}

/** Instantiate the driver chosen by the AuthResolver. */
export async function createDriver(
  resolution: AuthResolution,
  config: OrbitConfig,
  env: Env,
  deps: { queryFn?: QueryFn; mock?: MockDriverOptions } = {},
): Promise<DriverHandle> {
  switch (resolution.driver) {
    case 'mock':
      return { driver: new MockDriver(deps.mock), close: () => Promise.resolve() };
    case 'sdk':
      return {
        driver: new SdkDriver({
          authMethod: resolution.authMethod,
          env,
          bare: config.sdk.bare,
          apiKeyHelper: config.sdk.apiKeyHelper,
          ...(deps.queryFn ? { queryFn: deps.queryFn } : {}),
        }),
        close: () => Promise.resolve(),
      };
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
