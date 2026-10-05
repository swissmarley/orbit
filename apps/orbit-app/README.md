# Orbit App (`@orbit/app`)

The web client of orbitd: React 19, Vite, Tailwind v4, shadcn-style
components on Radix, TanStack Router and Query. It is a thin client: it talks
to orbitd only through `@orbit/sdk-client/browser` (a repo guard enforces it).

## Use it

```sh
pnpm --filter @orbit/app build   # once (orbitd serves apps/orbit-app/dist)
pnpm orbit app                   # opens the App with a one-time sign-in link
```

orbitd serves the App on its own loopback origin. `orbit app` mints a
single-use ticket (valid 2 minutes) and opens `/login#ticket=…`; the page trades
it for an HttpOnly session cookie. The API token never enters the browser
(ADR-011). Restarting orbitd signs every browser out.

## Develop

```sh
ORBIT_ALLOWED_ORIGINS=http://localhost:5173 ORBIT_DRIVER=mock pnpm orbit daemon restart
pnpm --filter @orbit/app dev                       # Vite on :5173, proxies /v1 to orbitd
pnpm orbit app --origin http://localhost:5173      # sign the dev server in
pnpm --filter @orbit/app storybook                 # components and design tokens
```

## Test

```sh
pnpm test --project @orbit/app     # unit + component tests (the real API service in-process) + stories with axe
pnpm test:e2e                      # build, then Playwright against a real orbitd (mock driver, ORBIT_PORT=0) + axe in both themes
pnpm --filter @orbit/app exec tsx scripts/screenshots.ts <dir>   # screenshots of every screen for review
```

## Layout

- `src/lib`: the client and session (`api.ts`), queries and query keys, the
  live SSE feed (`live.ts`), every write with optimistic updates, toasts and
  Undo (`actions.ts`), and pure, unit-tested logic: the Inbox key model
  (`inbox.ts`), the timeline builder (`timeline.ts`), diffs, the Create Bot
  proposal (`wizard.ts`), theme.
- `src/components`: `ui/` primitives, the approval card, timeline, shell
  (header with connection, queue, usage limit, driver and auth), palette.
- `src/screens`: Inbox, Bots, Bot detail (incl. Memory & team), Run (live
  delegation tree, feedback, what it remembered), Runs, Memory (browse,
  search, edit, review, delete), New Bot (local suggestion or a metered “Ask
  Claude” proposal), Settings (triage usage under Budgets; audit rows as names
  and links), Welcome, sign-in.
- More pure logic: `delegation.ts` (the tree), `audit.ts` (names and links for
  audit rows).
- Statuses, tiers and times come from `@orbit/core/browser` (`vocabulary.ts`),
  shared with the TUI and the CLI.
