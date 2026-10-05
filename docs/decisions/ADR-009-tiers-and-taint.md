# ADR-009: Risk tiers, MCP heuristics and taint

Status: Accepted (M2)

## Context

Default-deny needs a tier for every tool call: READ (auto), WRITE_LOCAL (auto
inside the sandbox), EXTERNAL (approval) and FINANCIAL (never executed).
Built-in tools are known; MCP tools are not until plugin manifests declare
them (M7).

## Decision

- Built-ins have fixed tiers. Unknown non-MCP tools are denied.
- Shell tools are WRITE_LOCAL only when the sandbox reports `shellContained`
  (native engine sandbox or a container, both without network); otherwise
  EXTERNAL.
- MCP tools: plugin overrides first; otherwise verb heuristics on the tool
  name in this order — money-moving verb anywhere → FINANCIAL; leading read
  verb with no send verb → READ; send verb (or leading post/email/reply…) →
  EXTERNAL (FINANCIAL with a financial noun: `send_payment`); commit verb +
  financial noun → FINANCIAL; draft verbs → WRITE_LOCAL; anything else →
  EXTERNAL. Ambiguity always resolves to the riskier tier.
- Taint: tools that bring third-party content in (WebFetch, WebSearch, MCP
  reads and drafts) mark the Run tainted when allowed. In a tainted Run no
  standing rule can auto-allow an EXTERNAL action; the approval card lists
  the untrusted sources. Results of actions (EXTERNAL/FINANCIAL) do not taint.
- PostToolUse tells the model, for untrusted sources, to treat the output as
  data only, and replaces any vault secret or credential pattern in tool
  output with a redaction marker before the model sees it.
- Standing rules are user-authored only; allow rules can never cover
  FINANCIAL tools or `*`. One-shot grants from approvals are bound to
  (Run, Bot, tool, exact input hash).

## Consequences

- Heuristics err on the side of asking; plugin manifests (M7) remove false
  positives such as reads that need approval.

## Amendments after the M2 safety review

- Every allowed MCP or shell call taints the Run (its output comes from a
  third-party system), unless a plugin override marks the tool trusted.
- In a tainted Run, WebFetch and WebSearch ask (they could carry data out in a
  URL or query); `dangerouslyDisableSandbox` is always denied.
- READ needs a leading read verb and nothing else (no conjunctions, no
  mutating verb); WRITE_LOCAL drafting allows only create/save/update/edit as
  additional verbs; `query` is not a read. The financial vocabulary includes
  capture, sell, donate, tip, bid, book and commit verbs on financial nouns.
- Allow rules must name one tool or `mcp__<server>__<prefix>*`; allow rules
  created from the CLI expire after 7 days unless `--expires never`.
- Bash stays EXTERNAL everywhere until the native engine sandbox has been
  verified live (and, in Docker, until the API key is kept out of the
  container).

## Amendment in M8 (injection corpus)

- A leading read verb no longer makes a name READ when a destructive, shell
  or code-running word follows it (`get_rm`, `view_eval`, `fetch_curl`, in
  snake, camel or kebab case): those words (`ACTING_WORDS` in `tiers.ts`)
  count as mutating verbs, so such a name is EXTERNAL, and a draft verb next
  to one is not drafting (`purge_drafts`). Words that are usually nouns
  (`format`, `system`, `clone`, `mail`) stay out of the list, so reads such
  as `get_system_info` keep READ. The plugin floor (ADR-014) uses the same
  list; one table test covers both functions.
