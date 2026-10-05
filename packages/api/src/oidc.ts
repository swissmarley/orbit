import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Principal, isAllowedIssuer } from '@orbit/core';
import { type JWTPayload, createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import type { SessionPrincipal } from './contract';

/**
 * Browser sign-in for hosted mode (ADR-015): OpenID Connect authorization
 * code flow with PKCE against one generic issuer. `begin` remembers state,
 * nonce and PKCE verifier in memory and returns the issuer's authorization
 * URL; `finish` checks the state against the browser's state cookie (constant
 * time, once), exchanges the code, verifies the ID token (issuer, audience,
 * nonce, expiry, asymmetric signature from the issuer's JWKS) and maps it to
 * a configured principal. orbitd then signs the browser in with the same
 * one-time ticket the CLI uses (ADR-011).
 */

/** Signature algorithms an ID token may use: asymmetric only (never `none`, never HS*). */
export const ID_TOKEN_ALGS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
  'Ed25519',
] as const;

type Fetch = typeof fetch;

export interface OidcOptions {
  issuer: string;
  clientId: string;
  /** Confidential clients only; read per exchange (vault or env). Null = PKCE public client. */
  clientSecret: () => string | null;
  scopes: readonly string[];
  /** The callback URL registered with the issuer (`<publicUrl>/v1/auth/oidc/callback`). */
  redirectUri: string;
  /** Configured principals (read per sign-in). */
  principals: () => readonly Principal[];
  fetch?: Fetch;
  now?: () => Date;
  /** How long a started sign-in stays valid. Default 10 minutes. */
  pendingTtlMs?: number;
  /** Started sign-ins kept (oldest dropped first). Default 128. */
  maxPending?: number;
  /** How long discovery and the key set are cached. Default 1 hour. */
  discoveryTtlMs?: number;
}

/** A refused sign-in: the status and a message safe to show (never a principal list). */
export class OidcError extends Error {
  override name = 'OidcError';
  constructor(
    readonly status: 400 | 403 | 502,
    message: string,
  ) {
    super(message);
  }
}

interface Discovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  tokenAuthMethods: readonly string[] | null;
  jwks: ReturnType<typeof createRemoteJWKSet>;
  fetchedAt: number;
}

interface Pending {
  nonce: string;
  verifier: string;
  createdAt: number;
}

const random = () => randomBytes(32).toString('base64url');

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Only the IdP's error code (RFC 6749 charset), never its free text. */
function errorCode(value: unknown): string {
  return typeof value === 'string' && /^[\x20-\x21\x23-\x5B\x5D-\x7E]{1,64}$/.test(value)
    ? value
    : 'error';
}

export class OidcSignIn {
  readonly issuer: string;
  private readonly fetchFn: Fetch;
  private readonly now: () => Date;
  private readonly pendingTtlMs: number;
  private readonly maxPending: number;
  private readonly discoveryTtlMs: number;
  private readonly pending = new Map<string, Pending>();
  private discovery: Discovery | null = null;

  constructor(private readonly opts: OidcOptions) {
    if (!isAllowedIssuer(opts.issuer)) {
      throw new OidcError(400, 'The OIDC issuer must use https (http only on loopback)');
    }
    this.issuer = opts.issuer;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => new Date());
    this.pendingTtlMs = opts.pendingTtlMs ?? 10 * 60_000;
    this.maxPending = opts.maxPending ?? 128;
    this.discoveryTtlMs = opts.discoveryTtlMs ?? 3_600_000;
  }

  /** Seconds a state cookie should live (the pending sign-in's lifetime). */
  get stateMaxAgeSeconds(): number {
    return Math.floor(this.pendingTtlMs / 1000);
  }

  private async getJson(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        ...init,
        // A redirect could lead anywhere; the issuer's endpoints answer directly.
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { accept: 'application/json', ...init.headers },
      });
    } catch {
      throw new OidcError(502, 'Cannot reach the identity provider');
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok || typeof body !== 'object' || body === null || Array.isArray(body)) {
      const code =
        typeof body === 'object' && body !== null
          ? errorCode((body as { error?: unknown }).error)
          : 'error';
      throw new OidcError(502, `The identity provider refused the request (${code})`);
    }
    return body as Record<string, unknown>;
  }

  /** `<issuer>/.well-known/openid-configuration`, checked and cached. */
  private async discover(): Promise<Discovery> {
    const t = this.now().getTime();
    if (this.discovery && t - this.discovery.fetchedAt < this.discoveryTtlMs) return this.discovery;
    const doc = await this.getJson(
      `${this.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`,
    );
    const url = (key: string): string => {
      const v = doc[key];
      if (typeof v !== 'string' || !isAllowedIssuer(v)) {
        throw new OidcError(502, `The identity provider's ${key} is missing or not https`);
      }
      return v;
    };
    // OIDC Discovery §4.3: the document must name exactly the issuer we asked.
    if (doc.issuer !== this.issuer) {
      throw new OidcError(502, 'The identity provider names a different issuer');
    }
    const methods = doc.token_endpoint_auth_methods_supported;
    const fetchFn = this.fetchFn;
    this.discovery = {
      authorizationEndpoint: url('authorization_endpoint'),
      tokenEndpoint: url('token_endpoint'),
      tokenAuthMethods: Array.isArray(methods)
        ? methods.filter((m): m is string => typeof m === 'string')
        : null,
      jwks: createRemoteJWKSet(new URL(url('jwks_uri')), {
        [customFetch]: (input, init) => fetchFn(input, { ...init, redirect: 'error' }),
      }),
      fetchedAt: t,
    };
    return this.discovery;
  }

  private sweep(): void {
    const t = this.now().getTime();
    for (const [k, p] of this.pending) {
      if (t - p.createdAt > this.pendingTtlMs) this.pending.delete(k);
    }
  }

  /**
   * Start a sign-in: the issuer URL to redirect to and the state the browser
   * must bring back in its state cookie.
   */
  async begin(): Promise<{ location: string; state: string }> {
    const d = await this.discover();
    this.sweep();
    while (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    const state = random();
    const nonce = random();
    const verifier = random();
    this.pending.set(state, { nonce, verifier, createdAt: this.now().getTime() });
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const u = new URL(d.authorizationEndpoint);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: this.opts.clientId,
      redirect_uri: this.opts.redirectUri,
      scope: this.opts.scopes.join(' '),
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })) {
      u.searchParams.set(k, v);
    }
    return { location: u.toString(), state };
  }

  /**
   * Finish a sign-in from the callback's query and the browser's state
   * cookie. Each state works once, within its lifetime, in the browser that
   * started it.
   */
  async finish(
    query: Readonly<Record<string, string | undefined>>,
    cookieState: string | undefined,
  ): Promise<SessionPrincipal> {
    const state = query.state;
    const expired = () =>
      new OidcError(400, 'This sign-in expired or was started in another browser');
    if (!state || !cookieState || !sameSecret(state, cookieState)) throw expired();
    this.sweep();
    const pending = this.pending.get(state);
    // Single use: gone before anything else happens, whatever the outcome.
    this.pending.delete(state);
    if (!pending) throw expired();
    if (query.error !== undefined) {
      throw new OidcError(
        403,
        `The identity provider did not sign you in (${errorCode(query.error)})`,
      );
    }
    if (!query.code) throw new OidcError(400, 'The identity provider sent no authorization code');
    const d = await this.discover();
    const idToken = await this.exchange(d, query.code, pending.verifier);
    const claims = await this.verify(d, idToken, pending.nonce);
    return this.principalFor(claims);
  }

  private async exchange(d: Discovery, code: string, verifier: string): Promise<string> {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.opts.redirectUri,
      code_verifier: verifier,
    });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };
    const secret = this.opts.clientSecret();
    if (secret === null) {
      form.set('client_id', this.opts.clientId);
    } else {
      // RFC 6749 §2.3.1: Basic is the default; POST only when the issuer says it wants it.
      const methods = d.tokenAuthMethods ?? ['client_secret_basic'];
      if (methods.includes('client_secret_basic')) {
        const enc = (s: string) => encodeURIComponent(s);
        headers.authorization = `Basic ${Buffer.from(`${enc(this.opts.clientId)}:${enc(secret)}`).toString('base64')}`;
      } else if (methods.includes('client_secret_post')) {
        form.set('client_id', this.opts.clientId);
        form.set('client_secret', secret);
      } else {
        throw new OidcError(
          502,
          'The identity provider accepts no client secret method Orbit supports',
        );
      }
    }
    const body = await this.getJson(d.tokenEndpoint, {
      method: 'POST',
      headers,
      body: form.toString(),
    });
    if (typeof body.id_token !== 'string') {
      throw new OidcError(502, 'The identity provider returned no ID token');
    }
    return body.id_token;
  }

  private async verify(d: Discovery, idToken: string, nonce: string): Promise<JWTPayload> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, d.jwks, {
        issuer: this.issuer,
        audience: this.opts.clientId,
        algorithms: [...ID_TOKEN_ALGS],
        requiredClaims: ['sub', 'exp', 'iat'],
        currentDate: this.now(),
        clockTolerance: 30,
      }));
    } catch {
      // jose's reason (expired, bad signature, wrong audience) stays out of the page.
      throw new OidcError(403, 'The identity provider’s answer could not be verified');
    }
    const n = typeof payload.nonce === 'string' ? payload.nonce : '';
    if (!sameSecret(n, nonce)) {
      throw new OidcError(403, 'The identity provider’s answer could not be verified');
    }
    // OIDC Core §3.1.3.7: several audiences need an authorized party, and it must be us.
    const several = Array.isArray(payload.aud) && payload.aud.length > 1;
    if ((several || payload.azp !== undefined) && payload.azp !== this.opts.clientId) {
      throw new OidcError(403, 'The identity provider’s answer could not be verified');
    }
    return payload;
  }

  /**
   * A configured principal for these claims: by subject first; by email only
   * when the issuer verified it, and only for principals that name no
   * subject (a subject, once named, is the only way in).
   */
  private principalFor(claims: JWTPayload): SessionPrincipal {
    const principals = this.opts.principals();
    let match = principals.find(
      (p) => p.oidc?.subject !== undefined && p.oidc.subject === claims.sub,
    );
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
    if (!match && email !== null && claims.email_verified === true) {
      match = principals.find((p) => p.oidc?.subject === undefined && p.oidc?.email === email);
    }
    if (!match) throw new OidcError(403, 'This account has no access to this Orbit');
    return { id: match.id, name: match.name ?? match.id, role: match.role };
  }
}
