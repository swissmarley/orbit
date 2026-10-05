import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '@orbit/core';

/** Largest webhook body orbitd reads (before verification nothing else is read). */
export const MAX_WEBHOOK_BYTES = 256 * 1024;
/** Orbit-style signatures older or newer than this are refused. */
export const WEBHOOK_SKEW_SECONDS = 300;
/**
 * How long delivery keys are kept: Orbit style is bounded by the skew. GitHub
 * style has no timestamp: delivery ids are kept 30 days and body hashes
 * (`ghbody:`) for good, so a signed body is never accepted twice.
 */
export const WEBHOOK_KEEP_MS = { orbit: 86_400_000, github: 30 * 86_400_000 } as const;

/** Vault entry holding the signing key of a Bot's webhook trigger. */
export function webhookSecretName(botId: string, trigger: string): string {
  return `webhook_${sha256Hex(`${botId}:${trigger}`).slice(0, 32)}`;
}

/** `X-Orbit-Signature` for a body sent at `timestamp` (seconds): `sha256=<hex>`. */
export function signWebhook(
  secret: string,
  timestamp: number | string,
  body: string | Buffer,
): string {
  const mac = createHmac('sha256', secret);
  mac.update(`${String(timestamp)}.`);
  mac.update(body);
  return `sha256=${mac.digest('hex')}`;
}

/** GitHub's `X-Hub-Signature-256` for a body. */
export function signGithubWebhook(secret: string, body: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // Compare equal-length buffers only; the length itself is public (sha256= + 64 hex).
  return x.length === y.length && timingSafeEqual(x, y);
}

export type WebhookVerdict =
  { ok: true; deliveryKey: string; event: string | null } | { ok: false; reason: string };

/**
 * Verify a webhook delivery before anything is parsed or stored (ADR-014).
 * `headers` are lower-case. `seen` reports (and records) a delivery key, so
 * each signature or GitHub delivery id is accepted once.
 */
export function verifyWebhook(input: {
  style: 'orbit' | 'github';
  secret: string;
  headers: Readonly<Record<string, string | undefined>>;
  body: Buffer;
  nowMs: number;
  seen: (key: string) => boolean;
}): WebhookVerdict {
  const { headers, body, secret } = input;
  if (body.length > MAX_WEBHOOK_BYTES) return { ok: false, reason: 'body too large' };
  if (input.style === 'github') {
    const sig = headers['x-hub-signature-256'] ?? '';
    if (!/^sha256=[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'missing signature' };
    if (!safeEqual(sig, signGithubWebhook(secret, body)))
      return { ok: false, reason: 'bad signature' };
    const delivery = headers['x-github-delivery'] ?? '';
    if (!/^[A-Za-z0-9-]{8,80}$/.test(delivery)) return { ok: false, reason: 'missing delivery id' };
    // GitHub signs only the body: the delivery id and event name are not
    // covered, so a captured body re-sent under a fresh id must still be
    // refused — each signed body is accepted once (M7 safety review M3).
    const replayedId = input.seen(`gh:${delivery}`);
    const replayedBody = input.seen(`ghbody:${createHash('sha256').update(body).digest('hex')}`);
    if (replayedId || replayedBody) return { ok: false, reason: 'replayed' };
    const event = headers['x-github-event'] ?? null;
    return {
      ok: true,
      deliveryKey: `gh:${delivery}`,
      event: event && /^[a-z_]{1,60}$/.test(event) ? event : null,
    };
  }
  const ts = headers['x-orbit-timestamp'] ?? '';
  const sig = headers['x-orbit-signature'] ?? '';
  if (!/^\d{9,12}$/.test(ts)) return { ok: false, reason: 'missing timestamp' };
  if (!/^sha256=[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'missing signature' };
  if (!safeEqual(sig, signWebhook(secret, ts, body))) return { ok: false, reason: 'bad signature' };
  if (Math.abs(input.nowMs / 1000 - Number(ts)) > WEBHOOK_SKEW_SECONDS) {
    return { ok: false, reason: 'stale timestamp' };
  }
  if (input.seen(`orbit:${sig}`)) return { ok: false, reason: 'replayed' };
  return { ok: true, deliveryKey: `orbit:${sig}`, event: null };
}
