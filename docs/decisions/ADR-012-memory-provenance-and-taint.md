# ADR-012: Memory with provenance, taint that persists, and a metered triage path

Status: Accepted (M6)

## Context

M6 gives Bots memory (notes, post-run summaries, the owner's feedback) and
lets the content of one Run reach later Runs. That is exactly how a prompt
injection becomes persistent: a web page read on Monday writes a "note"
that steers Tuesday's Run. ADR-009 made taint a property of one Run; the M2
safety review (M1) asked for taint to follow content through workspace
files. The brief also wants a post-run summarizer and a Claude-written
Create Bot proposal on the triage model, without ever spending subscription
usage the owner did not expect.

## Decision

**Store.** `@orbit/memory` keeps memories in SQLite (`memories`, migration 4)
with an FTS5 index (`memories_fts`, porter + unicode61, external content kept
in sync by triggers) and mirrors each one as a markdown file with front
matter under `$ORBIT_HOME/memory/<bot>/<id>.md` (0600 in 0700 directories).
orbitd is the only writer; the files are a human-readable mirror and are never
read back. Search text is reduced to quoted word tokens before it reaches
FTS5, so no operator or column filter can be injected. Every title and body
goes through the process redactor before it is stored. A Bot keeps at most
1000 memories; when full, the oldest Bot note or summary goes first
(untrusted ones before trusted ones) — never the owner's facts or feedback,
never a pinned memory. Control characters are stripped (a NUL would break
every later engine spawn). Deleting a memory deletes its row, its index entry
and its file; the audit log records ids and kinds only, never memory text.
FTS5 is SQLite-specific; a Postgres adapter would use `tsvector` (ADR-007).

**Provenance.** Each memory records its `source` (`owner`, `bot`,
`summarizer`, `feedback`), the Run that wrote it, and `taint`: the untrusted
sources (ADR-009) that were in that Run when it was written. A memory with
taint is _untrusted_; one without is _trusted_. Only the owner can clear
taint, explicitly ("I reviewed it", `orbit memory edit --trust`), and the
audit log records the sources cleared. Editing text never clears taint.
Untrusted memories cannot be pinned.

**Context.** A new Run is offered, within `memory.maxContextChars`, pinned
memories, the latest feedback, memories relevant to the task (FTS over the
prompt) and the latest summaries — **trusted ones only**. The memory section
goes with the first prompt of a Run (on stdin), never on a command line
where other local users could read it; resumed segments already have it.
Every memory reaches the model inside `<orbit-memory source=… trust=… run=…>` tags (our own tags
inside the text are neutralised), after a preamble that says memory is
context, not instructions. Untrusted memories are only counted ("3 more were
influenced by untrusted content"). The Bot can still find them with
`memory_search` / `memory_read`; returning one taints the Run with
`memory:<id>` plus the memory's own sources, so the Run cannot auto-allow an
EXTERNAL action afterwards. `memory_write` stores the Run's current taint
with the note. A Bot can add notes but cannot edit, pin or delete memory.

**Feedback.** Thumbs (with an optional comment), approvals, edited approvals
and denials become `feedback` memories whose text Orbit composes from
Orbit-controlled facts (tool name, Run id) and the owner's own words (deny
reason, comment, edited values). Model-written card text is never quoted, and
the task of a delegated Run (written by another Bot) is left out. Feedback is
injected like any memory: tagged, as data.

**Taint through workspace files** (closes M2 review M1). When a tainted Run
writes a file (Write, Edit, MultiEdit, NotebookEdit) Orbit marks the path in
`workspace_taint` with the Run's sources. A Run that reads a marked file
(Read, NotebookRead), or searches a directory containing one (Grep, Glob, LS),
is tainted with `file:<path>` plus those sources — at permission time, before
the content reaches the model. A shell that can bring outside content in (no
containment) or runs while the Run is already tainted marks the whole
workspace (`*`), because Orbit cannot know which files it touched. An
untainted Run that rewrites a whole file (Write) clears that file's mark.
Paths are canonical (symlinks resolved like the policy's file checks, case
folded on case-insensitive volumes), so a file has one key. The owner can
clear the marks after checking the files (Bot → Memory & team,
audited).

**Triage path.** Post-run summaries have three modes per Bot:
`result` (default: the Run's own final answer, no model call, free), `triage`
(one call to `ORBIT_TRIAGE_MODEL`), `off`. The Create Bot proposal is an
explicit button that states what it calls and on which credentials before it
is pressed. Both go through one `TriagePath`: a call is refused while the
global kill switch or a usage-limit hold is active, refused once
`triage.maxCallsPerDay` (default 20, `ORBIT_TRIAGE_MAX_CALLS_PER_DAY`, 0 = off)
calls were made since local midnight, run one at a time, and recorded with its
tokens and cost (`triage_calls`) — failed calls too, since they may have
spent. Usage is shown in Settings → Budgets, `orbit triage`, the Run timeline
(`memory.summarized`) and the wizard. A triage call is a driver run with every
tool disabled, one turn and a deny-all permission handler, in an empty
`$ORBIT_HOME/triage` directory, so it uses exactly the credentials and child
environment of a Run (CliDriver: the user's own `claude`; never an API key or
OAuth token passed by Orbit). The summary of a tainted Run inherits its taint.
In demo mode a deterministic local engine answers for free. Summaries are
written after the Run's outcome (`memory.written`, `memory.summarized` follow
`run.completed`) and never change it.

## Consequences

- A Bot that once read the web does not become permanently tainted: its
  next Run starts clean and is offered only trusted memory. It becomes
  tainted only if it pulls untrusted memory or a marked file in.
- Shell use without containment marks the whole workspace until the owner
  clears it; until the native engine sandbox is verified live (PLAN §7),
  Bash is EXTERNAL anyway and every approved command does this.
- Memory text is model-written: clients render it as text (React escapes it;
  the TUI and CLI scrub control characters), never as HTML or markdown.
- Default `summarize: result` keeps memory useful without any model spend;
  the triage modes are opt-in and capped.
