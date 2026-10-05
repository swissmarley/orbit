import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const PRAGMA = '/** @jsxRuntime automatic @jsxImportSource react */';

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return entry.endsWith('.tsx') ? [full] : [];
  });
}

export function missingPragma(files: { path: string; text: string }[]): string[] {
  return files.filter((f) => !f.text.startsWith(PRAGMA)).map((f) => f.path);
}

/**
 * tsx run from the repo root ignores a package's tsconfig `jsx` setting, so
 * every .tsx file names its JSX runtime itself (CLAUDE.md).
 */
describe('.tsx pragma', () => {
  it('every .tsx file in apps/ starts with the JSX runtime pragma', () => {
    const files = tsxFiles(join(ROOT, 'apps')).map((p) => ({
      path: relative(ROOT, p),
      text: readFileSync(p, 'utf8'),
    }));
    expect(files.length).toBeGreaterThan(10);
    expect(missingPragma(files)).toEqual([]);
  });

  it('positive control: a file without it is reported', () => {
    expect(missingPragma([{ path: 'x.tsx', text: "import React from 'react';" }])).toEqual([
      'x.tsx',
    ]);
  });
});
