import {
  type Bot,
  type MemoryHit,
  type PluginStatus,
  RUN_STATUS,
  type RunEvent,
  type RunState,
  STATUS_LEGEND,
  TERMINAL_RUN_STATUSES,
  scrubControls,
} from '@orbit/core';
import type { Approval, DoctorReport, RouteResponse } from '@orbit/sdk-client';
import {
  PANE_CONTENT_TOP,
  type ScreenLayout,
  approvalsWindow,
  botsWindow,
  inside,
  tabAt,
} from './layout';
import type { MouseEvent } from './mouse';

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
  /** Memories of the Bot whose memory browser is open (newest first, or best match). */
  memories: MemoryHit[];
  /** Whose memories `memories` are (null while loading or closed). */
  memoryBot: string | null;
  /** The delegation tree the tree overlay shows. */
  tree: RouteResponse<'runTree'> | null;
  /** Plugins and inbound triggers (the integrations overlay); null until loaded. */
  plugins: PluginStatus[] | null;
  inbound: RouteResponse<'listTriggers'> | null;
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
  memories: [],
  memoryBot: null,
  tree: null,
  plugins: null,
  inbound: null,
  connected: false,
  loaded: false,
  error: null,
};

export type Overlay =
  /** `back`: the overlay `?` was pressed in (memory browser, tree). */
  | { kind: 'help'; scroll: number; back?: Overlay }
  /** The whole approval card, unclipped: approving always happens from here. */
  | { kind: 'card'; approvalId: string; scroll: number }
  /** `back`: the overlay to return to afterwards (e.g. the memory browser). */
  | {
      kind: 'confirm';
      message: string;
      /** Run on y; none = y only goes `back` (e.g. "discard changes?"). */
      command?: Command;
      back?: Overlay;
      /** Where any other key goes (default: `back`). */
      cancelBack?: Overlay;
    }
  | { kind: 'deny'; approvalId: string; text: string }
  /**
   * The memory browser of one Bot: a list, a memory opened in full, and a
   * search prompt (`search` is non-null while typing).
   */
  | {
      kind: 'memory';
      botId: string;
      index: number;
      open: boolean;
      scroll: number;
      search: string | null;
      query: string;
    }
  /** Editing a memory: Tab switches field, Ctrl-S saves, Esc goes back. */
  | {
      kind: 'memoryEdit';
      memoryId: string;
      field: 'title' | 'body';
      title: string;
      body: string;
      /** Cursor position in the current field. */
      cursor: number;
      /** The text when editing started (Esc asks before throwing changes away). */
      original: { title: string; body: string };
      untrusted: boolean;
      back: Overlay;
    }
  /** The delegation tree of the selected Run. */
  | { kind: 'tree'; runId: string; scroll: number }
  /** Plugins and inbound triggers: a list, one plugin opened in full. */
  | { kind: 'integrations'; index: number; open: boolean; scroll: number }
  /** Credentials are held only while this form is open and cleared before a request. */
  | {
      kind: 'setup';
      mode: 'api' | 'cli' | 'demo';
      model: string;
      apiKey: string;
      forgetApiKey?: boolean;
      field: 'mode' | 'model' | 'apiKey' | 'save';
      busy: boolean;
      status: RouteResponse<'getSetup'> | null;
    };

export interface Ui {
  focus: PaneId;
  botIndex: number;
  /** The Bot the user selected, tracked by id (a new or removed Bot must not move the cursor). */
  botId: string | null;
  /** 0 = the selected Bot's newest Run. */
  runIndex: number;
  /**
   * An older Run the user picked with [ ], tracked by id (a new Run arriving
   * at the top must not move the cursor); null = follow the newest Run.
   */
  runId: string | null;
  approvalIndex: number;
  /** The approval the user selected, tracked by id (indexes shift when cards come and go). */
  approvalId: string | null;
  /** The selected card was replaced under the cursor: decision keys are ignored once. */
  approvalMoved: boolean;
  /** Timeline lines scrolled up from the bottom (0 = follow live). */
  scroll: number;
  overlay: Overlay | null;
  toast: { text: string; tone: 'info' | 'error' } | null;
  /** Mouse reporting is on (orbit tui --mouse, or M). */
  mouse: boolean;
}

export const INITIAL_UI: Ui = {
  focus: 'bots',
  botIndex: 0,
  botId: null,
  runIndex: 0,
  runId: null,
  approvalIndex: 0,
  approvalId: null,
  approvalMoved: false,
  scroll: 0,
  overlay: null,
  toast: null,
  mouse: false,
};

/** Side effects the App performs through the client. */
export type Command =
  | { kind: 'quit' }
  | { kind: 'refresh' }
  | { kind: 'runBot'; botId: string }
  | { kind: 'pauseBot'; botId: string; paused: boolean }
  | { kind: 'stopRun'; runId: string }
  /** Pause a running Run at its next tool call (ADR-016). */
  | { kind: 'pauseRun'; runId: string }
  | { kind: 'resumeRun'; runId: string }
  | { kind: 'approve'; approvalId: string; always: boolean }
  | { kind: 'deny'; approvalId: string; reason: string | null }
  | { kind: 'kill'; on: boolean }
  /** Load (and keep fresh) the memory browser's list. */
  | { kind: 'loadMemory'; botId: string | null; query: string }
  | {
      kind: 'updateMemory';
      memoryId: string;
      patch: { title?: string; body?: string; pinned?: boolean; trusted?: true };
    }
  | { kind: 'deleteMemory'; memoryId: string }
  /** Load (and keep fresh) the delegation tree of a Run; null stops. */
  | { kind: 'loadTree'; runId: string | null }
  | { kind: 'loadIntegrations'; on: boolean }
  | { kind: 'loadSetup' }
  | {
      kind: 'configureSetup';
      body: {
        mode: 'api' | 'cli' | 'demo';
        model: string;
        apiKey?: string;
        forgetApiKey?: boolean;
      };
    }
  | { kind: 'setPlugin'; pluginId: string; enabled: boolean }
  | { kind: 'feedback'; runId: string; rating: 'up' | 'down' }
  /** Turn mouse reporting on or off. */
  | { kind: 'mouse'; on: boolean };

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
  if (ui.runId !== null) {
    const byId = runs.find((r) => r.runId === ui.runId);
    if (byId) return byId;
  }
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

/**
 * The memory under the browser's cursor — only once the list of *this* Bot
 * has loaded, so no key can act on another Bot's memory (UI review M4).
 */
export function selectedMemory(
  data: Data,
  o: { index: number; botId: string },
): MemoryHit | undefined {
  if (data.memoryBot !== o.botId) return undefined;
  return data.memories[Math.min(o.index, data.memories.length - 1)];
}

/** Line and column of a cursor in text. */
function lineCol(text: string, cursor: number): { line: number; col: number; lines: string[] } {
  const lines = text.split('\n');
  let rest = cursor;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i]?.length ?? 0;
    if (rest <= len) return { line: i, col: rest, lines };
    rest -= len + 1;
  }
  return { line: lines.length - 1, col: lines.at(-1)?.length ?? 0, lines };
}

function offsetOf(lines: readonly string[], line: number, col: number): number {
  let n = 0;
  for (let i = 0; i < line; i++) n += (lines[i]?.length ?? 0) + 1;
  return n + Math.min(col, lines[line]?.length ?? 0);
}

const MAX_TITLE = 200;
const MAX_BODY = 8000;

/** The delegation tree as indented lines (parents before children). */
export function treeRows(
  tree: RouteResponse<'runTree'>,
  botName: (id: string) => string,
  current: string,
): {
  text: string;
  tone: (typeof RUN_STATUS)[keyof typeof RUN_STATUS]['tone'];
  current: boolean;
}[] {
  const byId = new Map(tree.runs.map((r) => [r.runId, r]));
  const out: {
    text: string;
    tone: (typeof RUN_STATUS)[keyof typeof RUN_STATUS]['tone'];
    current: boolean;
  }[] = [];
  const seen = new Set<string>();
  const walk = (r: RunState, prefix: string, last: boolean, top: boolean) => {
    if (seen.has(r.runId)) return;
    seen.add(r.runId);
    const s = RUN_STATUS[r.status];
    out.push({
      text: `${top ? '' : `${prefix}${last ? '└─ ' : '├─ '}`}${s.mark} ${s.label}  ${botName(r.botId)}  ${r.runId}${r.runId === current ? '  ← this run' : ''}`,
      tone: s.tone,
      current: r.runId === current,
    });
    const kids = r.children.flatMap((c) => byId.get(c.runId) ?? []);
    kids.forEach((k, i) =>
      walk(k, top ? '' : `${prefix}${last ? '   ' : '│  '}`, i === kids.length - 1, false),
    );
  };
  const root = byId.get(tree.root);
  if (root) walk(root, '', true, true);
  return out;
}

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
  if (o?.kind === 'setup') {
    if (key.escape || (key.ctrl && input === 'c')) return next({ overlay: null });
    if (o.busy) return { ui };
    if (key.ctrl && input === 'r') {
      return next({ overlay: { ...o, busy: true, apiKey: '' } }, { kind: 'loadSetup' });
    }
    const fields: readonly Extract<Overlay, { kind: 'setup' }>['field'][] =
      o.mode === 'api' ? ['mode', 'model', 'apiKey', 'save'] : ['mode', 'model', 'save'];
    const advance = () => {
      const index = fields.indexOf(o.field);
      const step = key.shift ? fields.length - 1 : 1;
      return next({ overlay: { ...o, field: fields[(index + step) % fields.length] ?? 'mode' } });
    };
    const save = () => {
      if (!o.status?.canConfigure) {
        return next({
          toast: {
            text: scrubControls(o.status?.reason ?? 'Wait for the setup status'),
            tone: 'error',
          },
        });
      }
      const model = o.model.trim();
      if (!model)
        return next({ toast: { text: 'Enter a default model, such as sonnet', tone: 'error' } });
      if (
        o.mode === 'api' &&
        !o.apiKey.trim() &&
        !o.status.apiKeyStored &&
        !o.status.doctor.apiCredential
      ) {
        return next({ toast: { text: 'Enter an API key, or choose Demo', tone: 'error' } });
      }
      return next(
        { overlay: { ...o, model, apiKey: '', busy: true } },
        {
          kind: 'configureSetup',
          body: {
            mode: o.mode,
            model,
            ...(o.apiKey.trim() ? { apiKey: o.apiKey.trim() } : {}),
            ...(o.mode === 'demo' && o.forgetApiKey ? { forgetApiKey: true } : {}),
          },
        },
      );
    };
    if (key.ctrl && input === 's') return save();
    if (key.tab) return advance();
    if (key.return) return o.field === 'save' ? save() : advance();
    if (o.field === 'mode') {
      if (input === 'x' && o.mode === 'demo') {
        return next({ overlay: { ...o, forgetApiKey: !o.forgetApiKey } });
      }
      const modes = ['api', 'cli', 'demo'] as const;
      let mode = o.mode;
      if (input === '1' || input === '2' || input === '3')
        mode = modes[Number(input) - 1] ?? o.mode;
      if (key.downArrow || key.rightArrow || input === 'j')
        mode = modes[(modes.indexOf(o.mode) + 1) % modes.length] ?? o.mode;
      if (key.upArrow || key.leftArrow || input === 'k')
        mode = modes[(modes.indexOf(o.mode) + modes.length - 1) % modes.length] ?? o.mode;
      return next({
        overlay: {
          ...o,
          mode,
          apiKey: mode !== o.mode ? '' : o.apiKey,
          forgetApiKey: mode === o.mode && o.forgetApiKey === true,
        },
      });
    }
    if (o.field === 'model' || o.field === 'apiKey') {
      const field = o.field;
      const value = o[field];
      if (key.backspace || key.delete)
        return next({ overlay: { ...o, [field]: value.slice(0, -1) } });
      if (key.ctrl && input === 'u') return next({ overlay: { ...o, [field]: '' } });
      if (input && !key.ctrl) {
        const clean = input.replace(/[^\x20-\x7e]/g, '');
        const limit = field === 'apiKey' ? 4096 : 200;
        return next({ overlay: { ...o, [field]: (value + clean).slice(0, limit) } });
      }
    }
    return { ui };
  }
  if (o?.kind === 'help') {
    if (input === '?' || input === 'q' || key.escape) return next({ overlay: o.back ?? null });
    if (input === 'j' || key.downArrow)
      return { ui: { ...ui, overlay: { ...o, scroll: o.scroll + 1 } } };
    if (input === 'k' || key.upArrow) {
      return { ui: { ...ui, overlay: { ...o, scroll: Math.max(0, o.scroll - 1) } } };
    }
    return { ui };
  }
  if (o?.kind === 'confirm') {
    // Only an explicit y confirms; anything else (Enter included) cancels.
    if (input === 'y') return next({ overlay: o.back ?? null }, o.command);
    return next({
      overlay: o.cancelBack ?? o.back ?? null,
      toast: { text: 'Cancelled', tone: 'info' },
    });
  }
  if (o?.kind === 'tree') {
    if (key.escape || input === 'q' || input === 't')
      return next({ overlay: null }, { kind: 'loadTree', runId: null });
    if (input === '?') return next({ overlay: { kind: 'help', scroll: 0, back: o } });
    if (input === 'j' || key.downArrow)
      return { ui: { ...ui, overlay: { ...o, scroll: o.scroll + 1 } } };
    if (input === 'k' || key.upArrow)
      return { ui: { ...ui, overlay: { ...o, scroll: Math.max(0, o.scroll - 1) } } };
    return { ui };
  }
  if (o?.kind === 'integrations') {
    const list = data.plugins ?? [];
    const at = clamp(o.index, list.length - 1);
    if (key.escape || input === 'q' || input === 'i') {
      if (o.open && !(input === 'i')) return next({ overlay: { ...o, open: false, scroll: 0 } });
      return next({ overlay: null }, { kind: 'loadIntegrations', on: false });
    }
    if (input === '?') return next({ overlay: { kind: 'help', scroll: 0, back: o } });
    if (input === 'j' || key.downArrow) {
      return o.open
        ? { ui: { ...ui, overlay: { ...o, scroll: o.scroll + 1 } } }
        : next({ overlay: { ...o, index: clamp(at + 1, list.length - 1) } });
    }
    if (input === 'k' || key.upArrow) {
      return o.open
        ? { ui: { ...ui, overlay: { ...o, scroll: Math.max(0, o.scroll - 1) } } }
        : next({ overlay: { ...o, index: clamp(at - 1, list.length - 1) } });
    }
    const pl = list[at];
    if (key.return && pl) return next({ overlay: { ...o, index: at, open: true, scroll: 0 } });
    if (input === 'e' && pl) {
      const on = !pl.enabled;
      return next({
        overlay: {
          kind: 'confirm',
          message: on
            ? `Enable ${pl.name}? Orbit starts it once to list its tools; Bots that list "${pl.id}" can then use them (external ones still ask you).`
            : `Disable ${pl.name}? No Bot can use its tools until you enable it again.`,
          command: { kind: 'setPlugin', pluginId: pl.id, enabled: on },
          back: { ...o, index: at },
        },
      });
    }
    return { ui };
  }
  if (o?.kind === 'memoryEdit') {
    const changed = o.title !== o.original.title || o.body !== o.original.body;
    if (key.escape) {
      if (!changed) return next({ overlay: o.back });
      return next({
        overlay: {
          kind: 'confirm',
          message: 'Discard your changes to this memory?',
          back: o.back,
          cancelBack: o,
        },
      });
    }
    if (key.ctrl && input === 's') {
      const title = o.title.trim();
      if (!title) return next({ toast: { text: 'A memory needs a title', tone: 'error' } });
      return next(
        { overlay: o.back },
        {
          kind: 'updateMemory',
          memoryId: o.memoryId,
          patch: { title, body: o.body },
        },
      );
    }
    const value = o.field === 'title' ? o.title : o.body;
    const at = Math.min(o.cursor, value.length);
    const edit = (v: string, cursor: number): KeyResult => ({
      ui: {
        ...ui,
        overlay: { ...o, ...(o.field === 'title' ? { title: v } : { body: v }), cursor },
      },
    });
    const move = (cursor: number): KeyResult => ({
      ui: { ...ui, overlay: { ...o, cursor: Math.max(0, Math.min(cursor, value.length)) } },
    });
    if (key.tab) {
      const field = o.field === 'title' ? 'body' : 'title';
      const len = (field === 'title' ? o.title : o.body).length;
      return { ui: { ...ui, overlay: { ...o, field, cursor: len } } };
    }
    if (key.leftArrow) return move(at - 1);
    if (key.rightArrow) return move(at + 1);
    if (key.upArrow || key.downArrow) {
      if (o.field === 'title') return { ui };
      const { line, col, lines } = lineCol(value, at);
      const target = line + (key.upArrow ? -1 : 1);
      if (target < 0 || target >= lines.length) return { ui };
      return move(offsetOf(lines, target, col));
    }
    if (key.return) {
      if (o.field === 'title') {
        return { ui: { ...ui, overlay: { ...o, field: 'body', cursor: o.body.length } } };
      }
      if (value.length >= MAX_BODY) return { ui };
      return edit(`${value.slice(0, at)}\n${value.slice(at)}`, at + 1);
    }
    if (key.backspace || key.delete) {
      if (at === 0) return { ui };
      return edit(value.slice(0, at - 1) + value.slice(at), at - 1);
    }
    const max = o.field === 'title' ? MAX_TITLE : MAX_BODY;
    if (input && !key.ctrl && value.length + input.length <= max) {
      // Titles are one line.
      const text = o.field === 'title' ? input.replace(/[\r\n]+/g, ' ') : input;
      return edit(value.slice(0, at) + text + value.slice(at), at + text.length);
    }
    return { ui };
  }
  if (o?.kind === 'memory') {
    const m = selectedMemory(data, o);
    if (o.search !== null) {
      if (key.escape) return { ui: { ...ui, overlay: { ...o, search: null } } };
      if (key.return) {
        const query = o.search.trim();
        return next(
          { overlay: { ...o, search: null, query, index: 0, open: false, scroll: 0 } },
          { kind: 'loadMemory', botId: o.botId, query },
        );
      }
      if (key.backspace || key.delete)
        return { ui: { ...ui, overlay: { ...o, search: o.search.slice(0, -1) } } };
      if (input && !key.ctrl && o.search.length < 200)
        return { ui: { ...ui, overlay: { ...o, search: o.search + input } } };
      return { ui };
    }
    if (key.escape || input === 'q') {
      if (o.open) return next({ overlay: { ...o, open: false, scroll: 0 } });
      return next({ overlay: null }, { kind: 'loadMemory', botId: null, query: '' });
    }
    if (input === '?') return next({ overlay: { kind: 'help', scroll: 0, back: o } });
    if (input === 'j' || key.downArrow) {
      return o.open
        ? { ui: { ...ui, overlay: { ...o, scroll: o.scroll + 1 } } }
        : next({ overlay: { ...o, index: clamp(o.index + 1, data.memories.length - 1) } });
    }
    if (input === 'k' || key.upArrow) {
      return o.open
        ? { ui: { ...ui, overlay: { ...o, scroll: Math.max(0, o.scroll - 1) } } }
        : next({ overlay: { ...o, index: clamp(o.index - 1, data.memories.length - 1) } });
    }
    if (input === '/') return next({ overlay: { ...o, search: o.query } });
    if (!m) return { ui };
    if (key.return) return next({ overlay: { ...o, open: true, scroll: 0 } });
    if (input === 'e') {
      return next({
        overlay: {
          kind: 'memoryEdit',
          memoryId: m.id,
          field: 'title',
          title: m.title,
          body: m.body,
          cursor: m.title.length,
          original: { title: m.title, body: m.body },
          untrusted: m.taint.length > 0,
          back: o,
        },
      });
    }
    if (input === 'x') {
      return next({
        overlay: {
          kind: 'confirm',
          message: `Delete the memory "${m.title}"? The Bot forgets it; this cannot be undone.`,
          command: { kind: 'deleteMemory', memoryId: m.id },
          back: { ...o, open: false, scroll: 0 },
        },
      });
    }
    if (input === 'T') {
      if (m.taint.length === 0) return next({ toast: { text: 'Already trusted', tone: 'info' } });
      return next({
        overlay: {
          kind: 'confirm',
          message: `Mark "${m.title}" as reviewed and trusted? Runs may then see it automatically. (Audited.)`,
          command: { kind: 'updateMemory', memoryId: m.id, patch: { trusted: true } },
          back: o,
        },
      });
    }
    if (input === 'P') {
      if (m.taint.length > 0) {
        return next({
          toast: {
            text: 'Only trusted memories can be pinned — review it first (T)',
            tone: 'error',
          },
        });
      }
      return next({}, { kind: 'updateMemory', memoryId: m.id, patch: { pinned: !m.pinned } });
    }
    return { ui };
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
  if (input === 'O') {
    return next(
      {
        overlay: {
          kind: 'setup',
          mode:
            data.doctor?.driver === 'mock' ? 'demo' : data.doctor?.driver === 'cli' ? 'cli' : 'api',
          model:
            data.doctor?.driver === 'mock' ? 'sonnet' : (data.doctor?.models.default ?? 'sonnet'),
          apiKey: '',
          field: 'mode',
          busy: true,
          status: null,
        },
      },
      { kind: 'loadSetup' },
    );
  }
  if (input === 'M') return next({}, { kind: 'mouse', on: !ui.mouse });
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
  if (input === 'i') {
    return next(
      { overlay: { kind: 'integrations', index: 0, open: false, scroll: 0 } },
      { kind: 'loadIntegrations', on: true },
    );
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
    const runs = runsOf(data, bot?.id);
    const at = run ? runs.indexOf(run) : ui.runIndex;
    const runIndex = clamp(at + delta, runCount - 1);
    return next({
      runIndex,
      runId: runIndex === 0 ? null : (runs[runIndex]?.runId ?? null),
      scroll: 0,
    });
  }

  switch (ui.focus) {
    case 'bots': {
      if (down || up) {
        const current = bot ? data.bots.indexOf(bot) : ui.botIndex;
        const botIndex = clamp(current + (down ? 1 : -1), data.bots.length - 1);
        return next({
          botIndex,
          botId: data.bots[botIndex]?.id ?? null,
          runIndex: 0,
          runId: null,
          scroll: 0,
        });
      }
      if (key.return) return next({ focus: 'timeline' });
      if (!bot) return { ui };
      if (input === 'r') {
        return next({ runIndex: 0, runId: null, scroll: 0 }, { kind: 'runBot', botId: bot.id });
      }
      if (input === 'm') {
        return next(
          {
            overlay: {
              kind: 'memory',
              botId: bot.id,
              index: 0,
              open: false,
              scroll: 0,
              search: null,
              query: '',
            },
          },
          { kind: 'loadMemory', botId: bot.id, query: '' },
        );
      }
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
      if (input === 'P') {
        // Not destructive (it resumes where it stopped), so no confirmation.
        if (run.status !== 'running') {
          return next({
            toast: {
              text:
                run.status === 'paused'
                  ? 'Already paused — u resumes it'
                  : 'Only a running Run can be paused (s stops it)',
              tone: 'info',
            },
          });
        }
        return next({}, { kind: 'pauseRun', runId: run.runId });
      }
      if (input === 'u') return next({}, { kind: 'resumeRun', runId: run.runId });
      if (input === 't') {
        return next(
          { overlay: { kind: 'tree', runId: run.runId, scroll: 0 } },
          { kind: 'loadTree', runId: run.runId },
        );
      }
      if (input === '+' || input === '-') {
        if (!TERMINAL_RUN_STATUSES.includes(run.status)) {
          return next({ toast: { text: 'Rate a Run once it has ended', tone: 'info' } });
        }
        return next(
          {},
          { kind: 'feedback', runId: run.runId, rating: input === '+' ? 'up' : 'down' },
        );
      }
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
    P: ['timeline', 'P pauses a running Run from the Timeline — press 2'],
    r: ['bots', 'r runs a Bot from the Bots pane — press 1'],
    p: ['bots', 'p pauses a Bot from the Bots pane — press 1'],
    m: ['bots', "m opens the selected Bot's memory from the Bots pane — press 1"],
    t: ['timeline', 't shows the delegation tree from the Timeline — press 2'],
    '+': ['timeline', '+ / - rate a finished Run from the Timeline — press 2'],
    '-': ['timeline', '+ / - rate a finished Run from the Timeline — press 2'],
  };
  const hint = where[input];
  if (hint && hint[0] !== ui.focus) return next({ toast: { text: hint[1], tone: 'info' } });
  return { ui };
}

/**
 * Pure mouse handling (opt-in): a left click selects the pane, and the Bot,
 * Run or approval row under the pointer; the wheel moves the focused list or
 * scrolls the timeline (or the overlay that is open), exactly like j/k.
 * Nothing that changes state (run, approve, deny, stop) happens on a click:
 * those keep their keys and confirmations. A confirm question, the deny
 * reason and the memory editor ignore the mouse entirely, so a report never
 * cancels a question or types into text.
 */
export function onMouse(ui: Ui, data: Data, ev: MouseEvent, layout: ScreenLayout): KeyResult {
  const o = ui.overlay;
  const typing =
    o?.kind === 'confirm' ||
    o?.kind === 'deny' ||
    o?.kind === 'setup' ||
    o?.kind === 'memoryEdit' ||
    (o?.kind === 'memory' && o.search !== null);
  if (typing) return { ui };
  if (ev.kind === 'wheel') {
    return onKey(ui, data, '', ev.wheel === 'down' ? { downArrow: true } : { upArrow: true });
  }
  // Left press only; overlays are driven by their keys.
  if (ev.kind !== 'press' || ev.button !== 0 || o) return { ui };
  const next = (patch: Partial<Ui>): KeyResult => ({ ui: { ...ui, toast: null, ...patch } });
  if (layout.tabBar && inside(layout.tabBar, ev.x, ev.y)) {
    const pane = tabAt(ev.x - layout.tabBar.x, ui.focus, data.approvals.length);
    return pane ? next({ focus: pane }) : { ui };
  }
  for (const pane of PANES) {
    const rect = layout.panes[pane];
    if (!rect || !inside(rect, ev.x, ev.y)) continue;
    const row = ev.y - rect.y - PANE_CONTENT_TOP;
    if (pane === 'bots' && data.loaded && data.bots.length > 0) {
      const bot = selectedBot(data, ui);
      const at = bot ? data.bots.indexOf(bot) : 0;
      const w = botsWindow(rect.height, data.bots.length, at);
      const target = row >= 0 && row < w.listRows ? data.bots[w.first + row] : undefined;
      if (target) {
        if (target.id === bot?.id) return next({ focus: pane });
        return next({
          focus: pane,
          botIndex: data.bots.indexOf(target),
          botId: target.id,
          runIndex: 0,
          runId: null,
          scroll: 0,
        });
      }
      const runs = runsOf(data, bot?.id);
      const r = row - w.runsTop;
      const run = r >= 0 && r < w.runRows ? runs[r] : undefined;
      if (run) {
        return next({ focus: pane, runIndex: r, runId: r === 0 ? null : run.runId, scroll: 0 });
      }
    }
    if (pane === 'approvals' && data.approvals.length > 0) {
      const w = approvalsWindow(rect.height, data.approvals.length, ui.approvalIndex);
      const target = row >= 0 && row < w.listRows ? data.approvals[w.first + row] : undefined;
      // Selecting is all a click does: deciding still needs the card and its keys.
      if (target) {
        return next({
          focus: pane,
          approvalIndex: w.first + row,
          approvalId: target.id,
          approvalMoved: false,
        });
      }
    }
    return next({ focus: pane });
  }
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
  const runs = runsOf(data, botId ?? undefined);
  // A picked older Run follows its id; when it is gone, fall back to the newest.
  const runAt = sameBot && ui.runId !== null ? runs.findIndex((r) => r.runId === ui.runId) : -1;
  const runId = runAt >= 0 ? ui.runId : null;
  const runIndex =
    runAt >= 0 ? runAt : sameBot && ui.runId === null ? clamp(ui.runIndex, runs.length - 1) : 0;
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
    runId === ui.runId &&
    approvalIndex === ui.approvalIndex &&
    approvalId === ui.approvalId &&
    approvalMoved === ui.approvalMoved &&
    overlay === ui.overlay
  ) {
    return ui;
  }
  return {
    ...ui,
    botIndex,
    botId,
    runIndex,
    runId,
    approvalIndex,
    approvalId,
    approvalMoved,
    overlay,
  };
}

/** Keys shown by the help overlay (single source for docs and the overlay). */
export const HELP: readonly { keys: string; does: string }[] = [
  { keys: 'Tab / Shift-Tab, h l, 1 2 3', does: 'move between Bots, Timeline and Approvals' },
  { keys: 'j k / ↓ ↑', does: 'move the selection (Timeline: scroll)' },
  { keys: '[ ]', does: 'older / newer Run of the selected Bot' },
  { keys: 'r', does: 'run the selected Bot now' },
  { keys: 'p', does: 'pause / resume the selected Bot' },
  { keys: 's', does: 'stop the selected Run (Timeline)' },
  { keys: 'P', does: 'pause the running Run at its next tool call (Timeline)' },
  { keys: 'u', does: 'resume a parked, paused or rate-limited Run (Timeline)' },
  { keys: 't', does: 'delegation tree of the Run (Timeline)' },
  { keys: '+ / -', does: 'rate a finished Run (Timeline)' },
  { keys: 'm', does: "the selected Bot's memory (Bots pane)" },
  { keys: 'Enter / (memory)', does: 'open a memory / search memories' },
  { keys: 'e  x (memory)', does: 'edit / delete (asks first)' },
  { keys: 'T  P (memory)', does: 'mark reviewed and trusted / pin' },
  { keys: 'Ctrl-S (editing)', does: 'save; Tab: title or text; Esc: back' },
  { keys: 'g G', does: 'Timeline top / follow live' },
  { keys: 'Enter / a', does: 'open the whole card; a there approves' },
  { keys: 'A (in the card)', does: 'approve and always allow this tool for the Bot (7 days)' },
  { keys: 'd', does: 'deny, with a reason the Bot will see' },
  { keys: 'i', does: 'integrations: plugins and inbound triggers' },
  { keys: 'O', does: 'set up an engine, credentials and the default model' },
  { keys: 'Enter  e (integrations)', does: 'open a plugin / enable or disable it (asks first)' },
  { keys: 'K', does: 'global kill switch (asks first; only y confirms)' },
  { keys: 'R', does: 'refresh' },
  {
    keys: 'M',
    does: 'mouse on / off: click selects, wheel scrolls',
  },
  { keys: 'Enter', does: 'Bots: open the Timeline · Approvals: open the card' },
  { keys: 'Esc', does: 'close a card, prompt or this help' },
  { keys: 'y', does: 'confirm a question (any other key cancels)' },
  { keys: '?', does: 'this help (j/k scroll)' },
  { keys: 'q, Ctrl-C', does: 'quit (Bots keep running in orbitd)' },
];

/** The Timeline keys for a paused Run, as the pause banner spells them (see `onKey`). */
export const PAUSED_RUN_KEYS = 'u resumes · s stops';

/** Terminal commands the help overlay lists after the keys (they are not keys). */
export const CLI_HELP: readonly { command: string; does: string }[] = [
  { command: 'orbit setup', does: 'guided engine setup (API key, existing login or demo)' },
  { command: 'orbit shell <bot>', does: "take over the Bot's workspace" },
  { command: 'orbit approve <id> --edit …', does: 'edit a call, then approve it' },
  { command: 'orbit tui --mouse', does: 'start with the mouse on' },
];

/** Status symbols (also spelled out next to Runs), for the help overlay. */
export const LEGEND: readonly { mark: string; means: string }[] = [
  ...STATUS_LEGEND,
  { mark: '⚑n', means: 'n approvals pending for this Bot' },
];
