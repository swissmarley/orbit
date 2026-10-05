import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { orbitLayout } from '../layout';

/** The MockDriver's recordings (`fixtures/claude-<version>/`, dev tree or package). */
export const FIXTURES_DIR = orbitLayout().fixturesDir;

/** Newest engine-version directory, e.g. `claude-2.1.289`. */
function latestVersionDir(root: string): string | null {
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('claude-'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return dirs.at(-1) ?? null;
}

export function listFixtures(root = FIXTURES_DIR): string[] {
  const dir = latestVersionDir(root);
  if (!dir) return [];
  return readdirSync(join(root, dir))
    .filter(
      (f) => f.endsWith('.jsonl') && !f.startsWith('hook-input') && !f.endsWith('-resumed.jsonl'),
    )
    .map((f) => f.replace(/\.jsonl$/, ''))
    .sort();
}

export function loadFixture(name: string, root = FIXTURES_DIR): unknown[] | null {
  if (!/^[\w-]+$/.test(name)) return null;
  const dir = latestVersionDir(root);
  if (!dir) return null;
  const file = join(root, dir, `${name}.jsonl`);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}
