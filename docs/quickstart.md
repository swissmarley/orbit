# Quickstart

Four ways to run Orbit, from "just looking" to a team server. Every path ends
with the same tools: the `orbit` CLI and TUI, and the web App that orbitd
serves.

| You want to…                               | Use                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| try it without any credentials             | [demo mode](#0-demo-mode-no-credentials)                                          |
| run Bots for yourself on your own computer | [subscription](#1-your-own-claude-login-personal-use) or [API key](#2-an-api-key) |
| run it in a container                      | [Docker Compose](#3-docker-compose-api-key)                                       |
| share it with a team over the network      | [hosted mode](#4-hosted-mode-team-server)                                         |

Not sure which credentials you may use? Read the
[compliance note](compliance.md) first: a Claude subscription is for **your
own, local, single-user** use; anything shared needs an API key.

## Install

```sh
npm install --global orbit-bots   # Node.js 22.13 or newer
orbit doctor                      # what Orbit found, which engine it will use, what is missing
```

`orbit` starts the daemon (`orbitd`) in the background the first time you need
it; it listens on `127.0.0.1:7420` and keeps its data in `~/.orbit`
(`ORBIT_HOME`, `ORBIT_PORT` change both). `orbit daemon status|stop|restart`
manages it.

From a checkout instead: `pnpm install`, then use `pnpm orbit …` wherever this
page says `orbit …` (and `pnpm --filter @orbit/app build` once for the App).

## 0. Demo mode (no credentials)

The MockDriver replays recorded Claude Code sessions: nothing is sent to a
model and nothing is billed. Approvals, budgets and plugins behave as they do
for real.

```sh
export ORBIT_DRIVER=mock
orbit bot create --name Demo --goal 'Summarize my notes'
orbit run demo                      # follow the Run in the terminal
orbit bot create --template inbox-triage
orbit run inbox-triage              # drafts replies, then waits for your approval to send
orbit approvals                     # what is waiting for you
orbit                               # the full-screen TUI (? lists the keys)
orbit app                           # opens the web App with a one-time sign-in link
```

Stop the daemon with `orbit daemon stop` before switching to real credentials.

## 1. Your own Claude login (personal use)

For you alone, on your own computer. Orbit runs your own `claude` binary and
never reads, copies or forwards its credentials.

```sh
npm install --global @anthropic-ai/claude-code
claude login                        # Claude Pro or Max
unset ANTHROPIC_API_KEY             # otherwise Orbit uses the key (and pay-as-you-go billing)
orbit doctor                        # engine: subscription (CliDriver)
```

What Orbit does to protect your subscription: at most 2 Runs at a time, a
daily Run cap per Bot, a pause when you hit a usage limit (and an automatic
resume after the reset, if the Bot allows it), and a daily cap on the model
calls Orbit makes on its own (summaries, Bot proposals). Subscription mode
refuses to run on a network address, in a container, with more than one
person, or in hosted mode.

## 2. An API key

```sh
install -m 0600 /dev/null ~/.orbit-api-key && printf %s 'sk-ant-…' > ~/.orbit-api-key
export ORBIT_API_KEY_FILE=~/.orbit-api-key   # or ANTHROPIC_API_KEY=sk-ant-…, or ORBIT_API_KEY_HELPER='command that prints a key'
orbit daemon restart                         # orbitd reads credentials when it starts
orbit doctor                                 # engine: API key (SdkDriver)
```

`ORBIT_API_KEY_FILE` (a file only you can read; orbitd refuses one others
can) keeps the key out of every process environment. `ANTHROPIC_API_KEY`
works too: the `orbit` CLI hands it to the orbitd it starts on a pipe, and
an orbitd you start yourself with the key in its environment re-executes
itself once without it on Linux; elsewhere `orbit doctor` warns
(`api_key_in_environment`), since any process of your user could read it
there.

Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`) and Google Vertex
(`CLAUDE_CODE_USE_VERTEX=1`) work too, with your cloud credentials. An API
key never leaves orbitd: the engine gets a placeholder and reaches Anthropic
through orbitd's loopback key proxy, so no engine, tool or plugin process ever
holds the key (cloud credentials do reach the engine, which on Linux then needs
bubblewrap). Models default to
the `opus` alias, with `haiku` for triage; set `ORBIT_DEFAULT_MODEL` /
`ORBIT_TRIAGE_MODEL` or a per-Bot `model`.

## Your first Bot

```sh
orbit bot create --name Notes --goal 'Every weekday, summarize new files in notes/ into digest.md' \
  --cron '0 9 * * 1-5'
orbit run notes                     # run it now and follow it
orbit runs                          # recent Runs
orbit tail <run>                    # follow a Run started elsewhere
orbit run notes --continue <run> --prompt 'Also say who wrote each note'   # answer it
```

Answering an ended Run continues its conversation: the new Run resumes the
same engine session with your message, under the same policy and budgets. In
the App this is simply the chat: it opens on your last Bot, every message is a
turn, and the computer button (top right) shows the Bot's workspace files, the
pages it read, the commands it ran and every call with its decision.

When a Bot wants to act on the outside world (send, post, push, write outside
its workspace) the Run **parks** and waits for you:

```sh
orbit approvals                     # pending approval cards
orbit approve <id>                  # or: --edit '{"to":"…"}'  --always
orbit deny <id> --reason 'not this customer'
```

In the App the card appears in the Bot's chat, and the **Inbox** lists every
card (`j`/`k` to move, `Enter` to open, `a` approve, `e` edit, `d` deny).
Anything involving money is never executed — the Bot prepares it and hands it
back to you.

Plugins (GitHub, Slack, Gmail & Calendar, Filesystem, Browser) are off until
you enable them:

```sh
orbit plugins
orbit plugin secret github GITHUB_TOKEN < token.txt
orbit plugin enable github          # shows exactly what the plugin gets first
```

Stop everything at once with `orbit kill` (release with `orbit kill --off`),
or pause one Bot with `orbit bot pause <bot>`.

## 3. Docker Compose (API key)

orbitd and the App in one container, API-key mode, reachable from this
machine only.

```sh
git clone https://github.com/swissmarley/orbit && cd orbit
install -m 0600 /dev/null ~/.orbit-api-key && printf %s 'sk-ant-…' > ~/.orbit-api-key
sudo chown 10001 ~/.orbit-api-key                 # Linux: the container's orbit user reads it (or setfacl -m u:10001:r)
export ORBIT_API_KEY_SECRET=~/.orbit-api-key
docker compose up -d --build                      # or ORBIT_IMAGE=ghcr.io/swissmarley/orbit:latest … --no-build
docker compose exec orbitd orbit app --no-open    # prints a one-time sign-in link for http://127.0.0.1:7420
docker compose exec orbitd orbit doctor
docker compose exec orbitd orbit bot create --template inbox-triage
```

The key reaches orbitd as a Compose secret: the file is mounted at
`/run/secrets/anthropic_api_key` and orbitd reads it (`ORBIT_API_KEY_FILE`),
so neither PID 1 nor orbitd ever has it in its environment. Do not put
`ANTHROPIC_API_KEY` in `.env` — compose.yaml no longer passes it on.

No key at hand? `ORBIT_DRIVER=mock docker compose up -d` runs the demo. The
port is published on `127.0.0.1` only — keep it that way: the local API is
plain HTTP. Data lives in the `orbit-data` and `orbit-home` volumes. Inside
the container Bots use directory workspaces; the container is their
isolation boundary.

## 4. Hosted mode (team server)

For several people over the network: API key only, TLS and sign-in through
your OIDC identity provider, with a role per person. Create an OIDC client
whose redirect URI is `https://orbit.example.com/v1/auth/oidc/callback`, then
write `$ORBIT_HOME/config.json`:

```json
{
  "mode": "hosted",
  "api": { "host": "0.0.0.0", "port": 443 },
  "hosted": {
    "publicUrl": "https://orbit.example.com",
    "tls": { "certFile": "/etc/orbit/tls.crt", "keyFile": "/etc/orbit/tls.key" },
    "oidc": { "issuer": "https://idp.example.com", "clientId": "orbit" }
  },
  "principals": [
    {
      "id": "ada",
      "kind": "human",
      "name": "Ada",
      "role": "owner",
      "oidc": { "email": "ada@example.com" }
    },
    {
      "id": "lin",
      "kind": "human",
      "name": "Lin",
      "role": "operator",
      "oidc": { "subject": "00u1abcd" }
    },
    {
      "id": "sam",
      "kind": "human",
      "name": "Sam",
      "role": "viewer",
      "oidc": { "email": "sam@example.com" }
    }
  ]
}
```

```sh
export ORBIT_API_KEY_FILE=/etc/orbit/anthropic-api-key   # 0600, owned by the user orbitd runs as
orbit secret set oidc_client_secret < client-secret.txt   # if your client has a secret (PKCE works without)
orbitd                                                    # or run it under systemd
```

People open `https://orbit.example.com` and choose **Sign in**. Roles:
`viewer` reads, `operator` also starts, stops and resumes Runs and decides
approvals, `owner` also manages Bots, rules, secrets, plugins and the kill
switch. Every action is recorded under the person's id. Behind a TLS reverse
proxy on the same machine, leave `tls` out and keep `api.host` on
`127.0.0.1`. Webhooks are then reachable at
`https://orbit.example.com/hooks/<bot>/<trigger>` (signed with
`orbit trigger webhook-secret <bot> <trigger>`). The `orbit` CLI on the server
itself keeps working with the local bearer token as the owner.

## Desktop app

The desktop shell (Tauri) opens the App in its own window from your local
orbitd. It needs the `orbit` CLI installed (`npm install --global orbit-bots`,
or set `ORBIT_CLI`). Bundles are attached to each
[GitHub release](https://github.com/swissmarley/orbit/releases); to build one
yourself: `pnpm --filter @orbit/desktop build` (Rust and, on Linux,
WebKitGTK required).

## Next

- `orbit --help`, `orbit <command> --help`, and `?` in the TUI and the App
- [Security model](security.md) — what Orbit protects and how
- [Architecture](architecture.md) — how the pieces fit
