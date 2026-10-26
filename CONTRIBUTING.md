# Contributing to Orbit

Thanks for your interest in Orbit. Bug reports, fixes, documentation
improvements and well-scoped features are welcome.

For a security issue, **do not open a public issue**: see
[`SECURITY.md`](SECURITY.md).

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on
  the approach.
- Read [`CLAUDE.md`](CLAUDE.md): it is the contributor guide, with the layout,
  conventions, security invariants and every command.
- Architecture decisions live in [`docs/decisions/`](docs/decisions/). A change
  that deviates from an existing decision needs a new ADR.
- Orbit's security model is documented in [`docs/security.md`](docs/security.md).
  Changes must not weaken it.

## Setup

Requirements: Node >= 22.13 (see `.nvmrc`) and pnpm 10 (via corepack).

```sh
corepack enable
pnpm install
pnpm check              # format:check + lint + typecheck + test
```

No credentials are needed. Tests and CI use `ORBIT_DRIVER=mock`; never add a
test that needs a real API key or a Claude login to the default suite. Tests
that talk to the real engine are `*.live.test.ts` and run only with
`pnpm test:live`.

Useful commands:

```sh
pnpm test --project @orbit/core        # one package
pnpm lint:fix && pnpm format           # fix lint and formatting
pnpm test:e2e                          # App against a real orbitd (mock driver)
pnpm orbit doctor                      # run the CLI from source
```

When you pipe `pnpm typecheck`, use `set -o pipefail`, otherwise failures go
unnoticed.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Write tests with the change. Tests sit next to the code as `*.test.ts`. For
   policy, budgets, replay, auth and the driver contract, write the tests first.
3. Run `pnpm check` and make sure it passes.
4. Open a pull request that explains what changes and why.

Keep pull requests focused: one concern per PR.

## Conventions

- TypeScript strict, ESM. Zod schemas are the source of truth for types and
  OpenAPI.
- Adding an API route: contract table first (`packages/api/src/contract.ts`),
  then the handler, then regenerate `openapi.json` with
  `pnpm --filter @orbit/api openapi`.
- Clients talk to `orbitd` only through `@orbit/sdk-client`.
- Every CLI command that prints data takes `--json`.
- No hardcoded model IDs: use `ORBIT_DEFAULT_MODEL` / `ORBIT_TRIAGE_MODEL` or
  the aliases `opus`, `sonnet`, `haiku`.
- Never spread `process.env` into a child process; use the allowlisted env
  builders.
- No TODO stubs in shipped code paths; record deferrals in `docs/PLAN.md` §7.
- A new repo-wide guard in `tools/guards` needs a positive-control test that
  proves it fires.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(runtime): add retry for interrupted runs
fix(policy): refuse tier downgrade below the tool floor
docs: clarify hosted mode setup
test(api): cover role checks on new route
```

## Fixtures and secrets

- Never commit real keys, tokens, `.env` files or the contents of
  `$ORBIT_HOME`.
- Recorded engine fixtures must be scrubbed with
  `packages/runtime/scripts/scrub-fixture.ts` before committing.
- Test values that look like credentials must be obviously fake.

## License

By contributing you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
