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
- **SdkDriver engine:** allowlist + the API key / Bedrock / Vertex variables;
  `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN` removed; engine started
  with `--bare` so OAuth/keychain are never consulted.
- **All other children** (MCP servers, hooks, tools, sandboxes): the API key is
  never included; plugin secrets are injected per plugin from the vault.
- Source code must not reference `.credentials.json`, the Claude keychain
  service, or read `CLAUDE_CODE_OAUTH_TOKEN`'s value (ESLint
  `no-restricted-syntax`; doctor may test the variable's _presence_ through a
  single audited helper).
- A redactor (`sk-ant-…`, bearer tokens, vault values) runs on every event,
  log line and audit record before persistence.

## Consequences

Users who authenticate the CLI only through `CLAUDE_CODE_OAUTH_TOKEN` must run
`claude login` for CLI mode (doctor explains this). See PLAN.md open question 3.
