import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

interface PackageJson {
  name: string;
  private?: boolean;
  type?: string;
  license?: string;
  scripts?: Record<string, string>;
}

const workspaceDirs = ['packages', 'apps']
  .flatMap((group) =>
    existsSync(join(ROOT, group))
      ? readdirSync(join(ROOT, group)).map((d) => join(ROOT, group, d))
      : [],
  )
  .filter((dir) => existsSync(join(dir, 'package.json')));

describe('workspace conventions', () => {
  it('finds the expected packages', () => {
    const names = workspaceDirs.map(
      (d) => (JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')) as PackageJson).name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        '@orbit/core',
        '@orbit/runtime',
        '@orbit/sandbox',
        '@orbit/policy',
        '@orbit/memory',
        '@orbit/api',
        '@orbit/sdk-client',
        '@orbit/orbitd',
        '@orbit/tui',
      ]),
    );
  });

  it.each(workspaceDirs)('%s follows workspace conventions', (dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
    expect(pkg.name).toMatch(/^@orbit\//);
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.license).toBe('MIT');
    expect(pkg.scripts?.typecheck).toBeDefined();

    const tsconfig = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8')) as {
      extends?: string;
      compilerOptions?: { strict?: boolean };
    };
    expect(tsconfig.extends).toBe('../../tsconfig.base.json');
    // strict must never be switched off locally
    expect(tsconfig.compilerOptions?.strict).not.toBe(false);
  });
});
