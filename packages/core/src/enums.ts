import { z } from 'zod';

/** Which AgentDriver executes Runs. */
export const DriverKind = z.enum(['sdk', 'cli', 'mock']);
export type DriverKind = z.infer<typeof DriverKind>;

/**
 * How the active driver authenticates. Displayed prominently in every client.
 * - api_key / api_key_helper / bedrock / vertex: SdkDriver, pay-as-you-go
 * - subscription: CliDriver through the user's own `claude login`
 * - claude_cli_other: CliDriver whose CLI login is not a subscription (e.g. a Console key)
 * - mock: recorded fixtures, no credentials
 */
export const AuthMethod = z.enum([
  'api_key',
  'api_key_helper',
  'bedrock',
  'vertex',
  'subscription',
  'claude_cli_other',
  'mock',
  'none',
]);
export type AuthMethod = z.infer<typeof AuthMethod>;

export const OrbitMode = z.enum(['local', 'hosted']);
export type OrbitMode = z.infer<typeof OrbitMode>;

export const RunStatus = z.enum([
  'queued',
  'running',
  'waiting_approval',
  /** Parked until the peer Bots it delegated to finish. */
  'delegating',
  'rate_limited',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

/**
 * Risk tiers (default-deny):
 * READ auto · WRITE_LOCAL auto inside the sandbox · EXTERNAL needs approval ·
 * FINANCIAL is always handed back to the human (the Bot may only prepare it).
 */
export const Tier = z.enum(['READ', 'WRITE_LOCAL', 'EXTERNAL', 'FINANCIAL']);
export type Tier = z.infer<typeof Tier>;
