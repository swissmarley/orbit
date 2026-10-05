import { type Bot, type RunEvent, type RunState, STATUS_LEGEND } from '@orbit/core';
import type { Approval, DoctorReport, RouteResponse } from '@orbit/sdk-client';

/**
 * The TUI's model: what orbitd told us (`Data`) and what the user is looking
 * at (`Ui`). Key handling is a pure function of both (`onKey`), so every
 * binding is unit-tested without a terminal; the Ink components only render.
 */

export type PaneId = 'bots' | 'timeline' | 'approvals';
export const PANES: readonly PaneId[] = ['bots', 'timeline', 'approvals'];

export interface Data {
  bots: Bot[];
  /** Newest first, all Bots. */
  runs: RunState[];
  /** Pending approvals, oldest first ("what needs you"). */
  approvals: Approval[];
  doctor: DoctorReport | null;
  queue: RouteResponse<'queue'> | null;
  kill: { engaged: boolean; by: string | null } | null;
  /** Events of the selected Run, in order. */
  events: RunEvent[];
  connected: boolean;
  /** The first load finished (until then: "connecting…", never empty states). */
  loaded: boolean;
  error: string | null;
}

export const EMPTY_DATA: Data = {
  bots: [],
  runs: [],
  approvals: [],
  doctor: null,
  queue: null,
  kill: null,
  events: [],
  connected: false,
  loaded: false,
  error: null,
};

export type Overlay =
  | { kind: 'help'; scroll: number }
  /** The whole approval card, unclipped: approving always happens from here. */
  | { kind: 'card'; approvalId: string; scroll: number }
  | { kind: 'confirm'; message: string; command: Command }
  | { kind: 'deny'; approvalId: string; text: string };

export interface Ui {
  focus: PaneId;
  botIndex: number;
  /** The Bot the user selected, tracked by id (a new or removed Bot must not move the cursor). */
  botId: string | null;
  /** 0 = the selected Bot's newest Run. */
  runIndex: number;
  approvalIndex: number;
  /** The approval the user selected, tracked by id (indexes shift when cards come and go). */
  approvalId: string | null;
  /** The selected card was replaced under the cursor: decision keys are ignored once. */
  approvalMoved: boolean;
  /** Timeline lines scrolled up from the bottom (0 = follow live). */
  scroll: number;
  overlay: Overlay | null;
  toast: { text: string; tone: 'info' | 'error' } | null;
}

export const INITIAL_UI: Ui = {
  focus: 'bots',
  botIndex: 0,
  botId: null,
  runIndex: 0,
  approvalIndex: 0,
  approvalId: null,
  approvalMoved: false,
  scroll: 0,
  overlay: null,
  toast: null,
};

/** Side effects the App performs through the client. */
export type Command =
  | { kind: 'quit' }
  | { kind: 'refresh' }
  | { kind: 'runBot'; botId: string }
  | { kind: 'pauseBot'; botId: string; paused: boolean }
  | { kind: 'stopRun'; runId: string }
  | { kind: 'resumeRun'; runId: string }
  | { kind: 'approve'; approvalId: string; always: boolean }
  | { kind: 'deny'; approvalId: string; reason: string | null }
  | { kind: 'kill'; on: boolean };

/** The subset of Ink's Key the bindings use. */
export interface KeyInfo {
  tab?: boolean;
  shift?: boolean;
  escape?: boolean;
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  ctrl?: boolean;
}

export function selectedBot(data: Data, ui: Ui): Bot | undefined {
  if (ui.botId !== null) {
    const byId = data.bots.find((b) => b.id === ui.botId);
    if (byId) return byId;
  }
  return data.bots[Math.min(ui.botIndex, data.bots.length - 1)];
}

export function runsOf(data: Data, botId: string | undefined): RunState[] {
  return botId ? data.runs.filter((r) => r.botId === botId) : [];
}

export function selectedRun(data: Data, ui: Ui): RunState | undefined {
  const runs = runsOf(data, selectedBot(data, ui)?.id);
  return runs[Math.min(ui.runIndex, runs.length - 1)];
}

export function selectedApproval(data: Data, ui: Ui): Approval | undefined {
  if (ui.approvalId !== null) return data.approvals.find((a) => a.id === ui.approvalId);
  return data.approvals[Math.min(ui.approvalIndex, data.approvals.length - 1)];
}

/** Confirmation text for "always allow" (says how broad it is). */
export function alwaysAllowMessage(a: Approval): string {
  return `Always allow ${a.toolName} for ${a.card.botName}, with any arguments, for 7 days? (Runs that read untrusted content still ask.)`;
}

const clamp = (n: number, max: number) => Math.max(0, Math.min(n, Math.max(0, max)));

export interface KeyResult {
  ui: Ui;
  command?: Command;
}

/** Pure key handling: (ui, data, key) → next ui and an optional command. */
export function onKey(ui: Ui, data: Data, input: string, key: KeyInfo): KeyResult {
  const next = (patch: Partial<Ui>, command?: Command): KeyResult => ({
    ui: { ...ui, toast: null, ...patch },
    ...(command ? { command } : {}),
  });

  // ── overlays capture input ───────────────────────────────────────────────
  const o = ui.overlay;
  if (o?.kind === 'help') {
    if (input === '?' || input === 'q' || key.escape) return next({ overlay: null });
    if (input === 'j' || key.downArrow)
      return { ui: { ...ui, overlay: { ...o, scroll: o.scroll + 1 } } };
    if (input === 'k' || key.upArrow) {
      return { ui: { ...ui, overlay: { ...o, scroll: Math.max(0, o.scroll - 1) } } };
    }
    return { ui };
  }
  if (o?.kind === 'confirm') {
    // Only an explicit y confirms; anything else (Enter included) cancels.
    if (input === 'y') return next({ overlay: null }, o.command);
    return next({ overlay: null, toast: { text: 'Cancelled', tone: 'info' } });
  }
  if (o?.kind === 'card') {
    const card = data.approvals.find((a) => a.id === o.approvalId);
    if (key.escape || input === 'q' || !card) return next({ overlay: null });
    if (input === 'j' || key.downArrow)
      return { ui: { ...ui, overlay: { ...o, scroll: o.scroll + 1 } } };
    if (input === 'k' || key.upArrow) {
      return { ui: { ...ui, overlay: { ...o, scroll: Math.max(0, o.scroll - 1) } } };
    }
    if (input === 'a') {
      return next({ overlay: null }, { kind: 'approve', approvalId: card.id, always: false });
    }
    if (input === 'A') {
      return next({
        overlay: {
          kind: 'confirm',
          message: alwaysAllowMessage(card),
          command: { kind: 'approve', approvalId: card.id, always: true },
        },
      });
    }
    if (input === 'd') return next({ overlay: { kind: 'deny', approvalId: card.id, text: '' } });
    return { ui };
  }
  if (o?.kind === 'deny') {
    if (key.escape) return next({ overlay: null });
    if (key.return) {
      const reason = o.text.trim();
      return next(
        { overlay: null },
        { kind: 'deny', approvalId: o.approvalId, reason: reason || null },
      );
    }
    if (key.backspace || key.delete)
      return { ui: { ...ui, overlay: { ...o, text: o.text.slice(0, -1) } } };
    if (input && !key.ctrl && o.text.length < 500) {
      return { ui: { ...ui, overlay: { ...o, text: o.text + input } } };
    }
    return { ui };
  }

  // ── global keys ──────────────────────────────────────────────────────────
  if (input === 'q' || (key.ctrl && input === 'c')) return next({}, { kind: 'quit' });
  if (input === '?') return next({ overlay: { kind: 'help', scroll: 0 } });
  if (input === 'R') return next({}, { kind: 'refresh' });
  if (key.tab) {
    const i = PANES.indexOf(ui.focus);
    const step = key.shift ? PANES.length - 1 : 1;
    return next({ focus: PANES[(i + step) % PANES.length] ?? 'bots' });
  }
  if (input === '1' || input === '2' || input === '3') {
    return next({ focus: PANES[Number(input) - 1] ?? 'bots' });
  }
  if (input === 'h' || key.leftArrow) {
    return next({ focus: PANES[Math.max(0, PANES.indexOf(ui.focus) - 1)] ?? 'bots' });
  }
  if (input === 'l' || key.rightArrow) {
    return next({
      focus: PANES[Math.min(PANES.length - 1, PANES.indexOf(ui.focus) + 1)] ?? 'approvals',
    });
  }
  if (input === 'K') {
    const engaged = data.kill?.engaged === true;
    return next({
      overlay: {
        kind: 'confirm',
        message: engaged
          ? 'Release the global kill switch? Bots may run again.'
          : 'Engage the global kill switch? Every Run stops and nothing new starts.',
        command: { kind: 'kill', on: !engaged },
      },
    });
  }

  const down = input === 'j' || key.downArrow;
  const up = input === 'k' || key.upArrow;
  const bot = selectedBot(data, ui);
  const run = selectedRun(data, ui);
  const runCount = runsOf(data, bot?.id).length;

  // Run navigation works from the Bots and Timeline panes.
  if ((input === '[' || input === ']') && ui.focus !== 'approvals') {
    const delta = input === '[' ? 1 : -1; // [ = older
    return next({ runIndex: clamp(ui.runIndex + delta, runCount - 1), scroll: 0 });
  }

  switch (ui.focus) {
    case 'bots': {
      if (down || up) {
        const current = bot ? data.bots.indexOf(bot) : ui.botIndex;
        const botIndex = clamp(current + (down ? 1 : -1), data.bots.length - 1);
        return next({ botIndex, botId: data.bots[botIndex]?.id ?? null, runIndex: 0, scroll: 0 });
      }
      if (key.return) return next({ focus: 'timeline' });
      if (!bot) return { ui };
      if (input === 'r') return next({ runIndex: 0, scroll: 0 }, { kind: 'runBot', botId: bot.id });
      if (input === 'p') {
        const paused = bot.pausedAt === null;
        return next({
          overlay: {
            kind: 'confirm',
            message: paused
              ? `Pause ${bot.spec.name}? Its Runs stop and nothing new starts.`
              : `Resume ${bot.spec.name}?`,
            command: { kind: 'pauseBot', botId: bot.id, paused },
          },
        });
      }
      break;
    }
    case 'timeline': {
      if (down) return next({ scroll: Math.max(0, ui.scroll - 1) });
      if (up) return next({ scroll: ui.scroll + 1 });
      if (input === 'G') return next({ scroll: 0 });
      if (input === 'g') return next({ scroll: Number.MAX_SAFE_INTEGER });
      if (!run) break;
      if (input === 's') {
        return next({
          overlay: {
            kind: 'confirm',
            message: `Stop run ${run.runId}?`,
            command: { kind: 'stopRun', runId: run.runId },
          },
        });
      }
      if (input === 'u') return next({}, { kind: 'resumeRun', runId: run.runId });
      break;
    }
    case 'approvals': {
      if (down || up) {
        const approvalIndex = clamp(ui.approvalIndex + (down ? 1 : -1), data.approvals.length - 1);
        return next({
          approvalIndex,
          approvalId: data.approvals[approvalIndex]?.id ?? null,
          approvalMoved: false,
        });
      }
      const approval = selectedApproval(data, ui);
      if (!approval) break;
      const decision = input === 'a' || input === 'A' || input === 'd' || key.return;
      if (decision && ui.approvalMoved) {
        // The card under the cursor changed since the user looked (decided
        // elsewhere, expired): never act on one they did not choose.
        return next({
          approvalMoved: false,
          toast: { text: 'The selected card changed — review it, then press again', tone: 'error' },
        });
      }
      // Approving always goes through the full, unclipped card.
      if (input === 'a' || input === 'A' || key.return) {
        return next({ overlay: { kind: 'card', approvalId: approval.id, scroll: 0 } });
      }
      if (input === 'd')
        return next({ overlay: { kind: 'deny', approvalId: approval.id, text: '' } });
      break;
    }
  }
  // A pane-specific key pressed elsewhere: say where it works instead of ignoring it.
  const where: Record<string, [PaneId, string]> = {
    a: ['approvals', 'a approves in Approvals — press 3'],
    A: ['approvals', 'A (always allow) works in Approvals — press 3'],
    d: ['approvals', 'd denies in Approvals — press 3'],
    s: ['timeline', 's stops a Run from the Timeline — press 2'],
    u: ['timeline', 'u resumes a Run from the Timeline — press 2'],
    r: ['bots', 'r runs a Bot from the Bots pane — press 1'],
    p: ['bots', 'p pauses a Bot from the Bots pane — press 1'],
  };
  const hint = where[input];
  if (hint && hint[0] !== ui.focus) return next({ toast: { text: hint[1], tone: 'info' } });
  return { ui };
}

/**
 * Keep selections valid after the data changed. The approval selection
 * follows its id; when that card disappears the cursor lands on another one
 * and `approvalMoved` makes the next decision key a no-op (review F2).
 */
export function reconcile(ui: Ui, data: Data): Ui {
  // The Bot selection follows its id; when that Bot is gone the cursor stays at its row.
  const botAt = ui.botId === null ? -1 : data.bots.findIndex((b) => b.id === ui.botId);
  const botIndex = botAt >= 0 ? botAt : clamp(ui.botIndex, data.bots.length - 1);
  const botId = data.bots[botIndex]?.id ?? null;
  const sameBot = botId === ui.botId || ui.botId === null;
  const runIndex = sameBot ? clamp(ui.runIndex, runsOf(data, botId ?? undefined).length - 1) : 0;
  let { approvalIndex, approvalId, approvalMoved, overlay } = ui;
  const at = approvalId === null ? -1 : data.approvals.findIndex((a) => a.id === approvalId);
  if (at >= 0) {
    approvalIndex = at;
  } else {
    approvalIndex = clamp(approvalIndex, data.approvals.length - 1);
    const replacement = data.approvals[approvalIndex]?.id ?? null;
    if (approvalId !== null && replacement !== null) approvalMoved = true;
    approvalId = replacement;
  }
  const overlayCard =
    overlay?.kind === 'card' || overlay?.kind === 'deny' ? overlay.approvalId : null;
  if (overlayCard !== null && !data.approvals.some((a) => a.id === overlayCard)) overlay = null;
  if (
    botIndex === ui.botIndex &&
    botId === ui.botId &&
    runIndex === ui.runIndex &&
    approvalIndex === ui.approvalIndex &&
    approvalId === ui.approvalId &&
    approvalMoved === ui.approvalMoved &&
    overlay === ui.overlay
  ) {
    return ui;
  }
  return { ...ui, botIndex, botId, runIndex, approvalIndex, approvalId, approvalMoved, overlay };
}

/** Keys shown by the help overlay (single source for docs and the overlay). */
export const HELP: readonly { keys: string; does: string }[] = [
  { keys: 'Tab / Shift-Tab, h l, 1 2 3', does: 'move between Bots, Timeline and Approvals' },
  { keys: 'j k / ↓ ↑', does: 'move the selection (Timeline: scroll)' },
  { keys: '[ ]', does: 'older / newer Run of the selected Bot' },
  { keys: 'r', does: 'run the selected Bot now' },
  { keys: 'p', does: 'pause / resume the selected Bot' },
  { keys: 's', does: 'stop the selected Run (Timeline)' },
  { keys: 'u', does: 'resume a parked or rate-limited Run (Timeline)' },
  { keys: 'g G', does: 'Timeline top / follow live' },
  { keys: 'Enter / a', does: 'open the whole card; a there approves' },
  { keys: 'A (in the card)', does: 'approve and always allow this tool for the Bot (7 days)' },
  { keys: 'd', does: 'deny, with a reason the Bot will see' },
  { keys: 'K', does: 'global kill switch (asks first; only y confirms)' },
  { keys: 'R', does: 'refresh' },
  { keys: 'Enter', does: 'Bots: open the Timeline · Approvals: open the card' },
  { keys: 'Esc', does: 'close a card, prompt or this help' },
  { keys: 'y', does: 'confirm a question (any other key cancels)' },
  { keys: '?', does: 'this help (j/k scroll)' },
  { keys: 'q, Ctrl-C', does: 'quit (Bots keep running in orbitd)' },
];

/** Status symbols (also spelled out next to Runs), for the help overlay. */
export const LEGEND: readonly { mark: string; means: string }[] = [
  ...STATUS_LEGEND,
  { mark: '⚑n', means: 'n approvals pending for this Bot' },
];
