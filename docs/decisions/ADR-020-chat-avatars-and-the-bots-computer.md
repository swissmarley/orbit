# ADR-020: A chat-first App: conversations, Bot avatars and the Bot's computer

Status: Accepted (after 0.1)

## Context

Orbit was built to be a self-hosted take on always-on agent products such as
[OpenDots](https://github.com/CopilotKit/OpenDots) (CopilotKit's template for
persistent agents, "each with its own computer") or Grok's bots. The 0.1 App
did not feel like one: it was an operations console with an Inbox, a Bots
grid, Run tables and a Run timeline. Next to OpenDots three things were
missing:

1. **Conversations.** A Run is one task with one prompt. There was no way to
   answer a Bot after a Run ended and have it remember the exchange.
2. **Identity.** Bots were names in tables. OpenDots gives every Dot a face
   that appears in navigation, in the chat header and next to its work.
3. **The computer.** Every Bot already has one: `BotSpec.sandbox` is
   documented as "where the Bot works (its own computer)", a directory, git
   worktree or Docker container. The App showed it only as a config line.

What OpenDots does, and what Orbit takes from it:

| OpenDots                                                                    | Orbit                                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sidebar: Dots, Spaces, conversations; Scheduled, Memories, Settings         | Sidebar: Bots (with avatars), the Bot's conversations; Needs you, Activity, Memory, Settings                                                                                                                  |
| Chat: avatar and status above the messages; composer with send/stop         | The same; the status comes from the Run (working, needs you, paused, usage limit…)                                                                                                                            |
| Tool calls rendered inline ("Opening website", "Saving file")               | The same, built from RunEvents; quiet reads are grouped                                                                                                                                                       |
| Human-in-the-loop card pauses the chat ("Approve & save")                   | Orbit's full approval card inline (approvals are decided only from the full card)                                                                                                                             |
| Computer panel: Browser (live screen, take over), Files, Terminal, Activity | Computer panel: Browser (what the Browser plugin and WebFetch read), Files (the workspace), Terminal (the commands the Bot ran), Activity (every call with its tier and decision); take-over is `orbit shell` |
| Pause all Dots                                                              | Stop all (the global kill switch; it stops, it does not pause)                                                                                                                                                |
| Voice calls, Spaces and pages, Slack threads, Composio                      | Not adopted (Orbit has Slack triggers and plugins)                                                                                                                                                            |

## Decision

### Conversations are chains of Runs

- `POST /v1/bots/{bot}/runs` takes `continues: <run id>`: "this message
  answers that turn". The new Run is an ordinary Run (queue, policy,
  approvals, budgets, kill switches, audit, summaries) that resumes the
  engine session of the conversation and starts with the owner's message as
  its prompt. `orbit run <bot> --continue <run> --prompt …` does the same.
- `run.queued` records `conversationId` (the first Run of the conversation)
  and `continuesRunId`; `RunState` has both. A first Run, and every Run
  logged before this change, is its own conversation (`conversationId` = its
  id). The `runs` projection gets an indexed `conversation_id` column
  (migration 7, backfilled) and `GET /v1/runs?conversation=<id>` lists a
  conversation.
- A message may continue only a top-level Run of the same Bot that has
  **ended** (completed, failed or cancelled) and is the **latest** turn of
  its conversation. A turn that is queued, running, waiting for approval,
  delegating, rate-limited or paused is answered, resumed or stopped first;
  an older turn cannot be forked. orbitd checks and queues synchronously (it
  is the single writer, ADR-010), so two messages cannot continue the same
  turn.
- **Session.** The engine resumes the newest engine session in the chain,
  walking back over turns that never reached an engine (a refused start, a
  budget stop). Without any, the turn starts a fresh session; earlier
  messages that never reached an engine are not replayed.
- **Taint carries over.** The resumed session holds whatever untrusted
  content entered earlier turns, so a continuation starts with the previous
  turn's taint sources (`inheritedTaint`, as for delegation). A
  conversation that read the web stays tainted until it ends.
- **Budgets** stay per Run: every message is a Run with its own per-Run
  limits, and every message counts against the Bot's daily limits
  (`maxRunsPerDay`, `maxCostUsdPerDay`).
- **Memory** is offered with the first turn only (the session keeps it).
- A Run started by a trigger begins its own conversation; the owner may
  continue it (answer a scheduled digest), tainted like the trigger's Run.

### Bot avatars

- `BotSpec.avatar` (optional) is `{ character, color }` from a fixed
  vocabulary in `@orbit/core` (`AVATAR_CHARACTERS`, `AVATAR_COLORS`: 8 × 8).
  Without one, every client derives the same default from the Bot's id
  (`avatarFor`). Changing it is a spec change like any other (a new version).
- The App draws the characters as inline SVG: nothing is fetched or
  uploaded, so the App's CSP is unchanged and an avatar cannot carry content.

### The Bot's computer, read-only in the App

- `GET /v1/bots/{bot}/computer`: what the Bot is doing (idle, working,
  needs you, paused, taken over, stopped), its workspace (kind, path,
  network, repository), an open take-over, and whether it can browse.
- `GET /v1/bots/{bot}/computer/files?path=` lists a workspace directory and
  `GET /v1/bots/{bot}/computer/file?path=` previews a file:
  - relative paths only: no absolute paths, `..`, backslashes or NUL;
  - every component is `lstat`ed and **symbolic links are listed but never
    followed or read** (a Bot could point one at `$ORBIT_HOME/daemon.token`);
    the file is opened with `O_NOFOLLOW` and must be the same inode that was
    checked;
  - `.git` is hidden;
  - previews are capped (256 KiB), binary files are not shown, and text goes
    through the event store's redactor, so a credential the Bot wrote is
    masked as it would be in an event;
  - files written while untrusted content was in a Run are flagged.
- `GET /v1/bots/{bot}/computer/activity` returns the Bot's recent tool
  calls across its Runs, with the decision (tier, allowed, denied, waiting)
  and the redacted result: the Terminal (shell commands), Browser (Browser
  plugin, WebFetch, WebSearch) and Activity tabs.
- All three are GET routes, so viewers may call them (ADR-015); they show
  what Run events already show.
- The App never gets a shell or browser control: commands run only through
  the Bot (and Orbit's policy) or the owner's `orbit shell` (ADR-016, bearer
  token only). The panel shows that command to copy.

### The App

- Chat-first shell: the sidebar lists Bots with their avatars and the
  selected Bot's conversations; the main column is the chat
  (`/chat/$botId?c=<conversation>`); the computer panel opens beside it
  (over it on narrow screens). Needs you, Activity (Runs), Memory, Settings,
  Bot settings and Run details stay, reachable from the sidebar and from
  every chat turn.
- Warm, quiet visual tokens in the spirit of OpenDots, still checked for
  WCAG AA in both themes.
- Model text is rendered with a small markdown subset (paragraphs, lists,
  headings, emphasis, code) into React elements after `scrubControls`:
  never HTML, and links are shown as text, not followed.
- A pending approval appears in the chat as the full approval card; the
  composer waits until it is decided.

## Consequences

- Every message is a Run: the Activity list grows with the chat, and a
  chatty conversation spends `maxRunsPerDay` faster.
- Conversations have no title of their own; the first message is the title.
- In demo mode (MockDriver) a reply replays the scenario's `-resumed`
  transcript when it has one, otherwise the scenario again.
- The Browser tab shows text, not a screen: the Browser plugin reads pages
  as text by design (ADR-019).
- The TUI keeps its Runs-and-Timeline layout; it reads `conversationId` but
  has no chat view yet (PLAN §7).
