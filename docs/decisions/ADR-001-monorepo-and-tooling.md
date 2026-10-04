# ADR-001: Monorepo layout and tooling

Status: Accepted (M0)

## Context

The brief prescribes a pnpm TypeScript monorepo with `packages/*`,
`apps/orbit-app`, `apps/orbit-tui` and `plugins/*`, and three deliverables
(`orbitd`, `orbit-app`, `orbit`). It does not say where the daemon's
composition root lives.

## Decision

- Add **`apps/orbitd`** as the daemon's composition root (config loading,
  dependency wiring, HTTP server start, signal handling). Business logic stays
  in `packages/*`; `apps/orbitd` stays thin. _(Deviation: additive.)_
- Internal packages are consumed **as TypeScript source** (`"exports"` points
  at `src/index.ts`). Vite, Vitest and `tsx` compile on the fly; `tsup`
  bundles publishable artifacts only (M8). No build step in the inner loop.
- TypeScript **6.0.x** (pinned: `typescript-eslint` 8.71 supports `<6.1.0`;
  revisit the native TypeScript 7 compiler when type-aware linting supports
  it), `strict` + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes`, ESM only, `moduleResolution: bundler`.
- ESLint 9 flat config + typescript-eslint (type-aware) + Prettier. ESLint
  was chosen over Biome because we rely on `no-restricted-syntax` /
  `no-restricted-imports` rules for security invariants (credential paths,
  hardcoded model IDs).
- Vitest with one project per package (`vitest.config.ts` at root).
- HTTP framework: **Hono** (small, fast, first-class zod/OpenAPI and SSE).

## Consequences

- Fast feedback, a single `pnpm check` gate.
- Apps must be bundled for distribution (tsup / Vite) — handled in M8.
