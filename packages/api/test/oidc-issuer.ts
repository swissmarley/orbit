import { createHash, randomBytes } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type JWK,
  type JWTPayload,
  SignJWT,
  exportJWK,
  exportSPKI,
  generateKeyPair,
} from 'jose';

/**
 * A minimal OpenID Connect issuer on loopback for tests (ADR-015): discovery,
 * JWKS and a token endpoint that checks the PKCE verifier, the redirect URI
 * and (when configured) the client secret. The "user" is the test: it takes
 * the authorization URL orbitd redirected to and calls `authorize` with the
 * identity to sign in as.
 */
export interface MockIssuer {
  issuer: string;
  clientId: string;
  /** Requests the token endpoint received (form fields and Authorization header). */
  tokenRequests: { form: Record<string, string>; authorization: string | null }[];
  /** Simulate the user signing in: returns the code for the callback. */
  authorize(location: string, claims?: Partial<JWTPayload>, opts?: { token?: string }): string;
  /** A correctly signed ID token (tests then tamper with it). */
  sign(claims: JWTPayload, header?: { alg?: string; kid?: string }): Promise<string>;
  /** The public key as PEM (for the HS256 key-confusion test). */
  publicPem(): Promise<string>;
  /** Override the discovery document (e.g. a different issuer). */
  discovery: Record<string, unknown>;
  close(): Promise<void>;
}

interface Grant {
  challenge: string;
  redirectUri: string;
  claims: JWTPayload;
  token?: string;
}

export async function mockIssuer(
  opts: { clientId?: string; clientSecret?: string | null; authMethods?: string[] } = {},
): Promise<MockIssuer> {
  const clientId = opts.clientId ?? 'orbit-test';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const grants = new Map<string, Grant>();
  const tokenRequests: MockIssuer['tokenRequests'] = [];
  let issuer = '';
  const discovery: Record<string, unknown> = {};

  const sign = (claims: JWTPayload, header: { alg?: string; kid?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: header.alg ?? 'RS256', kid: header.kid ?? 'k1' })
      .sign(privateKey);

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      return json(200, discovery);
    }
    if (req.method === 'GET' && url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (req.method === 'POST' && url.pathname === '/token') {
      let raw = '';
      req.on('data', (d: Buffer) => (raw += d.toString()));
      req.on('end', () => {
        const form = Object.fromEntries(new URLSearchParams(raw));
        const authorization = req.headers.authorization ?? null;
        tokenRequests.push({ form, authorization });
        if (opts.clientSecret) {
          const basic = `Basic ${Buffer.from(`${clientId}:${opts.clientSecret}`).toString('base64')}`;
          const ok =
            authorization === basic ||
            (form.client_id === clientId && form.client_secret === opts.clientSecret);
          if (!ok) return json(401, { error: 'invalid_client' });
        } else if (form.client_id !== clientId) {
          return json(401, { error: 'invalid_client' });
        }
        const grant = form.code ? grants.get(form.code) : undefined;
        if (form.code) grants.delete(form.code);
        const verifier = form.code_verifier ?? '';
        if (
          form.grant_type !== 'authorization_code' ||
          !grant ||
          grant.redirectUri !== form.redirect_uri ||
          createHash('sha256').update(verifier).digest('base64url') !== grant.challenge
        ) {
          return json(400, { error: 'invalid_grant' });
        }
        void (async () => {
          const idToken = grant.token ?? (await sign(grant.claims));
          json(200, { access_token: 'at', token_type: 'Bearer', id_token: idToken });
        })();
      });
      return undefined;
    }
    return json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(discovery, {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: ['RS256'],
    ...(opts.authMethods ? { token_endpoint_auth_methods_supported: opts.authMethods } : {}),
  });

  return {
    issuer,
    clientId,
    tokenRequests,
    discovery,
    sign,
    publicPem: () => exportSPKI(publicKey),
    authorize(location, claims = {}, o = {}) {
      const u = new URL(location);
      const p = (k: string) => u.searchParams.get(k) ?? '';
      const now = Math.floor(Date.now() / 1000);
      const code = randomBytes(16).toString('hex');
      grants.set(code, {
        challenge: p('code_challenge'),
        redirectUri: p('redirect_uri'),
        claims: {
          iss: issuer,
          aud: clientId,
          sub: 'sub-unknown',
          iat: now,
          exp: now + 300,
          nonce: p('nonce'),
          ...claims,
        },
        ...(o.token ? { token: o.token } : {}),
      });
      return code;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
