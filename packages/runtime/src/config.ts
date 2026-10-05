import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DriverKind, OrbitConfig, type OrbitConfigInput, OrbitError, OrbitMode } from '@orbit/core';
import type { Env } from './env';

export function defaultHome(env: Env): string {
  return resolve(env.ORBIT_HOME ?? join(homedir(), '.orbit'));
}

function intFromEnv(env: Env, name: string): number | undefined {
  const v = env[name]?.trim();
  if (v === undefined || v === '') return undefined;
  const n = /^-?\d+$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isInteger(n)) throw new OrbitError('invalid_config', `${name} must be an integer`);
  return n;
}

function boolFromEnv(env: Env, name: string): boolean | undefined {
  const v = env[name]?.trim().toLowerCase();
  if (v === undefined || v === '') return undefined;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new OrbitError('invalid_config', `${name} must be a boolean`);
}

/**
 * Resolve configuration: defaults ← $ORBIT_HOME/config.json ← environment.
 * Only Orbit's own variables are read here; credentials are never part of
 * the config object.
 */
export function loadConfig(
  env: Env = process.env,
  overrides: Partial<OrbitConfigInput> = {},
): OrbitConfig {
  const home = overrides.home ?? defaultHome(env);
  const file = join(home, 'config.json');
  let fromFile: Partial<OrbitConfigInput> = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8')) as Partial<OrbitConfigInput>;
    } catch (err) {
      throw new OrbitError('invalid_config', `Cannot parse ${file}`, { cause: err });
    }
  }

  const driverEnv = env.ORBIT_DRIVER?.trim();
  const modeEnv = env.ORBIT_MODE?.trim();
  const merged: OrbitConfigInput = {
    ...fromFile,
    ...overrides,
    home,
    api: {
      ...fromFile.api,
      ...(env.ORBIT_HOST ? { host: env.ORBIT_HOST } : {}),
      ...(intFromEnv(env, 'ORBIT_PORT') !== undefined
        ? { port: intFromEnv(env, 'ORBIT_PORT') }
        : {}),
      ...(env.ORBIT_ALLOWED_ORIGINS !== undefined
        ? {
            allowedOrigins: env.ORBIT_ALLOWED_ORIGINS.split(',')
              .map((o) => o.trim())
              .filter(Boolean),
          }
        : {}),
      ...overrides.api,
    },
    models: {
      ...fromFile.models,
      ...(env.ORBIT_DEFAULT_MODEL ? { default: env.ORBIT_DEFAULT_MODEL } : {}),
      ...(env.ORBIT_TRIAGE_MODEL ? { triage: env.ORBIT_TRIAGE_MODEL } : {}),
      ...overrides.models,
    },
    sdk: {
      ...fromFile.sdk,
      ...(boolFromEnv(env, 'ORBIT_SDK_BARE') !== undefined
        ? { bare: boolFromEnv(env, 'ORBIT_SDK_BARE') }
        : {}),
      ...(env.ORBIT_API_KEY_HELPER ? { apiKeyHelper: env.ORBIT_API_KEY_HELPER } : {}),
      ...overrides.sdk,
    },
  };
  if (driverEnv) {
    const parsed = DriverKind.safeParse(driverEnv);
    if (!parsed.success) {
      throw new OrbitError(
        'invalid_config',
        `ORBIT_DRIVER must be one of sdk, cli, mock (got "${driverEnv}")`,
      );
    }
    merged.driver = parsed.data;
  }
  if (modeEnv) {
    const parsed = OrbitMode.safeParse(modeEnv);
    if (!parsed.success) {
      throw new OrbitError(
        'invalid_config',
        `ORBIT_MODE must be local or hosted (got "${modeEnv}")`,
      );
    }
    merged.mode = parsed.data;
  }
  if (env.ORBIT_CLAUDE_PATH) merged.claudePath = env.ORBIT_CLAUDE_PATH;
  const triageCalls = intFromEnv(env, 'ORBIT_TRIAGE_MAX_CALLS_PER_DAY');
  if (triageCalls !== undefined) merged.triage = { ...merged.triage, maxCallsPerDay: triageCalls };
  const max = intFromEnv(env, 'ORBIT_MAX_CONCURRENT_RUNS');
  if (max !== undefined) {
    merged.limits = {
      ...merged.limits,
      maxConcurrentRuns: { ...merged.limits?.maxConcurrentRuns, cli: max, sdk: max, mock: max },
    };
  }

  const result = OrbitConfig.safeParse(merged);
  if (!result.success) {
    throw new OrbitError('invalid_config', `Invalid configuration: ${result.error.message}`);
  }
  return result.data;
}
