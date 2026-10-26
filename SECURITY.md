# Security policy

Orbit runs autonomous agents with access to files, shells and external
services, so security reports are taken seriously.

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue or pull
request.

Use GitHub's **Report a vulnerability** button on the repository's
**Security** tab (private vulnerability reporting). Include:

- what you found and the impact you expect;
- the Orbit version or commit, your OS, and the mode in use (subscription /
  API key / Docker / hosted);
- steps to reproduce, or a proof of concept;
- any logs, with secrets and tokens removed.

This is a personal open-source project, so responses are best-effort. You can
expect an acknowledgement of your report, a fix or mitigation for confirmed
issues, and credit in the release notes if you want it. Please give me a
reasonable chance to fix an issue before disclosing it publicly.

## Supported versions

Only the latest release and the `main` branch receive security fixes.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |

## Scope

In scope: anything that breaks the guarantees described in
[`docs/security.md`](docs/security.md) and the security invariants in
[`CLAUDE.md`](CLAUDE.md), for example:

- a Bot or plugin escaping its sandbox, workspace or egress allowlist;
- credentials (API keys, Claude login, the daemon token, vault or audit keys)
  reaching a child process, a log, the database or a client;
- bypassing the policy engine, approvals, budgets or kill switches;
- authentication, session, CSRF or origin-check bypasses in `orbitd`;
- prompt-injection paths that turn untrusted content (triggers, plugin output,
  memory imports, workspace files) into trusted instructions;
- tampering with the audit log without detection.

Out of scope:

- attacks that need you to run untrusted code as your own user, or to read your
  `$ORBIT_HOME` (the threat model assumes your machine and `$ORBIT_HOME` are
  private);
- exposing `orbitd` on a network outside the documented modes (loopback,
  container with a loopback-only published port, hosted mode with TLS and OIDC);
- issues in third-party plugins you installed and enabled yourself;
- findings that only apply to the `mock` driver or to test fixtures.

## Handling secrets

Never include real API keys, tokens or `$ORBIT_HOME` contents in a report. If
you believe a secret was committed to this repository, report it the same way
and rotate the secret on your side.
