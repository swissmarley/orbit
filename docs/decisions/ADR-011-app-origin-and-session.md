# ADR-011: The App is served by orbitd and signs in with a one-time ticket

Status: Accepted (M5)

## Context

The App (`apps/orbit-app`) is a browser client. Until M5 the API refused every
request carrying an `Origin` header (ADR-010), and authentication was a bearer
token in `$ORBIT_HOME/daemon.token` (0600). A page cannot read that file, and
the token must not end up in a URL, browser history, `localStorage` or any
script-readable place: an XSS in model-written content shown by the App would
otherwise be a full API compromise.

Options considered:

1. **orbitd serves the App on its own origin; the CLI hands the browser a
   one-time ticket that becomes an HttpOnly session cookie.** Same origin, no
   CORS for the normal case, nothing secret readable by scripts.
2. **The App asks the user to paste the bearer token** (Jupyter-style).
   Simple, but the token lives in `localStorage`, readable by any script.
3. **Tauri injects the token** into the webview. Only works for the desktop
   build (M8) and still exposes the token to page scripts.
4. **A separate static server plus CORS** with the bearer token. Same token
   exposure as 2, and two origins to secure.

## Decision

**Option 1.**

- orbitd serves the built App (`apps/orbit-app/dist`, or `ORBIT_APP_DIR`) at
  `/` on the API's own origin (`http://127.0.0.1:<port>`). Static paths are
  public; every `/v1` route still needs authentication. Client routes fall
  back to `index.html`; files outside the App directory are never served. If
  the App is not built, `/` explains how to build it (the CLI and TUI do not
  need it).
- The page is sent with a strict CSP (`default-src 'self'`, `script-src
'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, `object-src
'none'`, `base-uri 'none'`; `style-src` allows inline style attributes for
  Radix positioning), `X-Frame-Options: DENY`, `nosniff` and
  `Referrer-Policy: no-referrer`.
- **Sign-in:** `orbit app` (bearer token) calls `POST /v1/session/tickets` and
  opens `<origin>/login#ticket=<ticket>`. The link never goes on a command
  line (other local users can read argv): the CLI writes a 0600
  `$ORBIT_HOME/app-sign-in.html` that redirects to it and hands the browser
  launcher that file (environment from the allowlist plus display variables). The ticket is 256 random bits,
  single-use, valid for 2 minutes, at most 16 outstanding, and sits in the URL
  **fragment**, which browsers never send to servers or put in `Referer`. The
  page posts it to `POST /v1/session` and removes it from the address bar;
  orbitd answers with `Set-Cookie: orbit_session_<port>=…; HttpOnly;
SameSite=Strict; Path=/` **and** a per-session CSRF secret in the JSON body,
  which the App keeps in its own origin's storage. Only the bearer token can mint tickets, so a
  session cannot extend itself.
- **Sessions** live in orbitd's memory: 12 h idle expiry (sliding), 7 days at
  most, at most 32. A daemon restart (which also rotates the bearer token)
  signs every browser out; `DELETE /v1/session` signs one out. The cookie
  name carries the port because cookies ignore ports and two daemons (two
  `ORBIT_HOME`s) may share `127.0.0.1`.
- **The cookie alone is not a credential.** Cookies ignore ports, so any
  listener on another `127.0.0.1` port that the browser visits receives the
  cookie (M5 safety review HIGH-1). Every cookie-authenticated request must
  therefore also carry `X-Orbit-CSRF: <the session's secret>`, compared in
  constant time; a valid cookie with a missing or wrong secret gets 401. Web
  storage is scoped to scheme, host **and port**, so another loopback origin
  cannot read the secret, and a page on another origin cannot send the header
  without a CORS preflight orbitd refuses. `SameSite=Strict` is not enough on
  its own: another port on `localhost` is _same-site_. A script running on the
  App's own origin could use both — the CSP (`script-src 'self'`, model text
  rendered as text) is what stands there.
- **Origin allowlist:** a request with an `Origin` header is accepted only
  when the origin is orbitd's own (`http://` + the already-checked Host
  header) or listed in `api.allowedOrigins` / `ORBIT_ALLOWED_ORIGINS`. That
  list accepts **only** loopback `http(s)` origins (the Vite dev server,
  `http://localhost:5173`) and the Tauri origins (`tauri://localhost`,
  `http://tauri.localhost`) — never a remote site; the config loader refuses
  anything else. Doctor warns while the list is non-empty: whatever later runs
  on such a port is trusted too, so it is for App development only.
  Allowlisted foreign origins get CORS headers with
  credentials and preflights; all others get 403, including a `cross-site`
  `Sec-Fetch-Site` without a known origin. The Host allowlist (DNS
  rebinding) is unchanged, and a request without a Host header gets 400.
- **Browser-safe client:** the App imports `@orbit/sdk-client/browser` and
  `@orbit/core/browser` only (no `node:fs` daemon discovery, no
  `node:crypto`), with `credentials: 'same-origin'` and the CSRF header
  instead of a token. A guard test walks both entries' import graphs and
  fails on any Node built-in.

## Consequences

- One origin to secure; no token in the browser at all. Model-written text
  is still rendered as text (React escapes it), and the CSP blocks injected
  scripts and exfiltration to other hosts.
- Development: `ORBIT_ALLOWED_ORIGINS=http://localhost:5173 orbit daemon
restart`, `pnpm --filter @orbit/app dev`, then
  `orbit app --origin http://localhost:5173` (the Vite proxy forwards `/v1`
  to orbitd).
- Desktop (M8): the Tauri shell either loads the App from orbitd or uses the
  Tauri origin from the allowlist; it obtains its ticket the same way the CLI
  does. Hosted mode (M8) replaces tickets with OIDC sign-in over TLS.
