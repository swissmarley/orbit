# ADR-016: Run pause, interrupted-Run retry and terminal take-over

Status: Accepted (M8)

## Context

PLAN §7 deferred three related controls to M8:

- **Per-Run pause.** Until now the owner could stop a Run, resume a parked or
  rate-limited one, or pause a whole Bot. The engine has no suspend, so a
  pause has to be a park without an approval.
- **Retry of interrupted Runs.** A Run that orbitd stopped under (a daemon
  stop or crash) ended as `run.failed: interrupted`. Retrying it
  automatically needs an answer for tool side effects whose outcome is
  unknown.
- **Take-over terminal.** The Run view was to attach to the Bot's workspace
  shell over an authenticated WebSocket pty. A shell bypasses Orbit's policy
  engine by design, so it needs its own safety story.

ADR-003 (park and resume), ADR-008 (one permission path for every tool call),
ADR-010 (single writer, restart recovery, queue holds) and ADR-013 (kill
switches carry across delegation) are the parts this builds on.

## Decision

### Per-Run pause

- `POST /v1/runs/{run}/pause` with `{ now?: boolean }` (CLI `orbit pause
<run> [--now]`, TUI `P` in the Timeline, App "Pause run" / "Pause now").
  Only a Run executing in orbitd can be paused. A queued, parked, delegating,
  rate-limited, paused or ended Run is refused with a hint (`orbit stop`,
  `orbit bot pause`, or `orbit resume` for a paused one); a Run between two
  segments gets `conflict` ("pause it again in a moment").
- The request is an event, `run.pause_requested { by, now }`, and an audit
  record. A second request is a no-op; `now` upgrades an open request.
- **At the next tool-call decision** (the shared permission handler, so both
  drivers, subagent calls, Orbit's tools and plugin calls alike) Orbit denies
  that call with interrupt, exactly like an approval park: the engine stops
  with `continue: false`, the segment ends `run.paused { reason: owner,
toolUseId, toolName }` and the concurrency slot is free. Every later call
  in the segment is denied too, so an engine that ignores `continue: false`
  still cannot act.
- A request that meets no further tool call **lapses**: the segment ends as
  it would have (completed, parked, failed, rate-limited) and the timeline
  shows `run.pause_lapsed`. That includes a segment that parks on an approval
  the engine was already waiting for in the park window: a decision already
  in progress completes, and deciding the approval is the owner's own act.
- **`now`** aborts the engine like `stop` (process group kill) but the Run
  ends `paused` (`interruptedTurn: true`), not `cancelled`.
- A pause keeps the Run's pending approvals pending; resuming waits for them
  (as for parked Runs). Nothing resumes a paused Run by itself.
- **Resume** is the existing resume path (`orbit resume`, `run.resumed {
reason: pause }`). The resumed prompt says who paused the Run and which
  call did not run; after `now` it says the last turn was cut off and that a
  tool call without a result may or may not have happened and must be
  verified before it is repeated. Without a known engine session the prompt
  carries the task again.
- **Kill switches.** Stop, Bot pause and the global kill switch close paused
  Runs like other parked Runs. Paused Runs count as in flight, so a trigger
  whose previous Run is paused does not fire again.
- **Delegation.** A delegating parent is not running and cannot be paused
  (the hint points at its children). Pausing a running child pauses only
  that child; the parent stays `delegating` until the child ends (the owner
  resumes or stops it). Stopping the parent stops the paused child.
- **Budgets.** Wall-clock budgets count active engine time, which already
  left parked time out (`totals.activeMs` folds the engine's reported
  durations). Paused time is treated the same way. A segment the engine
  could not report (cut off by `now` or an interruption) adds the time Orbit
  measured (`run.paused.activeMs`; at crash recovery, first to last event of
  the segment), so pausing cannot stretch the wall-clock budget. Resuming
  checks every per-Run and daily budget as before.

### Retry of interrupted Runs

- `BotSpec.onInterrupt: 'resume' | 'fail'` (default `resume`). With `fail`
  the old outcome stays: `run.failed: interrupted`, retryable.
- With `resume`, a Run orbitd stopped under is closed with `run.paused {
reason: interrupted, by: system }` and an audit record (`run.interrupted`).
  It is **safe to retry** only when all of these hold, and Orbit then
  resumes it through the queue (resume priority boost, `run.resumed {
reason: interrupted }`):
  - its engine session id is known;
  - fewer than 2 earlier interruptions of this Run (`INTERRUPT_RETRY_LIMIT`,
    `RunState.interruptions`);
  - no call in the interrupted segment that Orbit allowed at a tier reaching
    outside the workspace (`EXTERNAL`, or no tier recorded) is missing its
    `tool.result`. Such a call is an outside side effect whose outcome is
    unknown.
- Otherwise it stays `paused` with `autoResume: false` and an Orbit-written
  `detail` that names the reason (for example "send_email (toolu_…) was
  allowed but has no result, so it may or may not have happened"). The owner
  decides: `orbit resume` or `orbit stop`.
- **Deviation:** the plan described crash recovery only. A graceful stop
  (`orbit daemon stop`, SIGTERM) applies the same rule when it aborts a
  segment, because the old terminal `run.failed` would leave nothing to
  retry. The next start resumes the Runs it marked safe.
- The resumed prompt says the previous segment was interrupted and that the
  engine must verify the state of any unanswered tool call (and of the named
  one) before repeating it. Pending approvals of the interrupted segment are
  closed as before (the engine asks again); taint and remaining budgets carry
  over because they are folded from the log.
- **Kill switch or paused Bot at startup:** nothing continues. Runs left
  running end `run.failed: interrupted` (today's rule), and Runs a graceful
  stop paused for a retry are cancelled, as Runs waiting when a kill switch
  is engaged are. Children of a Run left running are stopped (ADR-013).

### Take-over without a browser pty

- `orbit shell <bot>`: the CLI asks orbitd for a take-over
  (`POST /v1/bots/{bot}/takeover { pid }`), spawns the owner's `$SHELL`
  (fallback `/bin/sh`) in the Bot's workspace, waits, then ends it
  (`DELETE /v1/bots/{bot}/takeover`).
- **Bearer token only.** Both routes refuse anything but the local bearer
  token: an App session cookie gets 403, and so would a hosted principal once
  hosted mode exists. The App's
  Run view and Bot detail only show a "Take over" dialog with the exact
  command, a copy button and one sentence: the browser does not open a shell
  because what is typed there would bypass Orbit's policy engine. The TUI
  shows the command under the selected Bot and in its help.
- **Refused** while a Run of the Bot is running or being started (hint:
  `orbit pause <run>` or `orbit stop <run>`), while one is parked on an
  approval mid-tool-call (its approved call would run against changed files;
  hint: decide it or `orbit stop`), and for Docker-sandbox Bots (hint:
  `docker exec -it orbit-bot-… sh`). Queued, delegating, rate-limited and
  paused Runs are allowed and wait. **Deviation:** the brief said "parked
  mid-tool"; pausing is the natural way to prepare a take-over, so a paused
  Run does not count as one.
- **Hold.** orbitd reuses the Bot-pause hold (`pausedAt`): no Run of the Bot
  starts or resumes, the queue names the take-over as the hold, and a manual
  Run is refused with "taken over". The take-over record (pid, start, whether
  the Bot was paused before) lives in the controls table, so it survives a
  daemon restart. Ending it releases the hold unless the Bot was paused
  before or the owner paused it during the take-over. Both ends are audited
  (`takeover.started`, `takeover.ended` with `stale`, `via`, `released`).
- **Stale take-overs.** orbitd checks the recorded CLI pid (`kill(pid, 0)`;
  `EPERM` counts as alive). A new `orbit shell` ends a take-over whose
  process is gone and keeps the hold under the new one; a live one is
  refused. `orbit bot resume` ends any take-over of the Bot: it is the
  owner's explicit choice and the way out when a pid was reused.
- **Environment.** The shell gets the `tool` allowlist plus `ORBIT_TAKEOVER=1`:
  no API key, no OAuth variables, no `ORBIT_*` (so no Orbit token or home).
  The owner's own files remain readable to the owner, as always. Git
  variables: see the amendment below.
- Files the owner edits are the owner's: no taint is added or cleared.

### Vocabulary and events

- New events: `run.pause_requested`, `run.pause_lapsed`, `run.paused` (a
  segment end, like `run.parked`); `run.resumed.reason` gains `pause` and
  `interrupted`. `RunState` gains `pauseRequested`, `pause` and
  `interruptions`.
- `RUN_STATUS.paused` ("⏸ paused") and `pauseReason()` / `pauseNextStep()`
  give every client the same words. The CLI exits 11 (`ExitCode.paused`) when
  a followed Run ends paused.

## Consequences

- A pause costs one engine resume, like an approval park; a `now` pause or an
  interruption costs a turn whose tool calls may have to be re-checked.
- An interrupted Run is never repeated blindly: anything that may have
  reached outside the machine waits for the owner.
- The take-over is honest about what it is: the owner working in the Bot's
  workspace outside Orbit's policy, from a terminal, with the Bot held.
- Fixed on the way: the auth middleware now keys a request's sign-in kind by
  its context. The body limit replaces the raw request on requests with a
  body, so token-only checks on such routes could not see how they signed in.
- Not done here: the App inbox lists approvals only, not Runs paused for the
  owner (they show in Run lists and the Run view with the paused vocabulary);
  a parent interrupted in the same segment as its delegation does not wait
  for the child after a retry. Real-engine behaviour of the pause rests on the
  `continue: false` park verified live in M1/M2.

## Amendment (M8 safety review): git in the take-over shell

**Context.** A Bot's contained Bash (and its file tools) may write anything
in its workspace, including the `.git` entry. A Bot could point it at a
repository of its own whose configuration runs programs (`core.fsmonitor`,
`core.hooksPath`, filters, `core.pager`, …). The owner's shell opens in that
workspace, and a git-aware prompt runs `git status` before the owner types
anything: the Bot's program would run as the owner, outside every sandbox.

**Decision.** Before `POST /v1/bots/{bot}/takeover` hands the workspace over
(after the hold is taken, before the take-over is recorded; a refusal undoes
the hold), orbitd checks the workspace's `.git` (`prepareTakeoverGit` in
`@orbit/sandbox`):

- **Worktree Bot.** The worktree entry Orbit created is found in the owner's
  repository by its `gitdir` back-pointer (never through the workspace). The
  workspace's `.git` must be a regular file whose only line is `gitdir:`
  leading to exactly that entry. Anything else — another target, extra lines,
  a symlink, a directory, nothing — is moved aside to
  `.git.orbit-replaced-<time>` (never deleted: it may hold the Bot's work)
  and Orbit's file is written back; the audit records
  `takeover.git_restored { workspace, was, movedTo }`. A workspace that is no
  longer a registered worktree is refused (start a Run to prepare it again).
  The response carries `git: { dir, workTree, restored }`, and the CLI
  exports `GIT_DIR` and `GIT_WORK_TREE` with exactly those values, so git in
  the shell never consults the workspace's `.git` at all — nor a repository
  the Bot nested in a subfolder (discovery is off while `GIT_DIR` is set).
- **Directory Bot.** Orbit made no repository there, so any `.git` is the
  Bot's. The take-over is **refused** (`conflict`) with a hint to look at it
  without git and move it from outside the workspace (`cat …/.git/config`,
  `mv …/.git …git-from-bot`). Considered: renaming it aside automatically.
  Refusing is the safer choice — Orbit neither changes a Bot's own files
  behind its back nor leaves the owner guessing where its repository went —
  and the hint's commands run outside the workspace, so no prompt reads the
  repository. Inherited `GIT_DIR`, `GIT_WORK_TREE` and `GIT_COMMON_DIR` are
  removed from a directory Bot's shell.
- **Both.** `GIT_CEILING_DIRECTORIES` is the workspace's parent, so git never
  walks up into `$ORBIT_HOME`. The owner's own global git configuration
  stays in effect (no `GIT_CONFIG_NOSYSTEM`). The banner prints one line
  saying which applies (and when a changed `.git` was put back).

**Consequences.** A worktree Bot's `.git` file is always Orbit's when a
take-over starts, and the take-over shell's git reads only the owner's
repository. Residual: in a directory Bot's workspace a repository the Bot
nested in a subfolder is found by git once the owner `cd`s into it (the
banner says there is no repository Orbit made); programs that ignore
`GIT_DIR` (an editor launched with a clean environment) follow the
workspace's `.git` as restored by Orbit. The worktree entry itself lies
outside the workspace: the engine sandbox does not make it writable, and the
plugin sandbox keeps its `commondir`, `gitdir` and `config.worktree`
read-only (ADR-019).
