# ADR-015: Hosted mode: TLS, OIDC sign-in and roles

Status: Accepted (M8)

## Context

Until M8 orbitd refused `ORBIT_MODE=hosted` and every non-loopback
`ORBIT_HOST` (ADR-010): its API is a bearer token over plain HTTP, and the
App signs in with a one-time ticket the local CLI mints (ADR-011). PLAN §7
deferred three things to M8: OIDC principals, TLS and a non-loopback bind,
and with them webhooks from other machines without a tunnel. A `docker
compose` setup (local mode, API-key engine) also needs orbitd to listen on
`0.0.0.0` inside its container.

Several people sharing one orbitd changes who acts: until now every API
call was "the owner", hardcoded in `OrbitService`.

## Decision

**Configuration.** `OrbitConfig.hosted` holds `publicUrl` (an `https://`
origin, nothing else), `tls: { certFile, keyFile } | null` and
`oidc: { issuer, clientId, scopes }` (scopes default `openid email
profile`, must include `openid`; the issuer is `https://`, or `http://` on
a loopback host only, which exists for local test issuers). Environment
overrides: `ORBIT_PUBLIC_URL`, `ORBIT_TLS_CERT` + `ORBIT_TLS_KEY` (both or
neither), `ORBIT_OIDC_ISSUER` + `ORBIT_OIDC_CLIENT_ID`. All are `ORBIT_*`,
so the CLI already hands them to the orbitd it starts and to no other child
(plugin manifests may not name `ORBIT_*`). The optional client secret
(PKCE public clients need none) is a credential, not configuration: the
vault entry `oidc_client_secret`, else `ORBIT_OIDC_CLIENT_SECRET`, read per
sign-in and registered with the redactor. In local mode the hosted section
is ignored and doctor says so.

`Principal` gains `role: 'owner' | 'operator' | 'viewer'` (default `owner`)
and an optional `oidc: { subject?, email? }` matcher. Principal ids, OIDC
subjects and OIDC emails are each unique. Local mode keeps its one owner.

**Startup rules** (`planListen`, each refusal with a hint):

| Mode   | Bind                 | Rule                                                                                                                      |
| ------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| local  | loopback             | as before                                                                                                                 |
| local  | `0.0.0.0` / `::`     | only with `ORBIT_CONTAINER=1` **and** a container marker (`/.dockerenv`, `/run/.containerenv`); any other address refused |
| hosted | any                  | needs `publicUrl` and OIDC; `ORBIT_DRIVER=cli` refused (the compliance guard refuses the CliDriver in hosted mode anyway) |
| hosted | non-loopback         | only with in-process TLS                                                                                                  |
| hosted | loopback without TLS | allowed: a TLS-terminating reverse proxy on the same machine                                                              |

A container bind publishes `http://127.0.0.1:<port>` (daemon.json,
`service.url`, sign-in links), keeps the loopback Host allowlist, and
doctor warns that the port must be published to the host's loopback only
(`127.0.0.1:7420:7420`). The CliDriver stays refused there
(`non_loopback_bind`). Hosted mode adds the public host to the Host
allowlist. With in-process TLS the published address is the public URL
(the name the certificate is for); behind a proxy it is the loopback port.

**TLS.** `node:https` through `@hono/node-server` (`createServer` +
`serverOptions`, TLS 1.2 at least). Hosted responses carry
`Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`: Orbit
does not own the rest of the domain). Tests make a throwaway self-signed
certificate with `openssl` at test time; no key is committed.

**OIDC sign-in** (`OidcSignIn`, `jose`): authorization code with PKCE
(S256) against one generic issuer. Two routes outside the client contract,
like `/hooks`:

- `GET /v1/auth/oidc/login`: discovery from
  `<issuer>/.well-known/openid-configuration` (cached an hour; the document
  must name exactly the configured issuer and its endpoints must pass the
  issuer rule; no redirects followed), then state, nonce and verifier (256
  random bits each) kept in memory for 10 minutes (at most 128, oldest
  dropped), a `__Secure-orbit_oidc_state` cookie (`HttpOnly; Secure;
SameSite=Lax`, `Path=/v1/auth/oidc/callback`, 10 minutes) and a 302 to
  the issuer. The cookie cannot use `__Host-`: that prefix forbids a path.
- `GET /v1/auth/oidc/callback`: the state must equal the cookie (constant
  time) and is consumed before anything else, so a replay or a callback
  from another browser fails; an issuer `error` is shown by its code only;
  the code is exchanged with the verifier (client secret by Basic, or POST
  when that is all the issuer lists); the ID token is verified by
  `jwtVerify` against `createRemoteJWKSet`: issuer, audience = client id,
  `sub`/`exp`/`iat` required, 30 s clock tolerance, asymmetric algorithms
  only (`none` and HS\* are refused, so a token MACed with the public key
  fails), then the nonce (constant time) and `azp` (required to be the
  client id when present or when there are several audiences).
- Mapping: by `sub` first; by `email` only when `email_verified === true`
  and only for principals that name no subject (once a subject is named it
  is the only way in). An unknown identity gets a 403 page that names no
  principal and echoes nothing from the token.
- On success the callback mints the existing one-time ticket **bound to
  the principal** and redirects to `/login#ticket=…`; the App's ticket →
  session flow (ADR-011) is reused unchanged. Sign-ins are audited
  (`session.signed_in`, principal and role).

The browser's return from the issuer is a cross-site top-level navigation;
the origin guard exempts exactly that (GET, the callback path,
`Sec-Fetch-Mode: navigate`) and nothing else.

**Sessions and cookies.** Tickets and sessions carry their principal;
`GET /v1/session` returns it (`id`, `name`, `role`). In hosted mode the
session cookie is `__Host-orbit_session; Secure; HttpOnly; SameSite=Strict;
Path=/` (the browser sees https even behind a proxy). The CSRF secret from
ADR-011 is still required. **The bearer token in `daemon.token` stays the
server operator's credential and acts as the principal `owner`** (role
owner); so in hosted mode no configured principal may have the id `owner`
(config validation refuses it, M8 safety review), and an audit record's
`owner` always means the bearer token; it can still mint tickets, which `orbit app` opens on the public
origin. `/v1/health` (public) says how browsers sign in (`signIn: ticket |
oidc`) and the public URL, so the App's sign-in screen offers "Sign in" and
its header names the signed-in principal with Sign out (hosted mode only;
locally there is one owner and Sign out stays in Settings and the palette).

**Origins.** In hosted mode orbitd's own origin is the public origin
(whatever Host a proxy forwards), plus `http(s)://` + a loopback Host for
the operator on the machine; `api.allowedOrigins` is unchanged.

**Roles.** Each contract route may name its least role; the default is
`viewer` for GET and `owner` otherwise (`routeRole`). `operator`: start,
stop and resume Runs, approve and deny, feedback. `owner`: everything else
— Bots, rules, secrets, plugins, webhook secrets, kill switch, memory
edits, taint clearing, Bot proposals, daemon stop — and the secret-ish reads
`GET /v1/secrets`, `/v1/audit` and `/v1/audit/export`. A guard registered
with each route checks the role before the body is read or the handler
runs (403 naming the needed role). OpenAPI shows it as `x-orbit-role`.

**Actors.** `OrbitService` records the request's principal as the actor of
audit records, approval decisions, feedback, rules, kill switch and plugin
actions: the auth middleware runs the request inside an
`AsyncLocalStorage` (`service.runAs`); outside requests (scheduler,
triggers, recovery) the actor stays `owner` or the background actor's own
name. Local mode still records `owner`.

**Webhooks.** In hosted mode `/hooks/<bot>/<trigger>` is reachable on the
public URL; trigger listings and the webhook secret answer carry `url`
(the public address). HMAC verification is unchanged.

## Deviations from the brief

- **Sign-in and sign-out are `viewer`, not `operator`:** creating a session
  has no principal yet (it is the ticket redemption), and every signed-in
  person must be able to sign out.
- **"Approve always" needs `owner`:** it writes a standing allow rule, and
  rules are owner actions; an operator approves once.
- **`GET /v1/audit` is `owner`** like the export: it is the same data.
- **Email matching only for principals without a subject**, so naming a
  subject cannot be bypassed through an email claim.

## Consequences

- One issuer, configured principals only, no group claims. A remote CLI
  against a hosted orbitd (personal access tokens or a device flow), group
  mapping and several issuers are deferred.
- Started sign-ins are bounded but not rate limited: a flood of
  `/v1/auth/oidc/login` requests can push out someone's pending sign-in
  (they try again). Sessions stay in memory (32 at most, a restart signs
  everyone out), as in ADR-011.
- With in-process TLS the CLI on the server reaches orbitd through the
  public URL, so that name must resolve there (or use a proxy setup).
- The CliDriver is never used in hosted mode or behind a container bind;
  both need an API key (or Bedrock/Vertex) and the SDK engine.
