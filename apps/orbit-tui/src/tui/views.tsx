/** @jsxRuntime automatic @jsxImportSource react */
import {
  MEMORY_SOURCE_WORD,
  RUN_STATUS,
  type RunEvent,
  type RunState,
  type Tone,
  formatClock,
  formatLocalTime,
  memoryTrust,
} from '@orbit/core';
import { Box, Text } from 'ink';
import type { painter } from '../io';
import { clean } from '../commands/approvals';
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

export type Paint = ReturnType<typeof painter>;

/** Narrower than this, the TUI shows one pane at a time with a tab bar. */
export const NARROW_COLUMNS = 100;

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
  const listRows = Math.max(1, Math.min(data.bots.length, Math.floor((props.height - 3) / 2)));
  const at = bot ? data.bots.indexOf(bot) : 0;
  const first = Math.max(0, Math.min(at - listRows + 1, data.bots.length - listRows));
  const runRows = Math.max(0, props.height - 5 - listRows);
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
  const visible = Math.max(1, props.height - 4);
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
          {scroll > 0 ? ` · ↑${scroll}` : ''}
        </Text>
      ) : (
        <Text color="gray">No run selected. Pick a Bot and press r to run it.</Text>
      )}
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
  const listRows = Math.min(data.approvals.length, Math.max(1, Math.floor((props.height - 3) / 3)));
  const first = Math.max(
    0,
    Math.min(ui.approvalIndex - listRows + 1, data.approvals.length - listRows),
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
export function promptHeight(text: string, width: number): number {
  return 2 + Math.max(1, Math.ceil(text.length / Math.max(10, width - 4)));
}

export function ConfirmBar({ message, width }: { message: string; width: number }) {
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} width={width}>
      <Text wrap="wrap">
        {message} <Text bold>[y/N]</Text>
      </Text>
    </Box>
  );
}

export const DENY_TITLE = 'Deny — reason the Bot will see (Enter sends, Esc cancels):';

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
      {(['bots', 'timeline', 'approvals'] as const).map((p, i) => (
        <Text key={p} {...(p === focus ? { inverse: true, bold: true } : { color: 'gray' })}>
          {` ${p === focus ? '▶' : ''}${i + 1} ${TITLES[p]}${p === 'approvals' && pending ? ` (${pending})` : ''} `}
        </Text>
      ))}
    </Text>
  );
}

/** The memory browser of one Bot: list with trust in words, a memory in full, search. */
export function MemoryOverlay(props: {
  data: Data;
  overlay: Extract<NonNullable<Ui['overlay']>, { kind: 'memory' }>;
  botName: string;
  width: number;
  height: number;
}) {
  const { data, overlay: o } = props;
  const m = selectedMemory(data, o);
  const inner = Math.max(10, props.width - 4);
  const room = Math.max(1, props.height - 5);
  const header = (
    <Text bold wrap="truncate">
      Memory · {short(props.botName, 40)}
      {o.query ? <Text color="gray"> · matching “{short(o.query, 30)}”</Text> : null}
      <Text color="gray"> · {data.memories.length} shown</Text>
    </Text>
  );
  const footer = (
    <Text color="gray" wrap="truncate">
      {o.search !== null
        ? 'type to search · Enter search · Esc cancel'
        : o.open
          ? 'j/k scroll · e edit · x delete · T trust · P pin · Esc back'
          : 'j/k select · Enter open · / search · e edit · x delete · T trust · P pin · Esc close'}
    </Text>
  );
  let body: React.ReactNode[];
  if (o.open && m) {
    const trust = memoryTrust(m);
    const lines: React.ReactNode[] = [
      <Text key="title" bold wrap="wrap">
        {clean(m.title)}
      </Text>,
      <Text key="meta" color="gray" wrap="wrap">
        {m.id} · {m.kind} · by {MEMORY_SOURCE_WORD[m.source]} · {formatClock(m.createdAt)}
        {m.runId ? ` · run ${m.runId}` : ''}
        {m.editedAt ? ' · edited by you' : ''}
        {m.pinned ? ' · pinned' : ''}
      </Text>,
      <Text key="trust" color={TONE_COLOR[trust.tone]} wrap="wrap">
        {trust.mark} {trust.label}
        {m.taint.length
          ? ` — from ${clean(m.taint.join(', '))}; never offered to Runs automatically`
          : ''}
      </Text>,
      <Text key="gap"> </Text>,
      ...clean(m.body)
        .split('\n')
        .map((l, i) => (
          <Text key={`l${i}`} wrap="wrap">
            {l || ' '}
          </Text>
        )),
    ];
    const scroll = Math.min(o.scroll, Math.max(0, lines.length - room));
    body = lines.slice(scroll, scroll + room);
  } else if (data.memories.length === 0) {
    body = [
      <Text key="empty" color="gray" wrap="wrap">
        {o.query
          ? 'No memories match.'
          : 'No memories yet. Bots remember the result of each finished Run, notes they save, and your feedback (+/- on a Run, edits, denials).'}
      </Text>,
    ];
  } else {
    const top = Math.max(0, Math.min(o.index - Math.floor(room / 2), data.memories.length - room));
    body = data.memories.slice(top, top + room).map((x, i) => {
      const at = top + i === o.index;
      const trust = memoryTrust(x);
      const label = `${trust.mark} ${trust.label}`.padEnd(11);
      const meta = `${x.kind.padEnd(8)} ${MEMORY_SOURCE_WORD[x.source].padEnd(8)} `;
      return (
        <Text key={x.id} wrap="truncate" {...(at ? { inverse: true } : {})}>
          {at ? '› ' : '  '}
          <Text color={TONE_COLOR[trust.tone]}>{label}</Text> {meta}
          {x.pinned ? '📌 ' : ''}
          {short(x.title, Math.max(10, inner - 36))}
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

/** Editing a memory: title and text, saved with Ctrl-S. */
export function MemoryEditOverlay(props: {
  overlay: Extract<NonNullable<Ui['overlay']>, { kind: 'memoryEdit' }>;
  width: number;
  height: number;
}) {
  const o = props.overlay;
  const room = Math.max(1, props.height - 7);
  const bodyLines = o.body.split('\n');
  const shown = bodyLines.slice(Math.max(0, bodyLines.length - room));
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
        Edit memory {o.memoryId}
      </Text>
      <Text wrap="truncate">
        <Text bold {...(o.field === 'title' ? { color: 'cyan' } : {})}>
          {o.field === 'title' ? '▶ Title ' : '  Title '}
        </Text>
        {scrubControls(o.title)}
        {o.field === 'title' ? <Text inverse> </Text> : null}
      </Text>
      <Text bold {...(o.field === 'body' ? { color: 'cyan' } : {})}>
        {o.field === 'body' ? '▶ Text' : '  Text'}
      </Text>
      {shown.map((l, i) => (
        <Text key={i} wrap="wrap">
          {scrubControls(l) || ' '}
          {o.field === 'body' && i === shown.length - 1 ? <Text inverse> </Text> : null}
        </Text>
      ))}
      <Box flexGrow={1} />
      <Text color="gray" wrap="truncate">
        Tab title/text · Enter new line · Ctrl-S save · Esc cancel · editing keeps an untrusted
        memory untrusted
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
