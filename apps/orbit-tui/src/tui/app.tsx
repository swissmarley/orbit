/** @jsxRuntime automatic @jsxImportSource react */
import { errorMessage } from '@orbit/core';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Feed, type TuiClient } from './feed';
import {
  type Command,
  type Data,
  INITIAL_UI,
  type Ui,
  onKey,
  reconcile,
  selectedRun,
} from './model';
import { scrubControls } from '../render';
import {
  ApprovalsPane,
  BotsPane,
  CardOverlay,
  MemoryEditOverlay,
  MemoryOverlay,
  TreeOverlay,
  ConfirmBar,
  DENY_TITLE,
  DenyPrompt,
  HelpOverlay,
  NARROW_COLUMNS,
  type Paint,
  StatusBar,
  TabBar,
  TimelinePane,
  promptHeight,
  timelineLines,
} from './views';

const SEVEN_DAYS_MS = 7 * 86_400_000;

/** Perform a command through orbitd; resolves to the toast to show. */
export async function perform(
  client: TuiClient,
  command: Command,
  now: () => Date = () => new Date(),
): Promise<string> {
  switch (command.kind) {
    case 'runBot': {
      const run = await client.runs.start(command.botId);
      return `▶ queued ${run.runId}`;
    }
    case 'pauseBot': {
      const bot = command.paused
        ? await client.bots.pause(command.botId)
        : await client.bots.resume(command.botId);
      return `${command.paused ? '⏸ paused' : '▶ resumed'} ${bot.spec.name}`;
    }
    case 'stopRun':
      await client.runs.stop(command.runId);
      return `■ stop requested for ${command.runId}`;
    case 'resumeRun':
      await client.runs.resume(command.runId);
      return `▶ resuming ${command.runId}`;
    case 'approve': {
      const r = await client.approvals.approve(command.approvalId, {
        always: command.always
          ? {
              scope: 'bot',
              expiresAt: new Date(now().getTime() + SEVEN_DAYS_MS).toISOString(),
            }
          : null,
      });
      return `✔ approved ${r.approval.card.what}${r.resumed ? ' — resuming' : ''}`;
    }
    case 'deny': {
      const r = await client.approvals.deny(command.approvalId, { reason: command.reason });
      return `✘ denied ${r.approval.card.what}${r.resumed ? ' — resuming' : ''}`;
    }
    case 'kill': {
      await client.kill.set(command.on);
      return command.on ? '■ kill switch engaged' : 'kill switch released';
    }
    case 'updateMemory': {
      const m = await client.memory.update(command.memoryId, command.patch);
      return command.patch.trusted
        ? `✓ marked trusted: ${m.title}`
        : command.patch.pinned !== undefined && command.patch.title === undefined
          ? `${m.pinned ? 'pinned' : 'unpinned'}: ${m.title}`
          : `✔ saved: ${m.title}`;
    }
    case 'deleteMemory':
      await client.memory.remove(command.memoryId);
      return 'memory deleted';
    case 'feedback':
      await client.runs.feedback(command.runId, { rating: command.rating });
      return `${command.rating === 'up' ? '▲' : '▼'} feedback saved — the Bot sees it next time`;
    // Loaded through the feed (see App).
    case 'loadMemory':
    case 'loadTree':
    case 'refresh':
    case 'quit':
      return '';
  }
}

export interface AppProps {
  client: TuiClient;
  paint: Paint;
  /** Override the terminal size (tests). */
  size?: { columns: number; rows: number };
  /** Coalescing delay for list refetches after events. */
  refreshDelayMs?: number;
}

export function App({ client, paint, size, refreshDelayMs }: AppProps) {
  const { exit } = useApp();
  const terminal = useWindowSize();
  const columns = size?.columns ?? terminal.columns;
  const rows = size?.rows ?? terminal.rows;
  const feed = useMemo(
    () => new Feed(client, refreshDelayMs === undefined ? {} : { refreshDelayMs }),
    [client, refreshDelayMs],
  );
  const [data, setData] = useState<Data>(feed.snapshot());
  const [ui, setUi] = useState<Ui>(INITIAL_UI);
  const uiRef = useRef(ui);
  uiRef.current = ui;

  useEffect(() => {
    const off = feed.subscribe(setData);
    void feed.start();
    return () => {
      off();
      feed.close();
    };
  }, [feed]);

  // Keep selections valid as Bots, Runs and approvals come and go.
  useEffect(() => {
    setUi((u) => reconcile(u, data));
  }, [data]);

  const run = selectedRun(data, ui);
  useEffect(() => {
    void feed.select(run?.runId ?? null);
  }, [feed, run?.runId]);

  // Toasts quote orbitd and card text: scrub it like everything else shown.
  const toast = (text: string, tone: 'info' | 'error' = 'info') =>
    setUi((u) => ({ ...u, toast: text ? { text: scrubControls(text), tone } : null }));

  useInput((input, key) => {
    const result = onKey(uiRef.current, data, input, key);
    setUi(result.ui);
    const command = result.command;
    if (!command) return;
    if (command.kind === 'quit') {
      exit();
      return;
    }
    if (command.kind === 'refresh') {
      void feed.refresh();
      return;
    }
    if (command.kind === 'loadMemory') {
      void feed.watchMemory(
        command.botId === null ? null : { botId: command.botId, query: command.query },
      );
      return;
    }
    if (command.kind === 'loadTree') {
      void feed.watchTree(command.runId);
      return;
    }
    const memoryOverlay = uiRef.current.overlay;
    perform(client, command)
      .then((text) => {
        toast(text);
        // Memory changes refresh the browser that made them.
        if (command.kind === 'updateMemory' || command.kind === 'deleteMemory') {
          const o = result.ui.overlay ?? memoryOverlay;
          if (o?.kind === 'memory') void feed.watchMemory({ botId: o.botId, query: o.query });
        }
        return feed.refresh();
      })
      .catch((err: unknown) => toast(errorMessage(err), 'error'));
  });

  const narrow = columns < NARROW_COLUMNS;
  const overlay = ui.overlay;
  const footer =
    overlay?.kind === 'confirm'
      ? promptHeight(`${overlay.message} [y/N]`, columns)
      : overlay?.kind === 'deny'
        ? promptHeight(DENY_TITLE, columns) +
          Math.ceil((overlay.text.length + 3) / Math.max(10, columns - 4))
        : 1;
  const bodyHeight = Math.max(3, rows - 1 - footer);
  const paneHeight = Math.max(3, bodyHeight - (narrow ? 1 : 0));
  const sideWidth = Math.max(24, Math.floor(columns * 0.26));
  const rightWidth = Math.max(30, Math.floor(columns * 0.34));
  const memoryShown =
    overlay?.kind === 'memory'
      ? overlay
      : overlay?.kind === 'confirm' && overlay.back?.kind === 'memory'
        ? overlay.back
        : null;
  const cardApproval =
    overlay?.kind === 'card' ? data.approvals.find((a) => a.id === overlay.approvalId) : undefined;

  // Keep the timeline scroll inside the text (g and overscroll would otherwise look dead).
  const maxScroll = Math.max(
    0,
    timelineLines(data.events, paint).length - Math.max(1, paneHeight - 4),
  );
  useEffect(() => {
    if (ui.scroll > maxScroll) setUi((u) => ({ ...u, scroll: maxScroll }));
  }, [ui.scroll, maxScroll]);

  const hints: Record<Ui['focus'], string> = {
    bots: 'j/k select · r run · p pause · m memory · [ ] runs · Enter timeline · Tab panes · ? help · q quit',
    timeline:
      'j/k scroll · g/G top/live · s stop · u resume · t tree · +/- rate · [ ] runs · Tab panes · ? help · q quit',
    approvals: 'j/k select · Enter/a open card to approve · d deny · Tab panes · ? help · q quit',
  };

  const panes = {
    bots: (w: number | string) => (
      <BotsPane
        data={data}
        ui={ui}
        focused={ui.focus === 'bots'}
        width={w}
        height={paneHeight}
        inner={typeof w === 'number' ? w - 4 : columns - 4}
      />
    ),
    timeline: (w: number | string) => (
      <TimelinePane
        data={data}
        run={run}
        ui={ui}
        focused={ui.focus === 'timeline'}
        width={w}
        height={paneHeight}
        paint={paint}
      />
    ),
    approvals: (w: number | string) => (
      <ApprovalsPane
        data={data}
        ui={ui}
        focused={ui.focus === 'approvals'}
        width={w}
        height={paneHeight}
        paint={paint}
      />
    ),
  };

  return (
    <Box flexDirection="column" width={columns}>
      <StatusBar data={data} width={columns} />
      {overlay?.kind === 'help' ? (
        <HelpOverlay width={Math.min(columns, 90)} height={bodyHeight} scroll={overlay.scroll} />
      ) : memoryShown ? (
        // The browser stays on screen under its confirm prompts (UI review M5).
        <MemoryOverlay
          data={data}
          overlay={memoryShown}
          botName={
            data.bots.find((b) => b.id === memoryShown.botId)?.spec.name ?? memoryShown.botId
          }
          width={columns}
          height={bodyHeight}
        />
      ) : overlay?.kind === 'memoryEdit' ? (
        <MemoryEditOverlay overlay={overlay} width={columns} height={bodyHeight} />
      ) : overlay?.kind === 'tree' ? (
        <TreeOverlay data={data} overlay={overlay} width={columns} height={bodyHeight} />
      ) : cardApproval && overlay?.kind === 'card' ? (
        <CardOverlay
          approval={cardApproval}
          paint={paint}
          width={columns}
          height={bodyHeight}
          scroll={overlay.scroll}
        />
      ) : narrow ? (
        <Box flexDirection="column">
          <TabBar focus={ui.focus} pending={data.approvals.length} />
          {panes[ui.focus](columns)}
        </Box>
      ) : (
        <Box>
          {panes.bots(sideWidth)}
          {panes.timeline(columns - sideWidth - rightWidth)}
          {panes.approvals(rightWidth)}
        </Box>
      )}
      {overlay?.kind === 'confirm' ? (
        <ConfirmBar message={overlay.message} width={columns} />
      ) : null}
      {overlay?.kind === 'deny' ? <DenyPrompt text={overlay.text} width={columns} /> : null}
      {footer === 1 ? (
        <Text
          wrap="truncate"
          color={ui.toast?.tone === 'error' ? 'red' : data.error ? 'red' : 'gray'}
        >
          {ui.toast?.text ??
            (data.error
              ? `⚠ ${scrubControls(data.error)}`
              : // Full-screen overlays show their own keys; pane hints would only mislead.
                overlay && overlay.kind !== 'confirm' && overlay.kind !== 'deny'
                ? ' '
                : hints[ui.focus])}
        </Text>
      ) : null}
    </Box>
  );
}
