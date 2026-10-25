import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { OrbitError } from '@orbit/core';

export interface SetupConfigFile {
  text: string | null;
  value: Record<string, unknown>;
}

/** Setup edits only an ordinary config file, never a symlink or hard link. */
export function readSetupConfig(home: string): SetupConfigFile {
  let fd: number;
  try {
    fd = openSync(
      join(home, 'config.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, value: {} };
    throw new OrbitError('invalid_config', 'Orbit cannot safely read its setup configuration', {
      hint: 'Use a regular config.json file in the Orbit data folder, not a symbolic link.',
    });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) {
      throw new Error('not an ordinary config file');
    }
    const text = readFileSync(fd, 'utf8');
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error('not an object');
    return { text, value: value as Record<string, unknown> };
  } catch {
    throw new OrbitError('invalid_config', 'Orbit cannot edit this setup configuration', {
      hint: 'config.json must be a valid JSON object in a regular file with no hard links.',
    });
  } finally {
    closeSync(fd);
  }
}

/** Atomic, private replacement, preserving unrelated configuration fields. */
export function writeSetupConfig(
  home: string,
  before: SetupConfigFile,
  driver: string,
  model: string,
): void {
  if (readSetupConfig(home).text !== before.text) {
    throw new OrbitError(
      'conflict',
      'Orbit configuration changed while setup was open. Try again.',
    );
  }
  const priorModels = before.value.models;
  const models =
    typeof priorModels === 'object' && priorModels !== null && !Array.isArray(priorModels)
      ? (priorModels as Record<string, unknown>)
      : {};
  const text = `${JSON.stringify({ ...before.value, driver, models: { ...models, default: model } }, null, 2)}\n`;
  const tmp = join(home, `.config-${randomUUID()}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, join(home, 'config.json'));
  } finally {
    rmSync(tmp, { force: true });
  }
}
