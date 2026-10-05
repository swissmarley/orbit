import type { Bot, RunEvent, RunState } from '@orbit/core';
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
  error: null,
};

export type Overlay =
  | { kind: 'help' }
  | { kind: 'confirm'; message: string; command: Command }
  | { kind: 'deny'; approvalId: string; text: string };

export interface Ui {
  focus: PaneId;
  botIndex: number;
  /** 0 = the selected Bot's newest Run. */
  runIndex: number;
  approvalIndex: number;
  /** Timeline lines scrolled up from the bottom (0 = follow live). */
  scroll: number;
  overlay: Overlay | null;
  toast: { text: string; tone: 'info' | 'error' } | null;
}

export const INITIAL_UI: Ui = {
  focus: 'bots',
  botIndex: 0,
  runIndex: 0,
  approvalIndex: 0,
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
  return data.approvals[Math.min(ui.approvalIndex, data.approvals.length - 1)];
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
    return input === '?' || input === 'q' || key.escape ? next({ overlay: null }) : { ui };
  }
  if (o?.kind === 'confirm') {
    if (input === 'y' || key.return) return next({ overlay: null }, o.command);
    if (input === 'n' || key.escape) return next({ overlay: null });
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
  if (input === '?') return next({ overlay: { kind: 'help' } });
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
        const botIndex = clamp(ui.botIndex + (down ? 1 : -1), data.bots.length - 1);
        return next({ botIndex, runIndex: 0, scroll: 0 });
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
        return next({
          approvalIndex: clamp(ui.approvalIndex + (down ? 1 : -1), data.approvals.length - 1),
        });
      }
      const approval = selectedApproval(data, ui);
      if (!approval) break;
      if (input === 'a')
        return next({}, { kind: 'approve', approvalId: approval.id, always: false });
      if (input === 'A') {
        return next({
          overlay: {
            kind: 'confirm',
            message: `Always allow ${approval.toolName} for ${approval.card.botName} (7 days)?`,
            command: { kind: 'approve', approvalId: approval.id, always: true },
          },
        });
      }
      if (input === 'd')
        return next({ overlay: { kind: 'deny', approvalId: approval.id, text: '' } });
      break;
    }
  }
  return { ui };
}

/** Keep selections valid after the data changed (Bots or approvals disappeared). */
export function reconcile(ui: Ui, data: Data): Ui {
  const botIndex = clamp(ui.botIndex, data.bots.length - 1);
  const runIndex = clamp(ui.runIndex, runsOf(data, data.bots[botIndex]?.id).length - 1);
  const approvalIndex = clamp(ui.approvalIndex, data.approvals.length - 1);
  if (botIndex === ui.botIndex && runIndex === ui.runIndex && approvalIndex === ui.approvalIndex)
    return ui;
  return { ...ui, botIndex, runIndex, approvalIndex };
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
  { keys: 'a', does: 'approve the selected card' },
  { keys: 'A', does: 'approve and always allow this tool for the Bot (7 days)' },
  { keys: 'd', does: 'deny, with a reason the Bot will see' },
  { keys: 'K', does: 'global kill switch (asks first)' },
  { keys: 'R', does: 'refresh' },
  { keys: '?', does: 'this help' },
  { keys: 'q', does: 'quit (Bots keep running in orbitd)' },
];
