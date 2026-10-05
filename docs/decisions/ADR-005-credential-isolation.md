# ADR-005: Credential isolation and child environments

Status: Accepted (M0, implemented in M1)

## Decision

- Child processes never inherit `process.env` wholesale. Each spawn builds its
  environment from an explicit allowlist (`buildChildEnv(kind)`).
- **CliDriver children:** allowlist only; `ANTHROPIC_API_KEY` and
  `ANTHROPIC_AUTH_TOKEN` are deleted unconditionally. `CLAUDE_CODE_OAUTH_TOKEN`
  is **not** forwarded: Orbit never reads, copies, stores, logs or forwards
  OAuth credentials; the `claude` binary reads its own credential store via
  `HOME`/`CLAUDE_CONFIG_DIR`.
- `ANTHROPIC_BASE_URL` is not forwarded to the CLI child: a gateway set up for
  API keys must never receive subscription traffic (doctor warns).
- **SdkDriver engine:** allowlist + the API key / Bedrock / Vertex variables,
  plus `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` so the engine strips credentials
  from its own children (Bash, hooks, MCP servers);
  `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN` removed; engine started
  with `--bare` so OAuth/keychain are never consulted. (Amended in M8 by
  ADR-018: an API key or apiKeyHelper output no longer reaches any engine —
  engines get a placeholder and orbitd's key proxy; only Bedrock / Vertex
  credentials still go to the engine.)
- **All other children** (MCP servers, hooks, tools, sandboxes): the API key is
  never included; plugin secrets are injected per plugin from the vault.
- Source code must not reference `.credentials.json`, the Claude keychain
  service, or read `CLAUDE_CODE_OAUTH_TOKEN`'s value (ESLint
  `no-restricted-syntax`; doctor may test the variable's _presence_ through a
  single audited helper).
- A per-process redactor, seeded with the values of the API credentials that
  are present and every per-Run hook token (plus patterns for common key
  formats), runs on every event before persistence and on terminal errors.
- The baseline policy keeps Bots out of credential stores (`~/.claude`,
  `~/.ssh`, `~/.aws`, gcloud, netrc, `/proc`) and Orbit's own data directory;
  reads and writes are confined to the Bot workspace.

## Consequences

Users who authenticate the CLI only through `CLAUDE_CODE_OAUTH_TOKEN` must run
`claude login` for CLI mode (doctor explains this). See PLAN.md open question 3.
