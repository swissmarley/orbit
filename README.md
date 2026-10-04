# Orbit

Self-hostable, always-on, goal-driven AI agents ("Bots") powered by Claude Code
and the Claude Agent SDK.

> **Status: pre-alpha, under construction.** The scaffold (M0) is in place; the
> runtime, drivers and clients are being built milestone by milestone. See
> [`docs/PLAN.md`](docs/PLAN.md) for the architecture, milestones and current
> status, and [`docs/decisions/`](docs/decisions/) for architecture decisions.

Orbit will ship three things from this monorepo:

- **`orbitd`**: a daemon that runs durable agents 24/7
- **`orbit-app`**: a web/desktop control room
- **`orbit`**: a terminal UI and scriptable CLI

Orbit runs either with an Anthropic API key (or Bedrock/Vertex), or for
personal, local, single-user use with your own logged-in Claude Code CLI.
Hosted and multi-user deployments require an API key.

## Development

```sh
pnpm install
pnpm check
```

License: MIT.
