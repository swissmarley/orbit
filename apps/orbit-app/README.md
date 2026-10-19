# Orbit App (`@orbit/app`)

The web client of orbitd: React 19, Vite, Tailwind v4, shadcn-style
components on Radix, TanStack Router and Query. It is a thin client: it talks
to orbitd only through `@orbit/sdk-client/browser` (a repo guard enforces it).

It is chat-first (ADR-020): the sidebar lists the Bots with their avatars and
the selected Bot's conversations, the main column is the chat
(`/chat/$botId?c=<conversation>`), and the Bot's computer opens beside it
(Browser, Files, Terminal, Activity; read-only, take-over is `orbit shell`).

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
  Undo (`actions.ts`, incl. `sendMessage`), small persisted UI stores
  (`ui.ts`), and pure, unit-tested logic: chat turns, tool cards and the
  composer's state from Run events (`conversation.ts`), the markdown subset
  of Bot messages (`markdown.ts`, rendered as elements, never HTML; links
  shown, not followed), avatar names (`avatar.ts`), the Inbox key model
  (`inbox.ts`), the timeline builder (`timeline.ts`), diffs, the Create Bot
  proposal (`wizard.ts`), theme.
- `src/components`: `ui/` primitives, the shell (sidebar with Bots and
  conversations, header with connection, queue, usage limit, driver and
  auth), the chat (`chat.tsx`: messages, tool cards, the approval card
  inline, composer), the computer panel (`computer-panel.tsx`), avatars and
  the avatar picker (`avatar.tsx`, inline SVG), the approval card, timeline,
  palette.
- `src/screens`: Chat (the home), Inbox, Bots, Bot detail (incl. Appearance,
  Memory & team), Run (live delegation tree, feedback, what it remembered),
  Runs (Activity), Memory (browse, search, edit, review, delete), New Bot
  (local suggestion or a metered “Ask Claude” proposal, with an avatar),
  Settings (triage usage under Budgets; audit rows as names and links),
  Welcome, sign-in.
- More pure logic: `delegation.ts` (the tree), `audit.ts` (names and links for
  audit rows).
- Statuses, tiers and times come from `@orbit/core/browser` (`vocabulary.ts`),
  shared with the TUI and the CLI.
