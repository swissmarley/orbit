/** @jsxRuntime automatic @jsxImportSource react */
import {
  MEMORY_KIND_WORD,
  MEMORY_SOURCE_WORD,
  PLUGIN_SANDBOX_STATE,
  PLUGIN_STATE,
  type PluginStatus,
  RUN_STATUS,
  TIER_WORD,
  TRIGGER_KIND_WORD,
  TRIGGER_STATE,
  type RunEvent,
  type RunState,
  type Tone,
  formatClock,
  formatLocalTime,
  formatWhen,
  memoryTrust,
  pauseReason,
  slugify,
} from '@orbit/core';
import { Box, Text } from 'ink';
import type { painter } from '../io';
import { clean } from '../commands/approvals';
import { sandboxNeeds } from '../commands/plugins';
import { renderDiff, renderEvent, scrubControls } from '../render';
import type { Approval } from '@orbit/sdk-client';
import {
  type Data,
  HELP,
  LEGEND,
  type PaneId,
  type Ui,
  runsOf,
  selectedApproval,
  selectedBot,
  selectedMemory,
  treeRows,
} from './model';
import { DENY_TITLE, approvalsWindow, botsWindow, tabLabels } from './layout';

export type Paint = ReturnType<typeof painter>;

export { DENY_TITLE, NARROW_COLUMNS, promptHeight } from './layout';

/** Terminal colour for each tone of the shared status vocabulary (16 basic colours). */
export const TONE_COLOR: Record<Tone, string> = {
  neutral: 'gray',
  info: 'cyan',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
  attention: 'magenta',
};

const statusOf = (status: RunState['status']) => {
  const w = RUN_STATUS[status];
  return { ...w, color: TONE_COLOR[w.tone] };
};

const TITLES: Record<PaneId, string> = {
  bots: 'Bots',
  timeline: 'Timeline',
  approvals: 'Approvals',
};

function short(text: string, max: number): string {
  const flat = scrubControls(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

function Pane(props: {
  id: PaneId;
  focused: boolean;
  width: number | string;
  height: number;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <Box
      flexDirection="column"
      // Focus is shown by shape and a marker too, not colour alone.
      borderStyle={props.focused ? 'bold' : 'round'}
      borderColor={props.focused ? 'cyan' : 'gray'}
      width={props.width}
      height={props.height}
      paddingX={1}
      overflow="hidden"
    >
      <Text bold {...(props.focused ? { color: 'cyan' } : {})} wrap="truncate">
        {props.focused ? '▶ ' : ''}
        {TITLES[props.id]}
        {props.badge ? <Text color="magenta"> {props.badge}</Text> : null}
      </Text>
      {props.children}
    </Box>
  );
}

export function StatusBar({ data, width }: { data: Data; width: number }) {
  const d = data.doctor;
  const narrow = width < 60;
  // Most important first: truncation drops the end of the line.
  const parts: React.ReactNode[] = [
    <Text key="brand" bold>
      orbit
    </Text>,
  ];
  if (data.kill?.engaged) {
    parts.push(
      <Text key="kill" color="red" bold>
        ■ KILL SWITCH
      </Text>,
    );
  }
  if (data.queue?.pausedUntil) {
    parts.push(
      <Text key="limit" color="yellow">
        {narrow
          ? `⧗ limit ${formatLocalTime(data.queue.pausedUntil)}`
          : `⧗ usage limit until ${formatLocalTime(data.queue.pausedUntil)}`}
      </Text>,
    );
  }
  parts.push(
    <Text key="conn" color={data.connected ? 'green' : data.loaded ? 'red' : 'gray'}>
      {data.connected ? '● live' : data.loaded ? '○ offline' : '… connecting'}
    </Text>,
  );
  if (data.queue) {
    parts.push(
      <Text key="queue">
        {`${data.queue.active.length}/${data.queue.limit} running${data.queue.queued.length ? ` · ${data.queue.queued.length} queued` : ''}`}
      </Text>,
    );
  }
  parts.push(
    <Text key="driver">
      {d?.driver ? `${d.driver} · ${d.authLabel}` : d ? 'no engine — orbit login-help' : '…'}
    </Text>,
  );
  return (
    <Box width={width}>
      <Box flexGrow={1}>
        <Text wrap="truncate">
          {parts.flatMap((p, i) =>
            i === 0
              ? [p]
              : [
                  <Text key={`s${i}`} color="gray">
                    {' │ '}
                  </Text>,
                  p,
                ],
          )}
        </Text>
      </Box>
      {narrow ? null : <Text color="gray"> ? help</Text>}
    </Box>
  );
}

export function BotsPane(props: {
  data: Data;
  ui: Ui;
  focused: boolean;
  width: number | string;
  height: number;
  inner: number;
}) {
  const { data, ui, inner } = props;
  const bot = selectedBot(data, ui);
  const pendingByBot = new Map<string, number>();
  for (const a of data.approvals) pendingByBot.set(a.botId, (pendingByBot.get(a.botId) ?? 0) + 1);
  const runs = runsOf(data, bot?.id);
  const at = bot ? data.bots.indexOf(bot) : 0;
  const window = botsWindow(props.height, data.bots.length, at);
  const { listRows, first } = window;
  // Focused: the selected Bot's terminal-only action (a take-over; the footer lists the keys).
  const actions = props.focused && bot !== undefined;
  const runRows = Math.max(0, window.runRows - (actions ? 1 : 0));
  return (
    <Pane id="bots" focused={props.focused} width={props.width} height={props.height}>
      {!data.loaded ? (
        <Text color="gray">░░░░░░░░ loading…</Text>
      ) : data.bots.length === 0 ? (
        <Text color="gray" wrap="wrap">
          No bots yet. orbit bot create --name … --goal …
        </Text>
      ) : (
        data.bots.slice(first, first + listRows).map((b, i) => {
          const latest = runsOf(data, b.id)[0];
          const s = latest ? statusOf(latest.status) : null;
          const selected = first + i === at;
          const pending = pendingByBot.get(b.id) ?? 0;
          return (
            <Text key={b.id} wrap="truncate" inverse={selected && props.focused}>
              {selected ? '▸ ' : '  '}
              {b.pausedAt ? (
                <Text color="yellow">⏸ </Text>
              ) : s ? (
                <Text color={s.color}>{s.mark} </Text>
              ) : (
                '  '
              )}
              {short(b.spec.name, inner - 8)}
              {pending > 0 ? <Text color="magenta"> ⚑{pending}</Text> : null}
            </Text>
          );
        })
      )}
      {bot && runRows > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray" wrap="truncate">
            {bot.pausedAt ? '⏸ paused · ' : ''}Runs [ older ] newer
            {runs.length === 0 ? ' — none yet (r runs it)' : ''}
          </Text>
          {runs.slice(0, runRows).map((r, i) => {
            const s = statusOf(r.status);
            return (
              <Text key={r.runId} wrap="truncate" bold={i === ui.runIndex}>
                {i === ui.runIndex ? '› ' : '  '}
                <Text color={s.color}>{s.mark}</Text> {s.label.padEnd(11)}
                <Text color="gray">{formatClock(r.createdAt)}</Text>
              </Text>
            );
          })}
        </Box>
      ) : null}
      {actions ? (
        <>
          <Box flexGrow={1} />
          <Text color="gray" wrap="truncate">
            shell: orbit shell {slugify(bot.spec.name)}
          </Text>
        </>
      ) : null}
    </Pane>
  );
}

/** Timeline text lines of a Run (the same rendering as `orbit logs`). */
export function timelineLines(events: readonly RunEvent[], paint: Paint): string[] {
  const lines: string[] = [];
  let cwd: string | null = null;
  for (const e of events) {
    if (e.type === 'run.started') cwd = e.data.cwd;
    if (e.type === 'run.queued') lines.push(`${paint('bold', '▶')} ${short(e.data.prompt, 200)}`);
    const line = renderEvent(e, paint, cwd);
    if (line !== null) lines.push(...line.split('\n'));
  }
  return lines;
}

export function TimelinePane(props: {
  data: Data;
  run: RunState | undefined;
  ui: Ui;
  focused: boolean;
  width: number | string;
  height: number;
  paint: Paint;
}) {
  const { run, ui } = props;
  const lines = timelineLines(props.data.events, props.paint);
  const visible = Math.max(1, props.height - 4 - (run?.status === 'paused' && run.pause ? 1 : 0));
  const maxScroll = Math.max(0, lines.length - visible);
  const scroll = Math.min(ui.scroll, maxScroll);
  const end = lines.length - scroll;
  const shown = lines.slice(Math.max(0, end - visible), end);
  const s = run ? statusOf(run.status) : null;
  return (
    <Pane id="timeline" focused={props.focused} width={props.width} height={props.height}>
      {run && s ? (
        <Text wrap="truncate" color="gray">
          {run.runId} · <Text color={s.color}>{s.label}</Text>
          {run.resumeAt ? ` · resumes ${formatLocalTime(run.resumeAt)}` : ''}
          {run.pauseRequested ? ' · ⏸ pause requested' : ''}
          {scroll > 0 ? ` · ↑${scroll}` : ''}
        </Text>
      ) : (
        <Text color="gray">No run selected. Pick a Bot and press r to run it.</Text>
      )}
      {run?.status === 'paused' && run.pause ? (
        <Text color="yellow" wrap="truncate">
          ⏸ {short(pauseReason(run.pause), 200)}
        </Text>
      ) : null}
      {shown.map((l, i) => (
        <Text key={i} wrap="truncate">
          {l}
        </Text>
      ))}
    </Pane>
  );
}

export function ApprovalsPane(props: {
  data: Data;
  ui: Ui;
  focused: boolean;
  width: number | string;
  height: number;
  paint: Paint;
}) {
  const { data, ui, paint } = props;
  const approval = selectedApproval(data, ui);
  const { listRows, first } = approvalsWindow(
    props.height,
    data.approvals.length,
    ui.approvalIndex,
  );
  const detail = approval ? cardLines(approval, paint, 'truncate') : [];
  const room = Math.max(0, props.height - 5 - listRows - (props.focused ? 1 : 0));
  return (
    <Pane
      id="approvals"
      focused={props.focused}
      width={props.width}
      height={props.height}
      {...(data.approvals.length ? { badge: `${data.approvals.length} pending` } : {})}
    >
      {!data.loaded ? (
        <Text color="gray">░░░░░░░░ loading…</Text>
      ) : data.approvals.length === 0 ? (
        <Text color="green">✔ Nothing needs you right now.</Text>
      ) : (
        data.approvals.slice(first, first + listRows).map((a, i) => (
          <Text
            key={a.id}
            wrap="truncate"
            inverse={first + i === ui.approvalIndex && props.focused}
          >
            {first + i === ui.approvalIndex ? '▸ ' : '  '}
            {short(clean(a.card.what), 200)}
          </Text>
        ))
      )}
      {approval ? (
        <Box flexDirection="column" marginTop={1}>
          {detail.slice(0, room)}
          {detail.length > room ? (
            <Text color="yellow">… more below — Enter shows the whole card</Text>
          ) : null}
        </Box>
      ) : null}
      {props.focused && approval ? (
        <Text color="gray" wrap="truncate">
          Enter/a open card to approve · d deny
        </Text>
      ) : null}
    </Pane>
  );
}

/** The approval card as lines: what, why, Bot and tier, untrusted sources, payload or diff. */
export function cardLines(
  approval: Approval,
  paint: Paint,
  wrap: 'truncate' | 'wrap',
): React.ReactNode[] {
  const c = approval.card;
  const tierColor = c.tier === 'EXTERNAL' ? 'yellow' : c.tier === 'FINANCIAL' ? 'red' : 'cyan';
  const lines: React.ReactNode[] = [
    <Text key="what" wrap={wrap}>
      <Text bold>{'What '}</Text>
      {clean(c.what)}
    </Text>,
    <Text key="why" wrap={wrap}>
      <Text bold>{'Why  '}</Text>
      {clean(c.why)}
    </Text>,
    <Text key="bot" wrap={wrap}>
      <Text bold>{'Bot  '}</Text>
      {clean(c.botName)} <Text color={tierColor}>{c.tier}</Text>
    </Text>,
  ];
  if (c.untrusted.length) {
    lines.push(
      <Text key="untrusted" color="red" wrap={wrap}>
        ⚠ untrusted input: {clean(c.untrusted.join(', '))}
      </Text>,
    );
  }
  const body = c.diff
    ? renderDiff(c.diff, paint)
    : JSON.stringify(c.payload, null, 2)
        .split('\n')
        .map((l) => clean(l));
  body.forEach((l, i) =>
    lines.push(
      <Text key={`b${i}`} wrap={wrap}>
        {l}
      </Text>,
    ),
  );
  return lines;
}

/** The whole card, wrapped and scrollable; approving happens here. */
export function CardOverlay(props: {
  approval: Approval;
  paint: Paint;
  width: number;
  height: number;
  scroll: number;
}) {
  const lines = cardLines(props.approval, props.paint, 'wrap');
  const room = Math.max(1, props.height - 4);
  const scroll = Math.min(props.scroll, Math.max(0, lines.length - room));
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
      width={props.width}
      height={props.height}
      overflow="hidden"
    >
      <Text bold wrap="truncate">
        Approval {props.approval.id}
        {scroll > 0 ? ` · ↑${scroll}` : ''}
      </Text>
      {lines.slice(scroll)}
      <Box flexGrow={1} />
      <Text color="gray" wrap="truncate">
        a approve · A always allow… · d deny · j/k scroll · Esc back
      </Text>
    </Box>
  );
}

export function HelpOverlay(props: { width: number; height: number; scroll: number }) {
  const stacked = props.width < 60;
  const keyWidth = Math.max(...HELP.map((h) => h.keys.length)) + 2;
  const rows: React.ReactNode[] = [
    ...HELP.map((h) =>
      stacked ? (
        <Box key={h.keys} flexDirection="column">
          <Text color="cyan">{h.keys}</Text>
          <Text wrap="wrap">{`  ${h.does}`}</Text>
        </Box>
      ) : (
        <Text key={h.keys} wrap="truncate">
          <Text color="cyan">{h.keys.padEnd(keyWidth)}</Text>
          {h.does}
        </Text>
      ),
    ),
    <Text key="legend-title" bold>
      Symbols
    </Text>,
    ...LEGEND.map((l) => (
      <Text key={`legend-${l.mark}`} wrap="truncate">
        <Text color="cyan">{l.mark.padEnd(4)}</Text>
        {l.means}
      </Text>
    )),
    <Text key="edit" color="gray" wrap="wrap">
      Edit-then-approve: orbit approve &lt;id&gt; --edit …
    </Text>,
  ];
  const per = stacked ? 2 : 1;
  const room = Math.max(1, Math.floor((props.height - 3) / per));
  const scroll = Math.min(props.scroll, Math.max(0, rows.length - room));
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={stacked ? 1 : 2}
      width={props.width}
      height={props.height}
      overflow="hidden"
    >
      <Text bold wrap="truncate">
        Keys {rows.length > room ? '(j/k scroll · ? or Esc closes)' : '(? or Esc closes)'}
      </Text>
      {rows.slice(scroll, scroll + room)}
    </Box>
  );
}

/** Rows a confirm bar or prompt needs at this width (border + wrapped text). */
export function ConfirmBar({ message, width }: { message: string; width: number }) {
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} width={width}>
      <Text wrap="wrap">
        {message} <Text bold>[y/N]</Text>
      </Text>
    </Box>
  );
}

export function DenyPrompt({ text, width }: { text: string; width: number }) {
  return (
    <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column" width={width}>
      <Text wrap="wrap">{DENY_TITLE}</Text>
      <Text wrap="wrap">
        › {text}
        <Text inverse> </Text>
      </Text>
    </Box>
  );
}

export function TabBar({ focus, pending }: { focus: PaneId; pending: number }) {
  return (
    <Text wrap="truncate">
      {tabLabels(focus, pending).map((t) => (
        <Text key={t.pane} {...(t.focused ? { inverse: true, bold: true } : { color: 'gray' })}>
          {t.label}
        </Text>
      ))}
    </Text>
  );
}

/**
 * Word-wrap to `width` columns (long words are broken), so overlays can count
 * real screen lines and scroll by them.
 */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(4, width);
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let line = '';
    for (const word of raw.split(/(\s+)/)) {
      if (word === '') continue;
      if (line.length + word.length <= w) {
        line += word;
        continue;
      }
      if (line.trim() !== '') out.push(line.trimEnd());
      line = /^\s+$/.test(word) ? '' : word;
      while (line.length > w) {
        out.push(line.slice(0, w));
        line = line.slice(w);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

type MemoryOverlayState = Extract<NonNullable<Ui['overlay']>, { kind: 'memory' }>;

/** The memory browser of one Bot: list with trust in words, a memory in full, search. */
export function MemoryOverlay(props: {
  data: Data;
  overlay: MemoryOverlayState;
  botName: string;
  width: number;
  height: number;
}) {
  const { data, overlay: o } = props;
  const loaded = data.memoryBot === o.botId;
  const m = selectedMemory(data, o);
  const inner = Math.max(10, props.width - 4);
  const room = Math.max(1, props.height - 5);
  const header = (
    <Text bold wrap="truncate">
      Memory · {short(props.botName, 40)}
      {o.query ? <Text color="gray"> · matching “{short(o.query, 30)}”</Text> : null}
      {loaded ? <Text color="gray"> · {data.memories.length} shown</Text> : null}
    </Text>
  );
  const footer = (
    <Text color="gray" wrap="truncate">
      {o.search !== null
        ? 'type · Enter search · Esc cancel'
        : o.open
          ? 'j/k scroll · e edit · x delete · T trust · P pin · ? keys · Esc back'
          : 'j/k · Enter open · / search · e · x · T · P · ? keys · Esc'}
    </Text>
  );
  let body: React.ReactNode[];
  if (!loaded) {
    body = [
      <Text key="loading" color="gray">
        loading…
      </Text>,
    ];
  } else if (o.open && m) {
    const trust = memoryTrust(m);
    const meta = `${MEMORY_KIND_WORD[m.kind]} · by ${MEMORY_SOURCE_WORD[m.source]} · ${formatWhen(m.createdAt)}${m.runId ? ` · run ${m.runId}` : ''}${m.editedAt ? ' · edited by you' : ''}${m.pinned ? ' · pinned' : ''}`;
    const trustLine = `${trust.mark} ${trust.label}${m.taint.length ? ` — from ${clean(m.taint.join(', '))}; never offered to Runs automatically` : ''}`;
    // Every row is one screen line: split, scrub and wrap first (UI review H1).
    const rows: { text: string; color?: string; bold?: boolean }[] = [
      ...wrapText(clean(m.title), inner).map((t) => ({ text: t, bold: true })),
      ...wrapText(meta, inner).map((t) => ({ text: t, color: 'gray' })),
      ...wrapText(trustLine, inner).map((t) => ({ text: t, color: TONE_COLOR[trust.tone] })),
      { text: ' ' },
      ...m.body
        .split('\n')
        .flatMap((l) => wrapText(clean(l), inner))
        .map((t) => ({ text: t })),
    ];
    const scroll = Math.min(o.scroll, Math.max(0, rows.length - room));
    body = rows.slice(scroll, scroll + room).map((r, i) => (
      <Text
        key={i}
        wrap="truncate"
        {...(r.color ? { color: r.color } : {})}
        {...(r.bold ? { bold: true } : {})}
      >
        {r.text || ' '}
      </Text>
    ));
  } else if (data.memories.length === 0) {
    body = wrapText(
      o.query
        ? 'No memories match.'
        : 'No memories yet. Bots remember the result of each finished Run, notes they save, and your feedback (+/- on a Run, edits, denials).',
      inner,
    ).map((t, i) => (
      <Text key={i} color="gray" wrap="truncate">
        {t}
      </Text>
    ));
  } else {
    const top = Math.max(0, Math.min(o.index - Math.floor(room / 2), data.memories.length - room));
    body = data.memories.slice(top, top + room).map((x, i) => {
      const at = top + i === o.index;
      const trust = memoryTrust(x);
      const label = `${trust.mark} ${trust.label}`.padEnd(12);
      const kind = MEMORY_KIND_WORD[x.kind].padEnd(14);
      const when = formatClock(x.createdAt).padEnd(13);
      const titleRoom = Math.max(10, inner - 2 - 12 - 14 - 13 - (x.pinned ? 9 : 0));
      return (
        <Text key={x.id} wrap="truncate" {...(at ? { inverse: true } : {})}>
          {at ? '› ' : '  '}
          <Text color={TONE_COLOR[trust.tone]}>{label}</Text>
          {kind}
          <Text color="gray">{when}</Text>
          {x.pinned ? <Text color="cyan">pinned · </Text> : null}
          {short(x.title, titleRoom)}
        </Text>
      );
    });
  }
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={1}
      width={props.width}
      height={props.height}
      overflow="hidden"
    >
      {header}
      {o.search !== null ? (
        <Text wrap="truncate">
          / {o.search}
          <Text inverse> </Text>
        </Text>
      ) : (
        <Text> </Text>
      )}
      {body}
      <Box flexGrow={1} />
      {footer}
    </Box>
  );
}

const CURSOR = '\uE000';

/** Editing a memory: title and text with a cursor, saved with Ctrl-S. */
export function MemoryEditOverlay(props: {
  overlay: Extract<NonNullable<Ui['overlay']>, { kind: 'memoryEdit' }>;
  width: number;
  height: number;
}) {
  const o = props.overlay;
  const inner = Math.max(10, props.width - 4);
  const withCursor = (text: string, on: boolean) => {
    const clean = scrubControls(text).replaceAll(CURSOR, '');
    const at = Math.min(o.cursor, clean.length);
    return on ? `${clean.slice(0, at)}${CURSOR}${clean.slice(at)}` : clean;
  };
  const render = (line: string, key: number | string) => {
    const i = line.indexOf(CURSOR);
    if (i < 0) {
      return (
        <Text key={key} wrap="truncate">
          {line || ' '}
        </Text>
      );
    }
    const after = line.slice(i + 1);
    return (
      <Text key={key} wrap="truncate">
        {line.slice(0, i)}
        <Text inverse>{after[0] ?? ' '}</Text>
        {after.slice(1)}
      </Text>
    );
  };
  const titleLines = wrapText(withCursor(o.title, o.field === 'title'), inner - 8);
  const bodyLines = wrapText(withCursor(o.body, o.field === 'body'), inner);
  const room = Math.max(1, props.height - 6 - titleLines.length - (o.untrusted ? 1 : 0));
  // Keep the cursor's line in view.
  const cursorLine = Math.max(
    0,
    bodyLines.findIndex((l) => l.includes(CURSOR)),
  );
  const top =
    o.field === 'body'
      ? Math.max(0, Math.min(cursorLine - room + 1, bodyLines.length - room))
      : Math.max(0, bodyLines.length - room);
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
      width={props.width}
      height={props.height}
      overflow="hidden"
    >
      <Text bold wrap="truncate">
        Edit memory · {short(o.original.title, Math.max(10, inner - 16))}
      </Text>
      <Text bold {...(o.field === 'title' ? { color: 'cyan' } : {})}>
        {o.field === 'title' ? '▶ Title' : '  Title'}
      </Text>
      {titleLines.map((l, i) => render(l, `t${i}`))}
      <Text bold {...(o.field === 'body' ? { color: 'cyan' } : {})}>
        {o.field === 'body' ? '▶ Text' : '  Text'}
      </Text>
      {bodyLines.slice(Math.max(0, top), Math.max(0, top) + room).map((l, i) => render(l, i))}
      <Box flexGrow={1} />
      {o.untrusted ? (
        <Text color="yellow" wrap="truncate">
          ⚠ untrusted: editing keeps it untrusted (T in the browser marks it reviewed)
        </Text>
      ) : null}
      <Text color="gray" wrap="truncate">
        ←→↑↓ move · Tab title/text · Ctrl-S save · Esc back
      </Text>
    </Box>
  );
}

/** The delegation tree of a Run: Bots handing work to Bots, live. */
export function TreeOverlay(props: {
  data: Data;
  overlay: Extract<NonNullable<Ui['overlay']>, { kind: 'tree' }>;
  width: number;
  height: number;
}) {
  const { data, overlay: o } = props;
  const name = (id: string) => data.bots.find((b) => b.id === id)?.spec.name ?? id;
  const rows = data.tree ? treeRows(data.tree, name, o.runId) : [];
  const room = Math.max(1, props.height - 5);
  const scroll = Math.min(o.scroll, Math.max(0, rows.length - room));
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={1}
      width={props.width}
      height={props.height}
      overflow="hidden"
    >
      <Text bold wrap="truncate">
        Delegation tree
      </Text>
      {!data.tree ? (
        <Text color="gray">loading…</Text>
      ) : rows.length <= 1 ? (
        <Text color="gray" wrap="wrap">
          This Run did not delegate and was not delegated. Bots with delegation.allowedBots hand
          tasks to peers with delegate_to_bot; each becomes a child Run.
        </Text>
      ) : (
        rows.slice(scroll, scroll + room).map((r, i) => (
          <Text key={i} wrap="truncate" color={TONE_COLOR[r.tone]} bold={r.current}>
            {r.text}
          </Text>
        ))
      )}
      <Box flexGrow={1} />
      <Text color="gray" wrap="wrap">
        Each child Run has its own approvals and inherits what is left of its parent&apos;s budget
        and its untrusted inputs. j/k scroll · Esc close
      </Text>
    </Box>
  );
}

/** Lines of one plugin in full (tools with tiers, secrets, settings, warnings). */
export function pluginDetailLines(
  pl: PluginStatus,
): { text: string; color?: string; bold?: boolean }[] {
  const st = PLUGIN_STATE[pl.state];
  const out: { text: string; color?: string; bold?: boolean }[] = [
    { text: `${pl.name} (${pl.id} ${pl.version})`, bold: true },
    { text: `${st.mark} ${st.label} — ${st.meaning}`, color: TONE_COLOR[st.tone] },
  ];
  // What needs the owner comes first (UI review M4): it must not fall below the fold.
  if (pl.error) out.push({ text: `✘ ${pl.error}`, color: 'red' });
  for (const w of pl.warnings) out.push({ text: `⚠ ${w}`, color: 'yellow' });
  if (pl.description) out.push({ text: pl.description });
  const sb = PLUGIN_SANDBOX_STATE[pl.sandbox.state];
  out.push(
    { text: `server ${pl.server}`, color: 'gray' },
    {
      text: `${sb.mark} ${sb.label}${pl.sandbox.engine ? ` (${pl.sandbox.engine})` : ''}${pl.sandbox.state === 'remote' ? '' : ` · gets ${sandboxNeeds(pl.sandbox.needs)}`}`,
      color: TONE_COLOR[sb.tone],
    },
    { text: '' },
    { text: 'Tools', bold: true },
  );
  for (const t of pl.tools) {
    const w = TIER_WORD[t.tier];
    out.push({
      text: `${w.mark} ${w.label.padEnd(12)} ${t.name}${t.egress ? ' · reaches any address' : ''}${t.available === false ? ' · not offered by the server' : ''}`,
      color: TONE_COLOR[w.tone],
    });
  }
  if (pl.secrets.length) {
    out.push({ text: '' }, { text: 'Secrets (only this plugin receives them)', bold: true });
    for (const s of pl.secrets) {
      out.push({
        text: `${s.set ? '✔ set     ' : s.required ? '◌ missing ' : '○ not set '} ${s.name}`,
        color: s.set ? 'green' : s.required ? 'magenta' : 'gray',
      });
    }
    out.push({
      text: `Set one with: orbit plugin secret ${pl.id} <NAME> < file   (never typed here)`,
      color: 'gray',
    });
  }
  if (pl.settings.length) {
    out.push({ text: '' }, { text: 'Settings', bold: true });
    for (const s of pl.settings) {
      const v = s.value ?? (s.default !== null ? `${s.default} (default)` : null);
      out.push({
        text: `${s.name} = ${v ?? (s.required ? '(required, not set)' : '(not set)')}`,
        ...(v === null && s.required ? { color: 'magenta' } : {}),
      });
    }
  }
  out.push(
    { text: '' },
    {
      text: `Bots: ${pl.bots.length ? pl.bots.map((b) => b.name).join(', ') : 'none list it yet'}`,
    },
  );
  return out;
}

/** Settings → Integrations in the terminal: plugins and inbound triggers. */
export function IntegrationsOverlay(props: {
  data: Data;
  overlay: Extract<NonNullable<Ui['overlay']>, { kind: 'integrations' }>;
  width: number;
  height: number;
}) {
  const { data, overlay: o } = props;
  const list = data.plugins ?? [];
  const at = Math.max(0, Math.min(o.index, list.length - 1));
  const room = Math.max(1, props.height - 5);
  const selected = list[at];
  let lines: { text: string; color?: string; bold?: boolean; current?: boolean }[];
  if (o.open && selected) {
    lines = pluginDetailLines(selected).flatMap((l) =>
      wrapText(l.text, props.width - 4).map((text) => ({ ...l, text })),
    );
  } else {
    lines = [{ text: 'Plugins', bold: true }];
    list.forEach((pl, i) => {
      const st = PLUGIN_STATE[pl.state];
      const cur = i === at;
      lines.push({
        text: `${cur ? '›' : ' '} ${`${st.mark} ${st.label}`.padEnd(14)} ${pl.id.padEnd(11)} ${pl.name} · ${pl.tools.length} tools${pl.bots.length ? ` · ${pl.bots.length} Bot${pl.bots.length === 1 ? '' : 's'}` : ''}`,
        color: TONE_COLOR[st.tone],
        bold: cur,
        current: cur,
      });
    });
    lines.push({ text: '' }, { text: 'Inbound triggers', bold: true });
    const inbound = data.inbound ?? [];
    if (inbound.length === 0) {
      lines.push({
        text: 'None. Add a webhook, Slack, file or git trigger to a Bot (orbit triggers).',
        color: 'gray',
      });
    }
    for (const t of inbound) {
      const st = TRIGGER_STATE[t.state];
      lines.push({
        text: `${`${st.mark} ${st.label}`.padEnd(14)} ${t.botName} · ${TRIGGER_KIND_WORD[t.kind]} · ${t.description}${t.detail ? ` (${t.detail})` : ''}`,
        color: TONE_COLOR[st.tone],
      });
    }
  }
  const cursorLine = lines.findIndex((l) => l.current);
  const scroll = o.open
    ? Math.min(o.scroll, Math.max(0, lines.length - room))
    : Math.max(0, Math.min(cursorLine - room + 2, lines.length - room));
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={1}
      width={props.width}
      height={props.height}
      overflow="hidden"
    >
      <Text bold wrap="truncate">
        Integrations
      </Text>
      {data.plugins === null ? (
        <Text color={data.error ? 'red' : 'gray'} wrap="wrap">
          {data.error ? `⚠ ${scrubControls(data.error)}` : 'loading…'}
        </Text>
      ) : (
        lines.slice(scroll, scroll + room).map((l, i) => (
          <Text
            key={i}
            wrap="truncate"
            {...(l.color ? { color: l.color } : {})}
            bold={l.bold === true}
          >
            {l.text || ' '}
          </Text>
        ))
      )}
      <Box flexGrow={1} />
      <Text color="gray" wrap="truncate">
        {o.open
          ? 'j/k scroll · e enable/disable · Esc back'
          : 'j/k select · Enter open · e enable/disable · Esc close · ? help'}
      </Text>
    </Box>
  );
}
