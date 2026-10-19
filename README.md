# Orbit

**Self-hostable, always-on, goal-driven AI agents ("Bots") on Claude Code and
the Claude Agent SDK.** A Bot has a goal, tools, memory, triggers, a policy and
budgets, and works on its own computer around the clock. You talk to it like
a chat assistant; it only comes to you for **approvals**, **blockers** and
**results**.

![The Orbit App: a chat with a Bot, its work as cards, and its computer](docs/screenshots/chat-light.png)

- **`orbitd`** — the daemon that runs your Bots 24/7: queue, scheduler,
  triggers, policy, approvals, memory, audit.
- **`orbit`** — a keyboard-first terminal UI and a scriptable CLI (`--json`
  everywhere).
- **The App** — a chat-first web (and desktop) App served by orbitd: talk to
  your Bots, watch their work as cards, decide their requests in the
  conversation and look at each Bot's computer; plus the Inbox, live Run
  timelines, memory, integrations and settings.

```sh
npm install --global orbit-bots
ORBIT_DRIVER=mock orbit bot create --template inbox-triage   # demo mode: no credentials
ORBIT_DRIVER=mock orbit run inbox-triage                     # drafts replies, waits for your approval to send
orbit app                                                    # open the App
```

Then read the **[Quickstart](docs/quickstart.md)**: demo mode, your own Claude
login, an API key, Docker Compose and hosted mode.

## What a Bot can do

- **Chat** — every message is a Run that continues the conversation's engine
  session, under the same policy, budgets and approvals; a request it makes
  appears in the chat as the full approval card.
- **Have a face and a computer** — each Bot has its own avatar and its own
  workspace (a folder, a git worktree or a Docker container). The App shows
  its files, the pages it read, the commands it ran and every call with its
  decision; `orbit shell` takes it over.
- **Run on triggers** — schedules (cron, interval), signed webhooks, Slack
  (Socket Mode, no public URL), file and git changes, or by hand.
- **Use tools safely** — Claude Code's built-in tools plus plugins for GitHub,
  Slack, Gmail & Calendar, a Filesystem and a Browser, all behind Orbit's
  policy.
- **Remember** — memory with provenance (FTS search, markdown mirror), your
  feedback (thumbs, edits, denials) and post-run summaries.
- **Work as a team** — subagents and delegation to peer Bots, with budgets,
  taint and kill switches carried across and a live delegation tree.

## How it works

```mermaid
flowchart LR
  subgraph clients[Clients]
    app[App · web / desktop]
    tui[orbit TUI]
    cli[orbit CLI]
  end
  subgraph orbitd[orbitd · single writer]
    api[Typed API<br/>REST + SSE]
    policy[Policy · approvals<br/>budgets · kill switches]
    log[(Append-only events<br/>hash-chained audit)]
  end
  engine[Claude Code engine<br/>one per Run]
  plugins[Plugins<br/>GitHub · Slack · Google · FS · Browser]
  triggers[Triggers<br/>cron · webhooks · Slack · files · git]

  clients -->|"@orbit/sdk-client"| api --> policy --> log
  policy -->|SDK or CLI driver| engine
  engine -->|every tool call| policy
  policy --> plugins
  triggers --> api
```

Every tool call the engine wants to make is decided by Orbit **before** it
runs. Reads are automatic; writes stay inside the Bot's workspace; anything
that acts on the outside world (sending email or Slack messages, pushing to
GitHub) **parks the Run until you approve that exact action**; anything that
moves money is never executed — it is handed back to you. Content from the
web, email, Slack, webhooks, plugins and other Bots is untrusted: it taints
the Run, so no standing rule can let the Bot act on it unasked. Budgets and
kill switches are enforced by the runtime, not by the prompt. See the
[architecture](docs/architecture.md) and the
[security model](docs/security.md).

## Two ways to authenticate

| Mode                                            | For                                               | Billing                    |
| ----------------------------------------------- | ------------------------------------------------- | -------------------------- |
| **API key** (or Amazon Bedrock / Google Vertex) | anything: servers, containers, teams, hosted mode | pay as you go              |
| **Your own `claude login`** (Claude Pro / Max)  | **you alone, on your own computer**               | your subscription's limits |

Orbit never reads, copies or forwards your Claude login credentials, and it
refuses subscription mode whenever Orbit is reachable from the network or
shared by several people. Read the [compliance note](docs/compliance.md) for
the details and for who may start Runs.

## Screenshots

| A request, decided in the chat                                   | The Bot's computer                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------- |
| ![Approval in the chat](docs/screenshots/chat-approval-dark.png) | ![The Bot's computer](docs/screenshots/computer-dark.png) |
| **Bots**                                                         | **A Run, live**                                           |
| ![Bots](docs/screenshots/bots-light.png)                         | ![Run view](docs/screenshots/run-light.png)               |
| **Memory**                                                       | **Terminal UI**                                           |
| ![Memory](docs/screenshots/memory-light.png)                     | ![TUI](docs/screenshots/tui.png)                          |

## Status

Orbit **0.1** completes the engineering plan's milestones M0–M8: drivers,
policy and approvals, the daemon and API, the TUI, the App, memory and
delegation, plugins and triggers, and hardening and packaging (security test
corpus, load test, hosted mode, Docker sandbox, npm package, Docker Compose,
desktop shell). After 0.1 the App became chat-first, in the spirit of
[OpenDots](https://github.com/CopilotKit/OpenDots): conversations, Bot avatars
and the Bot's computer ([ADR-020](docs/decisions/ADR-020-chat-avatars-and-the-bots-computer.md)).
See [`docs/PLAN.md`](docs/PLAN.md) for the plan, the status and the deferred
items, and [`docs/decisions/`](docs/decisions/) for the architecture decision
records.

## Development

```sh
pnpm install            # Node >= 22.13, pnpm 10 (corepack)
pnpm check              # format, lint, typecheck, tests (no credentials needed)
pnpm orbit doctor       # the CLI from source; it starts orbitd (loopback) on demand
pnpm test:e2e           # the App against a real orbitd (mock driver), Playwright + axe
pnpm smoke              # build, pack and install the npm package, then drive it
```

[`CLAUDE.md`](CLAUDE.md) is the contributor guide: layout, conventions,
security invariants and every command.

## License

MIT © 2026 Nakya
