# orbit-bots

**Orbit**: self-hostable, always-on, goal-driven AI agents ("Bots") on Claude
Code and the Claude Agent SDK. This package installs the two programs:

- `orbit`: the terminal UI (run it with no arguments) and the scriptable CLI
- `orbitd`: the daemon that runs your Bots; `orbit` starts it in the background
  when it is not running, and it serves the web App

```sh
npm install --global orbit-bots     # Node.js 22.13 or newer
orbit doctor                        # how Orbit will authenticate, and what is missing
```

## Try it without credentials

The demo mode replays recorded sessions: nothing is sent to a model.

```sh
ORBIT_DRIVER=mock orbit bot create --name Demo --goal 'Summarize my notes'
ORBIT_DRIVER=mock orbit run demo
orbit daemon stop
```

## Authentication

Orbit picks one of two engines; `orbit doctor` explains which one and why.

- **API key** (also Amazon Bedrock or Google Vertex): set `ANTHROPIC_API_KEY`
  (or an `apiKeyHelper`) in the environment orbitd starts with. The key reaches
  only the Agent SDK engine, never any other child process. Required for
  anything other than personal, local, single-user use.
- **Your own Claude Code login** (personal, local, single-user only): install
  the `claude` CLI and sign in with `claude login`. Orbit runs your `claude`
  and never reads, copies or forwards its credentials.

## Everyday commands

```sh
orbit                                  # the full-screen TUI (? shows the keys)
orbit bot create --name Inbox --template inbox-triage
orbit run inbox                        # start a Run and follow it
orbit approvals                        # what your Bots are waiting for
orbit approve <id> | orbit deny <id> --reason '…'
orbit app                              # sign the browser in to the App (one-time link)
orbit plugins                          # GitHub, Slack, Gmail & Calendar, Filesystem, Browser
orbit kill                             # stop everything now
orbit daemon status|stop|restart
```

Every command that prints data takes `--json`. Orbit keeps its data in
`~/.orbit` (`ORBIT_HOME`); orbitd listens on `127.0.0.1:7420` (`ORBIT_PORT`)
and nowhere else.

## Safety model in one paragraph

Tools are denied unless a policy allows them; anything that acts on the
outside world (sending email or Slack messages, pushing to GitHub, writing
outside the Bot's workspace) waits for your approval, and anything involving
money is always handed back to you. Content from the web, email, Slack,
webhooks and plugins is untrusted: a Run that has read it cannot act
externally without asking. Budgets and the kill switch are enforced by
orbitd. Plugins are off until you enable them.

## Docker and desktop

- `docker compose up` in the repository runs orbitd and the App in one
  container (API-key mode).
- A desktop shell (Tauri) opens the App from your local orbitd; it needs this
  package installed (`orbit` on the `PATH`).

See the repository for documentation, the security model and the design
decisions: <https://github.com/swissmarley/orbit>.

## License

MIT © 2026 Nakya
