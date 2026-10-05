# ADR-018: Docker sandbox: host-side key proxy and enforced egress

Status: Accepted (M8)

## Context

ADR-004 put API-key Bots in a Docker container each. Until M8 the engine in
the container received `ANTHROPIC_API_KEY` in its `docker exec` environment, so
anything running in the container (Bash included) could read the key from
`/proc/<pid>/environ`; the container had either no network at all (the engine
could not reach the API either without `bridge`) or a full `bridge` network
for `network: allowlist`. The M2 safety review (M3) therefore kept Docker
behind `ORBIT_EXPERIMENTAL_DOCKER=1`, Bash EXTERNAL in containers, and
deferred to M8: keep the key out of the container, give the engine API
egress without general egress, enforce the domain allowlist, map
`/workspace` paths in policy and recreate containers when their shape
changes.

Constraints: the real key must never be in the container's environment,
filesystem, argv or `docker inspect`; every child env is built from an
allowlist; no new privileges for the container; the proxies must be testable
without Docker; nothing listens on a TCP port of the host.

## Decision

### 1. No network but Orbit's sockets

The container always runs with `--network none` (now also for
`network: allowlist`) and `--init`. Per Docker Bot, orbitd runs host-side
proxies on **Unix sockets** in a 0700 directory
`$ORBIT_HOME/run/sandbox/<bot id>/` (`api.sock`, and `egress.sock` only with an
allowlist; each socket 0600). The directory is bind-mounted **read-only** at
`/run/orbit`: the container can connect to the sockets (connect(2) on a socket
is not a write to the filesystem) but cannot delete, replace or add files
there. Socket paths are limited to 107 bytes; a longer `ORBIT_HOME` is refused
with a hint.

The container's entry command starts `socat` bridges
(`TCP-LISTEN:47180,bind=127.0.0.1,fork → UNIX-CONNECT:/run/orbit/api.sock`,
and 47181 → `egress.sock` with an allowlist), then `exec sleep infinity`.
`docker/sandbox.Dockerfile` installs socat. After creating or starting a
container, `prepare` checks the whole path from inside it (UNIX-CONNECT to the
socket, then TCP to the bridge) and fails with a hint (image without socat,
socket mount not reachable) instead of handing out a broken workspace.

The engine's container environment (`containerEngineEnv`, no secrets):
`ANTHROPIC_API_KEY=orbit-key-proxy-placeholder`,
`ANTHROPIC_BASE_URL=http://127.0.0.1:47180`, `NO_PROXY=127.0.0.1,localhost`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0`, and with an allowlist
`HTTPS_PROXY`/`HTTP_PROXY` (upper and lower case) `=http://127.0.0.1:47181`. The
`docker exec` spawner never forwards API or cloud credentials, the host's
`ANTHROPIC_BASE_URL`, host proxies or provider switches (`ANTHROPIC_*`,
`AWS_*`, `GOOGLE_*`, `VERTEX_REGION_*`, `CLOUD_ML_*`, `CLAUDE_CODE_CLIENT_*`,
`CLAUDE_CODE_USE_*`, `*_PROXY`), whatever the caller or the SDK passes; the
container env is layered last. The runtime builds the container engine's base
env with `buildChildEnv('tool')`, so the key does not even reach the spawner,
and the SDK driver gets `apiKeyProxied: true`: no API credential in
`options.env`, no `apiKeyHelper` setting (it would run inside the container),
and the expected credential source is `ANTHROPIC_API_KEY` (the placeholder).

**Verified, not guessed** (Claude Code 2.1.289 / Agent SDK 0.3.289, engine
binary from `@anthropic-ai/claude-agent-sdk-linux-x64`, against a recording
upstream, scratch HOME, `env -i`):

- `--bare` accepts any non-empty `ANTHROPIC_API_KEY`, reports
  `apiKeySource: "ANTHROPIC_API_KEY"`, sends it as `x-api-key` and no
  `Authorization` header.
- `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` is honoured; the engine's proxy
  agent bypasses `HTTPS_PROXY` for hosts listed in `NO_PROXY` (exact host
  names), so API traffic never goes to the egress proxy.
- The only requests a turn makes are `POST /v1/messages?beta=true` (streamed)
  and, when it counts tokens, `POST /v1/messages/count_tokens?beta=true`. When
  no `HTTPS_PROXY` is set the engine also sends a `HEAD /api/hello` warm-up.
- With `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` the engine refuses to start
  without bubblewrap ("bubblewrap is required for subprocess env scrubbing"),
  and bubblewrap cannot create namespaces in an unprivileged container. In a
  container there is no credential to scrub, so the container env sets it to
  `0`. (See "Consequences" for the host-side SDK engine.)
- End to end on a local Docker Engine: the real Agent SDK `query()` spawned
  the real engine binary in a `--network none` container through the
  `docker exec` spawner; the turn completed through socat → `api.sock` →
  the key proxy → a fake upstream, which received the real key while the
  container held only the placeholder.

Considered and rejected: `ANTHROPIC_UNIX_SOCKET` (the engine can talk to the
API over a Unix socket directly, but the variable is undocumented and tied to
`claude ssh`; HTTPS_PROXY needs a TCP port anyway, so socat is needed for
egress either way); a TCP listener on the host reachable through
`host.docker.internal` (a host port any local process could use, and a
`bridge` network); a proxy process inside the container (the key would be in
the container).

### 2. Key-injecting API proxy (`@orbit/sandbox/src/proxy/api-proxy.ts`)

Pure Node, one per Docker Bot. It forwards only `API_ROUTES`
(`POST /v1/messages`, `POST /v1/messages/count_tokens`, no query or exactly
`?beta=true`) and answers `HEAD /api/hello` itself; everything else is 403
with an API-shaped `permission_error`. Request headers are an allowlist
(`accept`, `accept-encoding`, `content-type`, `user-agent`, `x-app`,
`anthropic-*`, `x-stainless-*`, `x-claude-code-*`): the container's
`x-api-key`, `Authorization`, cookies and proxy headers are dropped, the real
key is injected as `x-api-key`, `Host` is the upstream's. The upstream is
orbitd's `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`, a path
prefix is kept); it must be `https`, or `http` to a loopback gateway, and may
not carry credentials. Responses stream back unbuffered (`flushHeaders`, then
pipe); a client that goes away aborts the upstream request. Bodies are
bounded at 32 MiB (declared or streamed → 413) and read before any refusal, so
the client sees the answer instead of a broken pipe.

Because any process in the container can reach the API socket, the proxy
also keeps the API from becoming a general network path: request bodies with
`mcp_servers` (Anthropic would connect to arbitrary MCP URLs) or URL content
sources (`{"type":"url",…}` images/documents) are refused always; the
server tools `web_search_*` / `web_fetch_*` are refused when the Bot's network
is `none` (with an allowlist Bash needs approval anyway and the engine's
WebSearch uses `web_search_20250305`).

Key sources (`proxy/key-source.ts`): orbitd's `ANTHROPIC_API_KEY`, or the
owner's `apiKeyHelper` (`ORBIT_API_KEY_HELPER`) run on the host with
`/bin/sh -c` and the env the SDK engine would have given it, cached for
`CLAUDE_CODE_API_KEY_HELPER_TTL_MS` (default 5 minutes, as Claude Code does),
refreshed after a 401, one run shared by concurrent requests. Neither the key
nor the helper's output or stderr ever appears in an error, a log line or the
counters. **Bedrock and Vertex** cannot use the proxy: Docker sandboxes are
refused for them with a hint to use worktree/directory; the SDK driver without
any key is refused too (the mock driver may still prepare a container).

The proxies forward **only while a Run segment of the Bot holds a lease**
(`prepare` acquires it, the orchestrator releases it when the segment ends,
on every path); at zero leases open connections and tunnels are cut. A process
the Bot left behind in its container cannot spend the key between Runs.

### 3. Egress proxy (`proxy/egress-proxy.ts`)

HTTP CONNECT only (plain-HTTP proxying and upgrades get 405): the target must
match the Bot's `sandbox.allowedDomains`, parsed by `parseAllowlist` — exact
names, `*.suffix` wildcards (subdomains only, not the bare suffix), IPv4/IPv6
literals, each with an optional `:port` (default 443); entries that are none
of these never match and are listed by doctor. The allowlist is read for
every tunnel, so spec edits apply at once. Names are resolved on the host
(injectable lookup); an answer is used only if it is public — loopback,
private, link-local (cloud metadata), CGNAT, unique-local, site-local,
multicast, unspecified, reserved, documentation, benchmarking and IPv4 carried
in IPv6 (mapped, compatible, NAT64, 6to4) are refused — unless the owner
allowlisted that literal address and port. The proxy connects to the address
it checked (no second lookup). Concurrent tunnels are capped (64), idle ones
closed after 10 minutes. With `network: none` there is no egress proxy at all.
Plain-HTTP egress is not offered: HTTPS covers package registries and the
engine's WebFetch.

**Refusals are counted and visible**: per Bot, `forwarded / refused / failed`
and the last 20 refusals (`host:port` or `METHOD /path`, never a query string,
header or body) appear in `orbit doctor` (`sandbox.dockerSandbox.proxies`), and
each refusal is a `warn` line in orbitd's log. A Run event per refusal was
not chosen: the proxies are per Bot, not per Run, and the counters fit the
existing doctor model.

### 4. Bash tier

`dockerShellContained(network, stale)`: Bash in a container is WRITE_LOCAL
only with `network: none` — its only socket reaches the Anthropic API with the
owner's key, through the body checks above — and only when the running
container matches the spec (see 6). With an allowlist, Bash stays EXTERNAL.
The policy engine's existing rule (`shellContained` → WRITE_LOCAL) does the
rest; workspace-file taint treats a contained shell as before.

### 5. `/workspace` paths in policy

`PreparedWorkspace.mounts` (`/workspace` → the host workspace, writable;
`/repo` → `sandbox.repo`, read-only) reaches the policy's
`FileAccessContext`. `toHostPath` resolves a tool path the way the container
sees it (relative to `/workspace`, `..` normalized) and maps it to the host;
anything outside the mounts — `/etc`, `/proc`, `/run/orbit`, `/tmp`, even the
host path of the workspace — is refused. Then the usual checks run on the host
path (symlinks resolved, sensitive roots, writes only in the workspace,
`CLAUDE.md`, `.claude`, `.git` and now `.orbit-home` — the container engine's
HOME — protected). A container Bot's read roots are its read-only mounts
(`spec.readRoots` are host paths it cannot see). Workspace-file taint and
approval-card diffs map paths the same way.

### 6. Recreate on change

Each container carries `orbit.config=<sha256/16>` over image reference, CPU,
memory, PID limits, network mode, mounts, socket directory, user, ports and a
layout version; `prepare` also compares the container's image id with the
local image's (a rebuilt `orbit-sandbox:latest` counts; a missing local image
does not). On a mismatch the container is removed and recreated — only when no
Run of the Bot holds a lease; otherwise it is kept for now (and its shell
counts as not contained) and the change applies at the next Run start.
`prepare` is serialized per Bot so two Runs never both recreate. The
allowlist itself is not part of the hash (the egress proxy reads it live).
Containers created before this ADR have no label and are recreated once.

### 7. The experimental gate is lifted

Docker sandboxes are available in API-key mode (`api_key`,
`api_key_helper`) without `ORBIT_EXPERIMENTAL_DOCKER`; they stay refused for
the CLI (subscription) driver and for Bedrock/Vertex. Doctor reports
`sandbox.dockerSandbox`: `ready`, the key-proxy state (`ready`, `no_api_key`,
`unsupported_provider`, `subscription`), each image's presence and whether
socat runs in it (a throwaway `--network none` container), and the per-Bot
proxy counters.

## Consequences

- The key exists only in orbitd. Tests check the container env, `/proc/*/environ`
  and `cmdline`, files under `/workspace`, `/tmp`, `/etc`, `docker inspect`,
  the `docker run` argv and the proxies' errors and counters.
- Code in the container can still make API calls with the owner's key while a
  Run of the Bot is active; those are not counted in Orbit's token/cost budgets
  (only the engine's reported usage is). They are bounded by the Run's
  wall-clock budget and kill switches (a Run's end cuts every connection) and
  counted per Bot in doctor. Metering usage in the proxy is a possible
  follow-up.
- Docker Engine on Linux, rootful, with the container running as the host
  user (the default `--user uid:gid`) is the supported setup. Rootless Docker
  would need the container to run as root (container root is the host user;
  `SandboxManager`'s `containerUser` is not exposed in config yet) and Docker
  Desktop's file sharing may not pass Unix sockets through; the bridge check
  then fails with a hint. Neither is verified.
- `HTTPS_PROXY` of the host is not chained: the egress proxy connects
  directly to the address it checked, and the key proxy connects directly to
  the upstream. Hosts that can only reach the internet through a proxy cannot
  use Docker sandboxes yet.
- The engine's WebFetch checks domains with `claude.ai` before fetching; with
  an allowlist that does not include it, WebFetch fails closed. With
  `network: none`, WebFetch and WebSearch fail (no network at all).
- Plugins run on the host and receive the engine's container paths; the
  Filesystem plugin refuses `/workspace/…` paths (fail closed). Mapping paths
  for plugins is a follow-up.
- Found while verifying: Claude Code 2.1.289 refuses to start with
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` when bubblewrap is missing. The SDK
  engine on the host (directory/worktree Bots in API-key mode) set it
  (ADR-005), so SDK Runs on a host without bubblewrap failed. Resolved by the
  amendment below: host engines now sit behind the key proxy too.
- CI's `check` job runs the Docker integration tests (the runner has Docker):
  they build a small `node:22-bookworm-slim` + socat image tagged by its
  Dockerfile's hash, not the full sandbox image.

## Amendment (M8): host SDK engines behind the key proxy

### Context

After this ADR the SDK engine on the host (directory and worktree Bots in
API-key mode) still received the real `ANTHROPIC_API_KEY` and relied on
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` to keep it from its children. On Linux
Claude Code enforces that scrub with bubblewrap and refuses to start without
it, so SDK Runs failed on hosts without bwrap (commit `6182e8a` made that an
early `engine_sandbox_missing` failure) — and the `docker compose` deployment
(orbitd in an unprivileged container, where bwrap cannot create namespaces)
could never run a Bot.

### Decision

**API keys and apiKeyHelper output never enter an engine process.** Host
engines with `api_key` / `api_key_helper` reach the API through orbitd's
`HostKeyProxy` (`@orbit/sandbox/src/proxy/host-key-proxy.ts`):

- **One loopback TCP listener per daemon** (`127.0.0.1`, random port, started
  with the first segment, `unref`'d), with a **per-segment credential in the
  path**: each Run segment's lease is a random 32-byte base64url token, and
  the engine gets `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/<token>`. One
  listener rather than one per segment: the token, not the port, is what
  keeps other local users and processes out (ports on loopback are easy to
  scan), ending a lease is synchronous and immediate (no `server.close`
  race), the port does not churn, and doctor has one set of counters.
  Requests without a live token — none, malformed, unknown, of an ended
  segment, or another segment's — are refused with an API-shaped 403 before
  anything is read upstream. Live leases are looked up by the token's
  SHA-256, so the secret is never compared directly. Requests carrying an
  `Origin` header (a browser) are refused, CONNECT and upgrades are refused.
- Everything after the token goes through the same forwarder as the Docker
  proxy (`createApiForwarder`, factored out of `createApiProxy`): only
  `API_ROUTES`, an allowlist of request headers, the real key injected as
  `x-api-key`, the token stripped from the forwarded path (a gateway prefix of
  orbitd's `ANTHROPIC_BASE_URL` is kept), streaming responses, bodies bounded,
  `mcp_servers` and URL content sources refused. The server-side web tools
  are **allowed** for host engines: the engine has the host's network anyway,
  so refusing them would only take WebSearch away without closing any path.
  Refusals are counted and logged by route and reason — never the token, a
  query string or a header.
- The token is registered with the redactor (like per-Run hook tokens) and
  never appears in events, logs or doctor.
- **The lease is the SdkDriver's, per segment** (`EngineKeyProxy.open()` in
  `run()`): it closes when the driver finishes, in its `finally`, and the
  moment the Run's abort signal fires — stop, kill switches, budgets,
  pause-now and shutdown all abort that signal — and a close cuts the
  segment's in-flight requests (upstream and client). Putting the lease in
  the driver (not the workspace provider) also covers the triage path, which
  calls `driver.run` outside the orchestrator. The orchestrator now releases a
  Docker Bot's lease at abort time as well, not only when the segment ends.
- The engine env is `proxiedEngineEnv`: the `tool` allowlist (no API or cloud
  credential, no provider switch, not the host's `ANTHROPIC_BASE_URL`), plus
  `ANTHROPIC_API_KEY=orbit-key-proxy-placeholder`, the proxy URL, and
  `NO_PROXY`/`no_proxy` extended with `127.0.0.1,localhost` so a host
  `HTTPS_PROXY` never sees the engine's API traffic. `assertProxiedEngineEnv`
  checks it (only the placeholder key, no credential or provider switch, a
  loopback `http://127.0.0.1` base URL) and has positive controls.
- **Scrub by capability:** with no secret left in the engine's env,
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is `1` where Claude Code can enforce it
  (macOS; Linux with `bwrap` on orbitd's PATH) as defence in depth, and `0`
  where it cannot (Linux without bwrap — e.g. the docker compose image).
- `apiKeyHelper` runs inside orbitd (`keyProxyCredential`, one key source and
  one helper cache shared by the host and Docker proxies) and is never put in
  a proxied engine's settings. The engine reports `ANTHROPIC_API_KEY` as its
  source; `checkAuthSource` expects exactly that for every proxied engine (an
  engine that found an `apiKeyHelper` of its own is stopped).
- `SdkDriver` refuses to be constructed for `api_key` / `api_key_helper`
  without a key proxy, so no code path hands a key to an engine any more.
- **Bedrock and Vertex** cannot be proxied: unchanged — the cloud credentials
  go to the engine (`sdk-engine` allowlist), scrub `1`, and on Linux without
  bwrap the Run fails before the engine starts (`engine_sandbox_missing`).
- **Doctor**: `engineKey` (`delivery: proxied | in_engine`,
  `subprocessScrub`, a detail line, and the host proxy's port, live segments
  and counters once the engine started); `sdk_needs_bubblewrap` now fires only
  for Bedrock/Vertex; `key_proxy_upstream` warns when orbitd's
  `ANTHROPIC_BASE_URL` is plain `http` to another machine (the proxy sends the
  key only over https or to a loopback gateway; before, the engine would have
  sent it in clear text).

**Verified, not guessed** (Claude Code 2.1.289 / Agent SDK 0.3.289, engine
binary from `@anthropic-ai/claude-agent-sdk-linux-x64`, `env -i`, scratch
HOME, a recording upstream on loopback): the engine keeps a base-URL path
prefix for every request, including its warm-up (`HEAD /<token>/api/hello`,
answered by the forwarder) and `POST /<token>/v1/messages?beta=true`; it
accepts the placeholder with `--bare` and sends it as `x-api-key`; with scrub
`1` and no bwrap on PATH it refuses to start, with scrub `0` the turn
completes. `packages/runtime/test/sdk.key-proxy.test.ts` runs this in CI when
the binary is installed: the real SdkDriver, the real `query()` and the real
`HostKeyProxy` against a fake upstream, once with an empty PATH and scrub `0`,
once with scrub `1` when bwrap works — asserting the upstream got the real key
on token-free paths and that the engine process's `/proc/<pid>/environ` and
`cmdline` held the placeholder and never the key.

### Consequences

- The docker compose deployment and Linux hosts without bubblewrap run
  API-key Bots; the key exists only in orbitd.
- While a segment runs, anything the engine starts (Bash included) inherits
  the base URL with the token and the placeholder when the scrub is off, so it
  can make API calls with the owner's key through the proxy — the same
  exposure as code in a Docker Bot's container: bounded by the segment
  (wall-clock budget, kill switches, stop), by the forwarder's routes and
  body rules, counted in doctor, not metered in Orbit's token/cost budgets
  (only the engine's reported usage is). Before, the same child could read
  the key itself when the scrub was off, or the Run could not start at all.
- A process of the same OS user can read the token from the engine's
  `/proc/<pid>/environ` during a segment; such a process could read orbitd's
  environment (the key) anyway. Other users cannot.
- The key proxy connects to the upstream directly; orbitd's `HTTPS_PROXY` is
  not chained (as for Docker Bots). Hosts that reach the API only through an
  outbound proxy can no longer run API-key SDK Bots; chaining CONNECT through
  `HTTPS_PROXY` in the forwarder is the follow-up.
