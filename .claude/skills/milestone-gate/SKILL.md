---
name: milestone-gate
description: Close an Orbit milestone (M0–M8) — run the full check, get the safety review, update PLAN.md and CLAUDE.md, commit with Conventional Commits and produce the milestone report. Use whenever a milestone's scope is implemented.
---

# Milestone gate

1. **Green build.** Run `pnpm check` (format, lint, typecheck, tests). Fix
   everything; never skip or disable a test to get green.
2. **Safety review.** Launch the `safety-reviewer` subagent with the
   milestone's base ref. Fix every FAIL that is in scope; re-run step 1.
3. **UI review** (M4, M5 and any UI change). Launch `ui-polish-reviewer`;
   fix high-impact issues.
4. **Docs.** Update `docs/PLAN.md` (status line, milestone ✅, deferrals table
   with target milestone), `CLAUDE.md` (new commands, conventions) and add an
   ADR for any decision that deviates from the brief.
5. **Commit.** Conventional Commits, one logical commit per slice
   (`feat(runtime): …`, `test(policy): …`, `docs: …`, `chore: …`).
6. **Report** to the user, briefly:
   - **Shipped** — what exists now
   - **Run it** — exact commands
   - **Verified** — which tests/checks prove what
   - **Next** — the next milestone and any open question
