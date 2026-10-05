# ADR-014: Plugins run in orbitd, behind Orbit's own MCP endpoint; inbound triggers are verified before they are read

Status: Accepted (M7)

## Context

M7 adds plugins (MCP servers for GitHub, Slack, Gmail/Calendar, a
filesystem and a browser) and inbound triggers (Slack, webhooks, file and git
changes). Each one brings third-party code, third-party credentials or
third-party content into a Bot's Run. The constraints:

- Every child process gets an environment built from an allowlist; a plugin's
  secrets come from the vault by name and reach only that plugin; the API key
  and Claude OAuth credentials reach no plugin at all.
- Plugin tiers can never override Orbit's own tool tiers (`ORBIT_TOOL_TIERS`)
  or the default-deny policy; EXTERNAL actions (sending email or Slack
  messages, pushing to GitHub) need approval, also through a plugin.
- The Agent SDK passes `mcpServers` to its engine as `--mcp-config <json>` on
  the command line (ADR-013), so anything secret in a server config would be
  in `ps` output. A stdio server the engine spawns itself inherits the
  engine's environment, which holds the per-Run hook token.
- orbitd stays loopback-only; nothing listens publicly.

Options considered for plugin servers:

1. **The engine spawns them** (`--mcp-config` stdio entries with `env`).
   Secrets would sit in the engine's MCP config (argv for the SDK engine), the
   servers would inherit the engine's environment (hook token, and in API-key
   mode whatever the engine scrubs or does not), and Orbit could not check a
   call against its policy before the server runs it.
2. **orbitd spawns them and proxies them to the engine** through the endpoint
   Orbit's own tools already use (`/mcp/…` with a per-segment token for the
   CLI engine, in-process SDK servers for the SDK engine, direct calls for the
   MockDriver).

## Decision

**Option 2.**

**Manifest** (`orbit-plugin.json`, zod `PluginManifest` in `@orbit/core`):
`id` (lowercase, no `_`, not `orbit`), name, version, description, the
server (`stdio`: command + args, with `${node}`, `${tsx}` and `${pluginDir}`
placeholders; or `http`: an `https` URL, or `http` on loopback, with header
values that may name `${secret:NAME}`), its **tools with fixed tiers** (and
`egress: true` for tools that send Bot-chosen data to arbitrary hosts), the
**secrets** it needs (by name), owner **settings** (non-secret values such as
allowed folders or domains) and an **env allowlist** of variable names copied
from orbitd's own environment. The schema refuses env, secret and setting
names that could carry credentials or change how a process loads code
(`ANTHROPIC_*`, `CLAUDE_*`, `ORBIT_*`, AWS and Google credentials,
`NODE_OPTIONS`, `LD_*`, `DYLD_*`, …).

**Registry and loader** (`@orbit/runtime/src/plugins`): the reference
plugins under `plugins/*` are known to every orbitd; the owner can add more
by directory (`orbit plugin add <dir>`). A plugin is **disabled until the owner
enables it**. Enabling starts the server once (a check: `initialize` +
`tools/list`), stores the input schemas of the declared tools that the server
really offers, and records the manifest's hash. Tools the server offers but the
manifest does not declare are never shown to a Bot. If the manifest changes
afterwards, the plugin stops being offered until the owner looks at it and
enables it again. A Bot uses a plugin only when its spec lists it
(`BotSpec.plugins`); the owner's Bot config, not the plugin, decides.

**Secrets.** A plugin's secret `NAME` is the vault entry
`plugin_<id>_<NAME>` (set with `orbit plugin secret <id> <NAME>` or in
Settings → Integrations). The namespace means a manifest can only ever name
secrets the owner stored for that plugin — never the owner's other secrets or
another plugin's. Values are registered with the process redactor like every
vault value, so they never reach events, logs or the model.

**Processes.** A plugin server is started by orbitd, lazily, on the first
allowed call of a Run segment, with `cwd` = the Bot's workspace, and stopped
when the segment ends (one process per plugin per segment: no state leaks
between Bots or Runs). Its environment is `buildChildEnv('plugin', …)`: the
base allowlist (PATH, HOME, locale, temp, proxies), the manifest's env names,
its settings, its own secrets (except those with `"scope": "orbit"`, which
only orbitd uses) and Orbit's own context: `ORBIT_WORKSPACE`, a worktree
Bot's `ORBIT_GIT_REPO` / `ORBIT_GIT_BRANCH`, and `ORBIT_DENIED_PATHS` (the
credential stores the engine sandbox denies, `/proc`, `/sys` and
`$ORBIT_HOME`) — never an API key, OAuth token, hook or MCP token. Processes it starts in turn (git, a browser) get the
same environment or a narrower one.

**Policy.** Plugin tool tiers become exact-name overrides
(`mcp__<id>__<tool>`, no globs) placed **after** `ORBIT_TOOL_TIERS`, so they
can never match Orbit's own tools or built-ins, and an unknown tool is still
denied. A declared tier can remove a heuristic false positive (a read that
looks like a write) but cannot lower a tool below the floor its name sets
(`tierFloor`): a name that moves money stays FINANCIAL; a name that sends,
writes, creates, changes, runs or clicks anything stays at least EXTERNAL,
because a plugin runs outside the Bot's sandbox; drafting and a commit stay
at least WRITE_LOCAL; only a name with none of these may be READ. The
Integrations view shows such corrections. The engine sees the manifest's tool
descriptions (pinned by its hash), never what the server says at run time. Plugin output is always untrusted (it taints the Run). `egress`
tools behave like WebFetch: allowed in a clean Run, asked for in a tainted one.

**Calls.** A plugin tool call runs only if Orbit's PreToolUse decision allowed
exactly that tool and canonical input in this segment (the authorization
ADR-013 introduced for Orbit's tools); a Bot that reads its segment token and
calls `/mcp/plugins/<id>` itself gains nothing. The CLI engine reaches
`POST /mcp/plugins/<id>` (same per-segment token, same 0600 `--mcp-config`
file, Origin refused); the SDK engine gets one in-process server per plugin;
the MockDriver calls the binding directly and replays the recording for
plugins that are not enabled (demo mode).

**Git commits from worktree Bots** (M2 deferral): the GitHub plugin's
`git_commit` (WRITE_LOCAL: a commit on the Bot's own `orbit/<bot>` branch)
and `git_push` (EXTERNAL) run git in the plugin process, outside the engine
sandbox. The repository and branch are the ones Orbit names
(`ORBIT_GIT_REPO`, `ORBIT_GIT_BRANCH`); git runs with an explicit `GIT_DIR`
(the worktree's entry in the owner's repository, found by its back-pointer to
the workspace) and `GIT_WORK_TREE`, so the workspace's `.git` file — which
the Bot can rewrite to point at a repository and configuration of its own —
is never read. Hooks are disabled (`core.hooksPath=/dev/null`), signatures
are neither made nor shown, and push credentials pass through `GIT_CONFIG_*`
environment variables, never on a command line. Commits and pushes happen
only with exactly the Bot's branch checked out; `git_push` names the branch
and the commit sha (so the approval card shows both), pushes exactly that
sha, and never forces.

**Inbound triggers** (`TriggerSpec` kinds `webhook`, `slack`, `file`, `git`):

- **Webhooks**: `POST /hooks/<bot>/<trigger>` on orbitd's loopback port (a
  tunnel the owner runs can forward to it; orbitd itself never binds
  elsewhere). The body is read raw (at most 256 KiB) and its HMAC-SHA256 is
  verified **in constant time before anything is parsed or stored**: Orbit's
  style signs `<timestamp>.<body>` (`X-Orbit-Timestamp`, `X-Orbit-Signature:
sha256=…`, five minutes of skew, each signature accepted once); GitHub's
  style (`X-Hub-Signature-256`) is accepted per trigger. GitHub signs only the
  body — not the delivery id or event name — so each signed body is accepted
  once (and each delivery id), per Bot and trigger, remembered 30 days; Orbit
  style's keys are kept a day. A GitHub-style signature has no timestamp, so a
  body captured more than 30 days ago could be replayed: prefer Orbit style
  where the sender supports it. The key is a vault secret (`webhook_<bot>_<trigger>`, minted by
  `orbit trigger webhook-secret`). Every failure answers the same 401. No bearer
  token or cookie is needed or accepted there, and any `Origin` is refused.
- **Slack**: Socket Mode (`apps.connections.open` with the app-level token
  from the Slack plugin's secrets, then a WebSocket Orbit opens outward); no
  public URL (and a `wss://` URL only). Messages and mentions in the
  configured channels start Runs, optionally only from listed `users`; every
  envelope is acknowledged, and channel, user and timestamp must have Slack's
  shapes before they reach a prompt.
- **Who may start Runs on a subscription.** A Claude subscription is for its
  owner's own use. On the subscription engine (CliDriver) a Slack trigger must
  list the Slack users who may start Runs; without `users` it stays "needs
  setup" and starts nothing. With an API key a trigger may leave `users`
  empty. Webhooks are signed with a secret only the owner mints and hands to
  a system they configure.
- **Files and git**: chokidar watches the configured paths (file triggers) or
  a repository's branch ref (git triggers), debounced; a burst of changes is one
  Run. The git a git trigger runs inside orbitd gets forced configuration (no
  fsmonitor, hooks or signature programs, inherited `GIT_*` dropped) and never
  watches a repository inside `$ORBIT_HOME`, where Bots can write.

Everything a trigger delivers is untrusted: the payload, message, file
names or commit subjects go into the prompt inside `<orbit-untrusted
source=…>` tags (our own tags neutralised, size-capped), and the Run starts
tainted with the trigger as its source, so it cannot auto-allow an EXTERNAL
action. Triggers obey the kill switch, a paused Bot, `maxRunsPerDay`, and
never start a Run while the trigger's previous one is still in flight.

**Reference plugins.** The Filesystem plugin refuses `ORBIT_DENIED_PATHS`
(except the Bot's own workspace) and hidden files and folders even inside the
owner's chosen roots, after following symlinks, and fails closed on a
malformed list. Gmail's `send_draft` names the draft's recipients and subject
and sends only a draft that matches them (no Cc or Bcc the approval did not
show). The Browser plugin runs Chromium behind a local filtering proxy that
admits only the owner's allowed domains (DNS rebinding to a private address is
recorded in PLAN §7). Plugin folders inside `$ORBIT_HOME` are refused when
added.

**Verified live** (opt-in, haiku): Claude Code called the Filesystem plugin's
`read_file` through `/mcp/plugins/filesystem` with the per-segment token and
Orbit's PreToolUse authorization (`packages/api/src/m7.live.test.ts`).

## Consequences

- One extra hop (engine → orbitd → plugin) per plugin call, in exchange for
  per-call policy checks, secrets that never touch an engine, and one process
  boundary to review.
- Plugins written for other MCP hosts work unchanged if their manifest
  declares their tools and tiers.
- Demo mode needs no plugin credentials: the Inbox Triage demo replays a
  recorded mailbox, and its send still waits for the owner's approval.
- Slack and webhook payloads always make the Run tainted; owners who want a
  Slack-triggered Bot to post back without approval cannot get that from a
  standing rule (by design, ADR-009).
