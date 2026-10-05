import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The desktop shell's security posture (ADR-017) lives in its Tauri config
 * and capabilities; the Rust logic has its own unit tests (`cargo test` in
 * src-tauri). These checks keep the config from drifting.
 */
const TAURI = resolve(import.meta.dirname, '../src-tauri');
const read = (p: string) => readFileSync(join(TAURI, p), 'utf8');

interface TauriConf {
  identifier: string;
  version: string;
  build: { frontendDist: string; devUrl?: string };
  app: {
    withGlobalTauri?: boolean;
    windows: unknown[];
    security: {
      csp: string;
      capabilities?: string[];
      dangerousDisableAssetCspModification?: unknown;
    };
  };
}

const conf = JSON.parse(read('tauri.conf.json')) as TauriConf;
const capabilities = readdirSync(join(TAURI, 'capabilities')).map(
  (f) =>
    JSON.parse(read(join('capabilities', f))) as {
      identifier: string;
      remote?: unknown;
      local?: boolean;
      permissions: unknown[];
    },
);
const main = read('src/main.rs');
const sources = ['main.rs', 'signin.rs', 'navigation.rs', 'childenv.rs'].map((f) =>
  read(join('src', f)),
);

describe('desktop shell config (ADR-017)', () => {
  it('no capability reaches a remote page, and none grants any command', () => {
    expect(capabilities.map((c) => c.identifier)).toEqual(['shell-page']);
    expect(conf.app.security.capabilities).toEqual(['shell-page']);
    for (const c of capabilities) {
      expect(c.remote).toBeUndefined();
      expect(c.local).toBe(true);
      expect(c.permissions).toEqual([]);
    }
  });

  it('the bundled page has a strict CSP; no Tauri global; windows only from code', () => {
    const csp = conf.app.security.csp;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain('unsafe');
    expect(conf.app.security.dangerousDisableAssetCspModification).toBeUndefined();
    expect(conf.app.withGlobalTauri).toBe(false);
    // The main window is built in main.rs, where its navigation guard is attached.
    expect(conf.app.windows).toEqual([]);
    expect(main).toMatch(/\.on_navigation\(/);
    expect(main).toMatch(/\.on_new_window\(/);
    expect(conf.build.devUrl).toBeUndefined();
  });

  it('the shell never touches the API token or Claude credentials, and spawns orbit with a cleared env', () => {
    const all = sources.join('\n');
    expect(all).not.toMatch(/daemon\.token|credentials\.json|Claude Code-credentials/);
    expect(all).toMatch(/\.env_clear\(\)/);
    expect(all).toMatch(/"app", "--json", "--no-open"/);
    for (const name of [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
    ]) {
      expect(read('src/childenv.rs')).toContain(`"${name}"`);
    }
    expect(read('src/childenv.rs')).toMatch(/pub const ALWAYS_DENIED/);
  });

  it('matches the package version', () => {
    const cargo = read('Cargo.toml');
    expect(cargo).toContain(`version = "${conf.version}"`);
    const npm = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../packaging/npm/package.json'), 'utf8'),
    ) as { version: string };
    expect(conf.version).toBe(npm.version);
  });
});
