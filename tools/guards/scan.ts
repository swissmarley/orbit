import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Repository-wide security invariants (ADR-005, ADR-006). ESLint enforces the
 * same rules on TypeScript; this scanner also covers JSON, YAML, shell and
 * config files that ESLint never sees.
 */
export interface Rule {
  id: string;
  pattern: RegExp;
  message: string;
  /** Paths (repo-relative, POSIX) where the pattern is legitimately allowed. */
  allow: (path: string) => boolean;
}

export interface Violation {
  rule: string;
  path: string;
  line: number;
  text: string;
}

const isTest = (p: string): boolean =>
  /(^|\/)(test|__tests__)\//.test(p) || /\.test\.tsx?$/.test(p) || p.startsWith('tools/guards/');
const isDoc = (p: string): boolean => p.endsWith('.md');
const isFixture = (p: string): boolean => p.includes('/fixtures/');
const isLintConfig = (p: string): boolean => p === 'eslint.config.js';

/** The single module allowed to test for the OAuth env var's presence (never its value). */
export const OAUTH_PRESENCE_HELPER = 'packages/runtime/src/auth/oauth-presence.ts';

export const RULES: Rule[] = [
  {
    id: 'no-credential-file',
    pattern: /\.credentials\.json/,
    message: 'Claude OAuth credential files must never be referenced (ADR-005)',
    allow: (p) => isTest(p) || isDoc(p) || isLintConfig(p),
  },
  {
    id: 'no-keychain-entry',
    pattern: /Claude Code-credentials/,
    message: 'The Claude Code keychain entry must never be read (ADR-005)',
    allow: (p) => isTest(p) || isDoc(p) || isLintConfig(p),
  },
  {
    id: 'no-oauth-token-read',
    pattern: /process\.env(\.CLAUDE_CODE_OAUTH_TOKEN|\[\s*['"`]CLAUDE_CODE_OAUTH_TOKEN['"`]\s*\])/,
    message: 'CLAUDE_CODE_OAUTH_TOKEN must never be read (ADR-005)',
    allow: (p) => p === OAUTH_PRESENCE_HELPER || isDoc(p) || p.startsWith('tools/guards/'),
  },
  {
    // Orbit passes injected env objects around; reading the token through any of
    // them is as bad as process.env. Only the presence helper and the env deny
    // list may name it, and tests may inspect what a child received.
    id: 'no-oauth-token-property',
    pattern: /\.CLAUDE_CODE_OAUTH_TOKEN\b|[\w)\]]\s*\[\s*['"`]CLAUDE_CODE_OAUTH_TOKEN['"`]\s*\]/,
    message: 'CLAUDE_CODE_OAUTH_TOKEN must never be read from any env object (ADR-005)',
    allow: (p) => p === OAUTH_PRESENCE_HELPER || isTest(p) || isDoc(p) || isLintConfig(p),
  },
  {
    id: 'no-hardcoded-model-id',
    pattern: /claude-(opus|sonnet|haiku|fable|mythos)-\d/,
    message: 'Model IDs come from configuration, never source (ADR-006)',
    allow: (p) => isTest(p) || isDoc(p) || isFixture(p) || isLintConfig(p),
  },
];

const SCANNED_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|ya?ml|sh|toml|html|css)$/;
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  'storybook-static',
  'target',
  '.vite',
  'playwright-report',
  'test-results',
]);

export function listFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(root, full));
    else if (SCANNED_EXT.test(entry) && entry !== 'pnpm-lock.yaml') {
      out.push(relative(root, full).split(sep).join('/'));
    }
  }
  return out;
}

export function scanText(path: string, text: string, rules: Rule[] = RULES): Violation[] {
  const violations: Violation[] = [];
  const lines = text.split('\n');
  for (const rule of rules) {
    if (rule.allow(path)) continue;
    lines.forEach((line, i) => {
      if (rule.pattern.test(line)) {
        violations.push({ rule: rule.id, path, line: i + 1, text: line.trim() });
      }
    });
  }
  return violations;
}

export function scanRepo(root: string): Violation[] {
  return listFiles(root).flatMap((p) => scanText(p, readFileSync(join(root, p), 'utf8')));
}
