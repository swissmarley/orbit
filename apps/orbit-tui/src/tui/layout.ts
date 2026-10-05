import type { Overlay, PaneId } from './model';

/**
 * Screen geometry of the TUI, in terminal cells (0-based). The views size
 * their panes and list windows with these functions and the mouse hit test
 * reads the same numbers, so a click lands on the row that is drawn there.
 */

/** Narrower than this, the TUI shows one pane at a time with a tab bar. */
export const NARROW_COLUMNS = 100;

/** Rows above a pane's content: its border and its title. */
export const PANE_CONTENT_TOP = 2;

export const DENY_TITLE = 'Deny — reason the Bot will see (Enter sends, Esc cancels):';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenLayout {
  columns: number;
  rows: number;
  narrow: boolean;
  /** Rows of the prompt or hint line below the body. */
  footer: number;
  /** Rows between the status bar and the footer. */
  bodyHeight: number;
  paneHeight: number;
  sideWidth: number;
  rightWidth: number;
  /** Where each visible pane is drawn (narrow: only the focused one). */
  panes: Partial<Record<PaneId, Rect>>;
  /** The narrow layout's tab bar. */
  tabBar: Rect | null;
}

/** Rows a bordered prompt with `text` takes at `width`. */
export function promptHeight(text: string, width: number): number {
  return 2 + Math.max(1, Math.ceil(text.length / Math.max(10, width - 4)));
}

/** Rows below the body: a confirm or deny prompt, else the one-line hint. */
export function footerHeight(overlay: Overlay | null, columns: number): number {
  if (overlay?.kind === 'confirm') return promptHeight(`${overlay.message} [y/N]`, columns);
  if (overlay?.kind === 'deny') {
    return (
      promptHeight(DENY_TITLE, columns) +
      Math.ceil((overlay.text.length + 3) / Math.max(10, columns - 4))
    );
  }
  return 1;
}

export function screenLayout(
  columns: number,
  rows: number,
  overlay: Overlay | null,
  focus: PaneId,
): ScreenLayout {
  const narrow = columns < NARROW_COLUMNS;
  const footer = footerHeight(overlay, columns);
  const bodyHeight = Math.max(3, rows - 1 - footer);
  const paneHeight = Math.max(3, bodyHeight - (narrow ? 1 : 0));
  const sideWidth = Math.max(24, Math.floor(columns * 0.26));
  const rightWidth = Math.max(30, Math.floor(columns * 0.34));
  // The status bar is row 0; the body starts below it.
  const panes: Partial<Record<PaneId, Rect>> = narrow
    ? { [focus]: { x: 0, y: 2, width: columns, height: paneHeight } }
    : {
        bots: { x: 0, y: 1, width: sideWidth, height: paneHeight },
        timeline: {
          x: sideWidth,
          y: 1,
          width: columns - sideWidth - rightWidth,
          height: paneHeight,
        },
        approvals: { x: columns - rightWidth, y: 1, width: rightWidth, height: paneHeight },
      };
  return {
    columns,
    rows,
    narrow,
    footer,
    bodyHeight,
    paneHeight,
    sideWidth,
    rightWidth,
    panes,
    tabBar: narrow ? { x: 0, y: 1, width: columns, height: 1 } : null,
  };
}

/** The slice of a list a pane shows so that the selected row stays visible. */
function listWindow(rows: number, count: number, at: number): { listRows: number; first: number } {
  return { listRows: rows, first: Math.max(0, Math.min(at - rows + 1, count - rows)) };
}

/**
 * The Bots pane: bot rows from the top of the content, then a blank line,
 * the "Runs" header and up to `runRows` Runs of the selected Bot.
 */
export function botsWindow(
  height: number,
  count: number,
  at: number,
): { listRows: number; first: number; runRows: number; runsTop: number } {
  const listRows = Math.max(1, Math.min(count, Math.floor((height - 3) / 2)));
  return {
    ...listWindow(listRows, count, at),
    runRows: Math.max(0, height - 5 - listRows),
    // Rows from the content top to the first Run: the bot rows, a margin, the header.
    runsTop: listRows + 2,
  };
}

/** The Approvals pane: one row per pending card, then the selected card's detail. */
export function approvalsWindow(
  height: number,
  count: number,
  at: number,
): { listRows: number; first: number } {
  return listWindow(Math.min(count, Math.max(1, Math.floor((height - 3) / 3))), count, at);
}

const TAB_TITLES: Record<PaneId, string> = {
  bots: 'Bots',
  timeline: 'Timeline',
  approvals: 'Approvals',
};

/** The narrow layout's tabs, as drawn (the hit test measures the same strings). */
export function tabLabels(
  focus: PaneId,
  pending: number,
): { pane: PaneId; label: string; focused: boolean }[] {
  return (['bots', 'timeline', 'approvals'] as const).map((p, i) => ({
    pane: p,
    focused: p === focus,
    label: ` ${p === focus ? '▶' : ''}${i + 1} ${TAB_TITLES[p]}${p === 'approvals' && pending ? ` (${pending})` : ''} `,
  }));
}

/** The tab under column `x`, if any. */
export function tabAt(x: number, focus: PaneId, pending: number): PaneId | null {
  let start = 0;
  for (const t of tabLabels(focus, pending)) {
    // Every character of a label is one UTF-16 unit and one cell wide.
    const end = start + t.label.length;
    if (x >= start && x < end) return t.pane;
    start = end;
  }
  return null;
}

export function inside(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}
