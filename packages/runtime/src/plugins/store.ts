import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { OrbitError, SRI_SHA512 } from '@orbit/core';
import type { Env } from '../env';

/**
 * The plugin store (ADR-019): packages installed from the catalog or npm,
 * each at `<store>/<id>@<version>/package` with Orbit's record of the
 * install next to it. Tarballs are checked against their SRI before a byte is
 * read, and unpacked by a strict extractor: regular files and directories
 * only, inside one fresh folder, within size and count limits. Nothing in a
 * package ever runs during an install.
 */

/** The record Orbit keeps beside an installed package (never inside it). */
export const INSTALL_RECORD = 'install.json';
/** The folder inside `<id>@<version>` that holds the package itself. */
export const PACKAGE_DIR = 'package';

export interface InstallRecord {
  id: string;
  package: string;
  version: string;
  integrity: string;
  manifestHash: string;
  installedAt: string;
}

/** The platform's data folder for installed plugins (outside `$ORBIT_HOME`). */
export function defaultStoreDir(env: Env, platform: NodeJS.Platform = process.platform): string {
  const home = env.HOME ?? homedir();
  if (platform === 'darwin')
    return join(home, 'Library', 'Application Support', 'Orbit', 'plugins');
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Orbit', 'plugins');
  }
  const data = env.XDG_DATA_HOME?.startsWith('/')
    ? env.XDG_DATA_HOME
    : join(home, '.local', 'share');
  return join(data, 'orbit', 'plugins');
}

/** Orbit's record for the package in `pluginDir` (`…/<id>@<version>/package`), if any. */
export function readInstallRecord(pluginDir: string): InstallRecord | null {
  try {
    const v = JSON.parse(readFileSync(join(dirname(pluginDir), INSTALL_RECORD), 'utf8')) as unknown;
    if (typeof v !== 'object' || v === null) return null;
    const r = v as Record<string, unknown>;
    const str = (k: string) => (typeof r[k] === 'string' ? r[k] : '');
    return {
      id: str('id'),
      package: str('package'),
      version: str('version'),
      integrity: str('integrity'),
      manifestHash: str('manifestHash'),
      installedAt: str('installedAt'),
    };
  } catch {
    return null;
  }
}

export function writeInstallRecord(installDir: string, record: InstallRecord): void {
  writeFileSync(join(installDir, INSTALL_RECORD), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o644,
    flag: 'wx',
  });
}

// ── integrity ────────────────────────────────────────────────────────────────

/** The SRI string (`sha512-<base64>`) of `bytes`. */
export function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/** Throws unless `bytes` match `expected` (one sha512 SRI token). */
export function verifyIntegrity(bytes: Uint8Array, expected: string): void {
  if (!SRI_SHA512.test(expected)) {
    throw new OrbitError('invalid_input', 'The integrity must be one sha512-… SRI value');
  }
  const want = Buffer.from(expected.slice('sha512-'.length), 'base64');
  const got = createHash('sha512').update(bytes).digest();
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    throw new OrbitError(
      'invalid_input',
      `The package does not match its integrity: expected ${expected}, got ${sha512Integrity(bytes)}`,
      { hint: 'Nothing was installed. Check the version and integrity you were given.' },
    );
  }
}

// ── the strict tar extractor ─────────────────────────────────────────────────

export interface ExtractLimits {
  /** Longest gzip input. */
  maxCompressedBytes: number;
  /** Longest tar stream after gunzip (headers included). */
  maxTarBytes: number;
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxPathLength: number;
  maxDepth: number;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxCompressedBytes: 32 * 1024 * 1024,
  maxTarBytes: 160 * 1024 * 1024,
  maxEntries: 10_000,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxPathLength: 512,
  maxDepth: 32,
};

export interface TarEntry {
  /** Relative path inside the package (its top folder removed), POSIX separators. */
  path: string;
  type: 'file' | 'dir';
  data: Buffer;
}

const BLOCK = 512;

function refuse(why: string): never {
  throw new OrbitError('invalid_input', `The package was refused: ${why}`, {
    hint: 'Nothing was installed. Packages may only hold regular files and folders.',
  });
}

/** A NUL-terminated header field as text. */
function field(h: Buffer, start: number, length: number): string {
  const raw = h.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

/** An octal number field (base-256 sizes are refused: no package needs them). */
function octal(h: Buffer, start: number, length: number, what: string): number {
  const first = h[start] ?? 0;
  if (first & 0x80) refuse(`${what} uses a binary number`);
  const text = field(h, start, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) refuse(`${what} is not an octal number`);
  return parseInt(text, 8);
}

function checksumOk(h: Buffer): boolean {
  const stored = octal(h, 148, 8, 'a header checksum');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0);
  return sum === stored;
}

/** Pax extended header records (`<len> <key>=<value>\n`). */
function paxRecords(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) refuse('a malformed pax header');
    const len = Number(data.subarray(i, space).toString('ascii'));
    if (!Number.isInteger(len) || len <= 0 || i + len > data.length) {
      refuse('a malformed pax header');
    }
    const record = data.subarray(space + 1, i + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq <= 0) refuse('a malformed pax header');
    out.set(record.slice(0, eq), record.slice(eq + 1));
    i += len;
  }
  return out;
}

/** A safe relative path, or a refusal: no absolute paths, `..`, backslashes or control characters. */
function safePath(raw: string, limits: ExtractLimits): string[] {
  if (raw.length === 0 || raw.length > limits.maxPathLength) refuse('a path is empty or too long');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\]/.test(raw))
    refuse(`the path ${JSON.stringify(raw)} has control characters or backslashes`);
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) refuse(`the absolute path ${raw}`);
  const parts = raw.replace(/\/+$/, '').split('/');
  const cleaned = parts[0] === '.' ? parts.slice(1) : parts;
  if (cleaned.some((p) => p === '..' || p === '.' || p === ''))
    refuse(`the path ${raw} leaves its folder`);
  if (cleaned.length > limits.maxDepth) refuse(`the path ${raw} is nested too deep`);
  return cleaned;
}

/**
 * Read a gzip'd tar into entries, validating all of it before anything is
 * written: ustar headers with good checksums, regular files and directories
 * only (pax headers may only rename the next entry), one top-level folder,
 * no duplicates, and the limits.
 */
export function readTarball(
  gz: Buffer,
  limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
): TarEntry[] {
  if (gz.length > limits.maxCompressedBytes) refuse('it is too large');
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: limits.maxTarBytes });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    refuse(
      code === 'ERR_BUFFER_TOO_LARGE' ? 'it unpacks to too much data' : 'it is not a gzip file',
    );
  }
  const raw: { parts: string[]; type: 'file' | 'dir'; data: Buffer }[] = [];
  let total = 0;
  let pending: Map<string, string> | null = null;
  let off = 0;
  let ended = false;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    off += BLOCK;
    if (h.every((b) => b === 0)) {
      ended = true;
      break;
    }
    if (!field(h, 257, 6).startsWith('ustar')) refuse('it is not a ustar archive');
    if (!checksumOk(h)) refuse('a header checksum does not match');
    const size = octal(h, 124, 12, 'an entry size');
    const type = String.fromCharCode(h[156] ?? 0);
    if (size > limits.maxFileBytes) refuse('a file is too large');
    if (off + size > tar.length) refuse('it is truncated');
    const data = tar.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'g') continue; // global pax header: nothing in it applies to a path
    if (type === 'x') {
      pending = paxRecords(data);
      for (const k of pending.keys()) {
        if (k === 'linkpath' || k === 'size') refuse(`a pax header sets ${k}`);
      }
      continue;
    }
    const prefix = field(h, 345, 155);
    const name = field(h, 0, 100);
    const path = pending?.get('path') ?? (prefix ? `${prefix}/${name}` : name);
    pending = null;
    let kind: 'file' | 'dir';
    if (type === '0' || type === '\0') kind = 'file';
    else if (type === '5') kind = 'dir';
    else {
      const what: Record<string, string> = {
        '1': 'a hard link',
        '2': 'a symbolic link',
        '3': 'a character device',
        '4': 'a block device',
        '6': 'a FIFO',
      };
      refuse(`${path} is ${what[type] ?? `an entry of type ${JSON.stringify(type)}`}`);
    }
    if (raw.length >= limits.maxEntries) refuse('it has too many entries');
    total += size;
    if (total > limits.maxTotalBytes) refuse('it unpacks to too much data');
    raw.push({ parts: safePath(path, limits), type: kind, data });
  }
  if (!ended) refuse('it is truncated (no end-of-archive marker)');
  if (raw.length === 0) refuse('it is empty');
  const top = raw[0]?.parts[0];
  if (raw.some((e) => e.parts[0] !== top))
    refuse('its entries are not all in one top-level folder');
  const out: TarEntry[] = [];
  const kinds = new Map<string, 'file' | 'dir'>();
  for (const e of raw) {
    const rel = e.parts.slice(1);
    if (rel.length === 0) {
      if (e.type !== 'dir') refuse('its top-level entry is not a folder');
      continue;
    }
    const path = rel.join('/');
    if (kinds.has(path)) refuse(`${path} appears twice`);
    for (let i = 1; i < rel.length; i++) {
      const parent = rel.slice(0, i).join('/');
      if (kinds.get(parent) === 'file') refuse(`${path} lies inside the file ${parent}`);
      kinds.set(parent, 'dir');
    }
    kinds.set(path, e.type);
    out.push({ path, type: e.type, data: e.data });
  }
  return out;
}

/**
 * Write validated entries under `dest`, which must not exist yet: folders
 * 0755, files 0644 (never executable), created exclusively. No link is ever
 * created, so nothing can point a later write outside `dest`.
 */
export function writeEntries(
  entries: readonly TarEntry[],
  dest: string,
): { files: number; bytes: number } {
  mkdirSync(dest, { mode: 0o755 });
  chmodSync(dest, 0o755);
  let files = 0;
  let bytes = 0;
  const made = new Set<string>(['']);
  const ensureDir = (rel: string) => {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/');
      if (made.has(sub)) continue;
      const abs = join(dest, ...sub.split('/'));
      mkdirSync(abs, { mode: 0o755 });
      chmodSync(abs, 0o755);
      made.add(sub);
    }
  };
  for (const e of entries) {
    if (e.type === 'dir') {
      ensureDir(e.path);
      continue;
    }
    const parent = posix.dirname(e.path);
    if (parent !== '.') ensureDir(parent);
    const abs = join(dest, ...e.path.split('/'));
    writeFileSync(abs, e.data, { mode: 0o644, flag: 'wx' });
    chmodSync(abs, 0o644);
    files += 1;
    bytes += e.data.length;
  }
  return { files, bytes };
}
