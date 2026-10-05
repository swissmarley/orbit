import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/** Entries the App (browser) may import: they must never reach a Node built-in. */
export const BROWSER_ENTRIES = ['@orbit/core/browser', '@orbit/sdk-client/browser'];

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** `@orbit/x/sub` → the source file its package.json `exports` names. */
function resolveWorkspace(spec: string): string | null {
  const m = /^@orbit\/([^/]+)(?:\/(.+))?$/.exec(spec);
  if (!m) return null;
  for (const dir of ['packages', 'apps']) {
    const pkgDir = join(ROOT, dir, m[1] === 'tui' ? 'orbit-tui' : (m[1] ?? ''));
    const pkgFile = join(pkgDir, 'package.json');
    if (!existsSync(pkgFile)) continue;
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { exports?: Record<string, string> };
    const target = pkg.exports?.[m[2] ? `./${m[2]}` : '.'];
    if (target) return join(pkgDir, target);
  }
  return null;
}

function resolveRelative(from: string, spec: string): string {
  const base = resolve(dirname(from), spec);
  const file = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(
    (c) => existsSync(c) && statSync(c).isFile(),
  );
  if (!file) throw new Error(`cannot resolve ${spec} from ${from}`);
  return file;
}

/** Value imports and re-exports (type-only ones are erased and do not count). */
export function specifiers(text: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\s+(type\s+)?(?:[\s\S]*?\s+from\s+)?'([^']+)'/g;
  for (const m of text.matchAll(re)) if (!m[1]) out.push(m[2] ?? '');
  for (const m of text.matchAll(/import\(\s*'([^']+)'\s*\)/g)) out.push(m[1] ?? '');
  return out;
}

/** Every Node built-in reachable from `entry`, with the file that imports it. */
export function nodeImportsReachable(
  entry: string,
  read: (file: string) => string = (f) => readFileSync(f, 'utf8'),
): string[] {
  const start = resolveWorkspace(entry) ?? entry;
  const seen = new Set<string>();
  const found: string[] = [];
  const stack = [start];
  while (stack.length > 0) {
    const file = stack.pop();
    if (file === undefined) break;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiers(read(file))) {
      if (BUILTINS.has(spec)) found.push(`${relative(ROOT, file)} → ${spec}`);
      else if (spec.startsWith('.')) stack.push(resolveRelative(file, spec));
      else {
        const ws = resolveWorkspace(spec);
        if (ws) stack.push(ws);
      }
    }
  }
  return found;
}

describe('browser-safe entries', () => {
  for (const entry of BROWSER_ENTRIES) {
    it(`${entry} never reaches a Node built-in`, () => {
      expect(nodeImportsReachable(entry)).toEqual([]);
    });
  }

  it('positive control: the full entries do reach Node built-ins', () => {
    expect(nodeImportsReachable('@orbit/core').join('\n')).toMatch(/hash\.ts → node:crypto/);
    expect(nodeImportsReachable('@orbit/sdk-client').join('\n')).toMatch(/local\.ts → node:fs/);
  });

  it('type-only imports do not count, value imports and re-exports do', () => {
    expect(
      specifiers(
        [
          "import type { X } from 'node:fs';",
          "import { y } from 'node:path';",
          "export * from './a';",
          "export type { Z } from 'node:os';",
        ].join('\n'),
      ),
    ).toEqual(['node:path', './a']);
  });
});
