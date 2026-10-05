/**
 * Secret redaction applied to every event, log line and audit record before
 * it is persisted or displayed. Pattern-based detection plus exact matching
 * of registered secret values (vault entries, per-run tokens).
 */

interface Pattern {
  kind: string;
  re: RegExp;
  /** Number of leading capture groups to keep (e.g. "Bearer ", "api_key="). */
  keepGroups?: number;
  /** Capture group re-appended after the marker (e.g. the "@" of a URL). */
  suffixGroup?: number;
}

const PATTERNS: Pattern[] = [
  {
    kind: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{8,}/g },
  { kind: 'api-key', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { kind: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'bedrock-token', re: /\bABSK[A-Za-z0-9+/=]{20,}/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  {
    kind: 'url-credentials',
    re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi,
    keepGroups: 1,
    suffixGroup: 2,
  },
  { kind: 'netrc', re: /(\bpassword\s+)(?![:=])(\S{4,})/gi, keepGroups: 1 },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: 'bearer', re: /(\bBearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, keepGroups: 1 },
  {
    kind: 'assignment',
    // No leading \b: names like AWS_SECRET_ACCESS_KEY or ORBIT_HOOK_TOKEN end in a match.
    re: /((?:api[_-]?key|secret(?:[_-]?access[_-]?key)?|secret[_-]?key|client[_-]?secret|password|passwd|access[_-]?token|auth[_-]?token|refresh[_-]?token|session[_-]?token|token)["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi,
    keepGroups: 1,
  },
];

const SENSITIVE_KEY =
  /^(?:api[_-]?key|secret|client[_-]?secret|password|passwd|token|access[_-]?token|auth[_-]?token|refresh[_-]?token|authorization|cookie|private[_-]?key)$/i;

/** Secrets this long are redacted wherever they appear. */
const MIN_SECRET_LENGTH = 6;
/**
 * Shorter secrets (a PIN, a 4-character password) are redacted where they
 * stand as a token of their own (M2 review L10): matching them inside words
 * would mangle ordinary text. The vault refuses anything shorter.
 */
export const MIN_SHORT_SECRET_LENGTH = 4;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactionMarker(kind: string): string {
  return `[REDACTED:${kind}]`;
}

export class Redactor {
  private readonly secrets = new Set<string>();
  private readonly shortSecrets = new Set<string>();

  constructor(secrets: Iterable<string> = []) {
    for (const s of secrets) this.addSecret(s);
  }

  /** Register an exact secret value (vault entry, per-run token, API key). */
  addSecret(value: string | undefined | null): void {
    if (!value) return;
    // Consumers trim what they read (a token file's newline): hide the bare value too.
    const trimmed = value.trim();
    if (trimmed !== value) this.addSecret(trimmed);
    if (value.length >= MIN_SECRET_LENGTH) this.secrets.add(value);
    else if (value.length >= MIN_SHORT_SECRET_LENGTH && trimmed === value) {
      this.shortSecrets.add(value);
    }
  }

  redactString(input: string): string {
    let out = input;
    // Exact secrets first, longest first so overlapping values redact fully.
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      out = out.replace(new RegExp(escapeRegExp(secret), 'g'), redactionMarker('secret'));
    }
    for (const secret of [...this.shortSecrets].sort((a, b) => b.length - a.length)) {
      out = out.replace(
        new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(secret)}(?![\\p{L}\\p{N}_])`, 'gu'),
        redactionMarker('secret'),
      );
    }
    for (const p of PATTERNS) {
      out = out.replace(p.re, (...args: unknown[]) => {
        const kept = p.keepGroups
          ? (args.slice(1, 1 + p.keepGroups) as (string | undefined)[]).join('')
          : '';
        const suffix = p.suffixGroup ? ((args[p.suffixGroup] as string | undefined) ?? '') : '';
        return `${kept}${redactionMarker(p.kind)}${suffix}`;
      });
    }
    return out;
  }

  /** Deep-redact any JSON-like value. Values under sensitive keys are always redacted. */
  redact<T>(value: T): T {
    return this.walk(value, undefined, new WeakSet()) as T;
  }

  private walk(value: unknown, key: string | undefined, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') {
      if (key !== undefined && SENSITIVE_KEY.test(key) && value.length > 0) {
        return redactionMarker('field');
      }
      return this.redactString(value);
    }
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => this.walk(v, undefined, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = this.walk(v, k, seen);
    return out;
  }
}

/** Shared default instance with pattern-based detection only. */
export const defaultRedactor = new Redactor();
