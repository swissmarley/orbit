/** @jsxRuntime automatic @jsxImportSource react */
import { errorMessage } from '@orbit/core';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Feed, type TuiClient } from './feed';
import {
  type Command,
  type Data,
  INITIAL_UI,
  type KeyResult,
  type Ui,
  onKey,
  onMouse,
  reconcile,
  selectedRun,
} from './model';
import { screenLayout } from './layout';
import type { MouseEvent } from './mouse';
import { scrubControls } from '../render';
import {
  ApprovalsPane,
  BotsPane,
  CardOverlay,
  MemoryEditOverlay,
  MemoryOverlay,
  TreeOverlay,
  IntegrationsOverlay,
  ConfirmBar,
  DenyPrompt,
  HelpOverlay,
  type Paint,
  StatusBar,
  TabBar,
  TimelinePane,
  paneInner,
  pauseBanner,
  pauseRows,
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
    case 'pauseRun':
      await client.runs.pause(command.runId);
      return `⏸ pausing ${command.runId} at its next tool call`;
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
    case 'setPlugin': {
      const pl = command.enabled
        ? await client.plugins.enable(command.pluginId)
        : await client.plugins.disable(command.pluginId);
      return command.enabled ? `● ${pl.name} is on` : `○ ${pl.name} is off`;
    }
    case 'feedback':
      await client.runs.feedback(command.runId, { rating: command.rating });
      return `${command.rating === 'up' ? '▲' : '▼'} feedback saved — the Bot sees it next time`;
    // Loaded through the feed (see App).
    case 'loadMemory':
    case 'loadTree':
    case 'loadIntegrations':
    case 'refresh':
    case 'mouse':
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
  /** Mouse input and reporting (a TTY); without it M says the mouse is unavailable. */
  mouse?: MouseControl;
}

/** What the App needs from the terminal's mouse (see terminal-mouse.ts). */
export interface MouseControl {
  /** Mouse events in screen cells; returns an unsubscribe. */
  subscribe(fn: (e: MouseEvent) => void): () => void;
  /** Turn reporting on or off; false when it cannot be turned on here. */
  set(on: boolean): boolean;
  /** Reporting is on (e.g. orbit tui --mouse). */
  readonly enabled: boolean;
}

export function App({ client, paint, size, refreshDelayMs, mouse }: AppProps) {
  const { exit } = useApp();
  const terminal = useWindowSize();
  const columns = size?.columns ?? terminal.columns;
  const rows = size?.rows ?? terminal.rows;
  const feed = useMemo(
    () => new Feed(client, refreshDelayMs === undefined ? {} : { refreshDelayMs }),
    [client, refreshDelayMs],
  );
  const [data, setData] = useState<Data>(feed.snapshot());
  const [ui, setUi] = useState<Ui>(() => ({ ...INITIAL_UI, mouse: mouse?.enabled === true }));
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

  const handle = (result: KeyResult) => {
    setUi(result.ui);
    const command = result.command;
    if (!command) return;
    if (command.kind === 'mouse') {
      const ok = mouse?.set(command.on) === true;
      setUi((u) => ({
        ...u,
        mouse: ok ? command.on : false,
        toast: ok
          ? {
              text: command.on
                ? 'mouse on — click selects, the wheel scrolls; M turns it off'
                : 'mouse off',
              tone: 'info',
            }
          : { text: 'The mouse needs an interactive terminal', tone: 'error' },
      }));
      return;
    }
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
    if (command.kind === 'loadIntegrations') {
      void feed.watchIntegrations(command.on);
      return;
    }
    const memoryOverlay = uiRef.current.overlay;
    perform(client, command)
      .then((text) => {
        toast(text);
        // Memory changes refresh the browser that made them.
        if (command.kind === 'setPlugin') void feed.watchIntegrations(true);
        if (command.kind === 'updateMemory' || command.kind === 'deleteMemory') {
          const o = result.ui.overlay ?? memoryOverlay;
          if (o?.kind === 'memory') void feed.watchMemory({ botId: o.botId, query: o.query });
        }
        return feed.refresh();
      })
      .catch((err: unknown) => toast(errorMessage(err), 'error'));
  };
  useInput((input, key) => handle(onKey(uiRef.current, data, input, key)));

  const overlay = ui.overlay;
  const layout = screenLayout(columns, rows, overlay, ui.focus);
  const { narrow, footer, bodyHeight, paneHeight, sideWidth, rightWidth } = layout;
  // Clicks and the wheel go through the same pure model as keys, over this layout.
  const mouseRef = useRef({ data, layout, handle });
  mouseRef.current = { data, layout, handle };
  useEffect(
    () =>
      mouse?.subscribe((e) => {
        const { data: d, layout: l, handle: h } = mouseRef.current;
        if (uiRef.current.mouse) h(onMouse(uiRef.current, d, e, l));
      }),
    [mouse],
  );
  const memoryShown =
    overlay?.kind === 'memory'
      ? overlay
      : overlay?.kind === 'confirm' && overlay.back?.kind === 'memory'
        ? overlay.back
        : null;
  const integrationsShown =
    overlay?.kind === 'integrations'
      ? overlay
      : overlay?.kind === 'confirm' && overlay.back?.kind === 'integrations'
        ? overlay.back
        : null;
  const cardApproval =
    overlay?.kind === 'card' ? data.approvals.find((a) => a.id === overlay.approvalId) : undefined;

  // Keep the timeline scroll inside the text (g and overscroll would otherwise look dead).
  const timelineWidth = narrow ? columns : columns - sideWidth - rightWidth;
  const bannerRows = pauseBanner(
    run,
    paneInner(timelineWidth, columns),
    pauseRows(paneHeight),
  ).length;
  const maxScroll = Math.max(
    0,
    timelineLines(data.events, paint).length - Math.max(1, paneHeight - 4 - bannerRows),
  );
  useEffect(() => {
    if (ui.scroll > maxScroll) setUi((u) => ({ ...u, scroll: maxScroll }));
  }, [ui.scroll, maxScroll]);

  const hints: Record<Ui['focus'], string> = {
    bots: 'j/k select · r run · p pause · m memory · i plugins · [ ] runs · Tab panes · ? help · q quit',
    timeline:
      'j/k scroll · g/G top/live · s stop · P pause · u resume · t tree · +/- rate · [ ] runs · Tab panes · ? help · q quit',
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
        columns={columns}
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
      ) : integrationsShown ? (
        <IntegrationsOverlay
          data={data}
          overlay={integrationsShown}
          width={columns}
          height={bodyHeight}
        />
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
          {panes.timeline(timelineWidth)}
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
