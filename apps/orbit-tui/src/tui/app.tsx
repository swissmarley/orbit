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
import {
  ApprovalsPane,
  BotsPane,
  ConfirmBar,
  DenyPrompt,
  HelpOverlay,
  NARROW_COLUMNS,
  type Paint,
  StatusBar,
  TabBar,
  TimelinePane,
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

  const toast = (text: string, tone: 'info' | 'error' = 'info') =>
    setUi((u) => ({ ...u, toast: text ? { text, tone } : null }));

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
    perform(client, command)
      .then((text) => {
        toast(text);
        return feed.refresh();
      })
      .catch((err: unknown) => toast(errorMessage(err), 'error'));
  });

  const narrow = columns < NARROW_COLUMNS;
  const footer = ui.overlay?.kind === 'confirm' || ui.overlay?.kind === 'deny' ? 4 : 1;
  const paneHeight = Math.max(6, rows - 1 - footer - (narrow ? 1 : 0));
  const sideWidth = Math.max(24, Math.floor(columns * 0.26));
  const rightWidth = Math.max(30, Math.floor(columns * 0.34));

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
      {ui.overlay?.kind === 'help' ? (
        <HelpOverlay width={Math.min(columns, 90)} />
      ) : narrow ? (
        <Box flexDirection="column">
          <TabBar focus={ui.focus} />
          {panes[ui.focus](columns)}
        </Box>
      ) : (
        <Box>
          {panes.bots(sideWidth)}
          {panes.timeline(columns - sideWidth - rightWidth)}
          {panes.approvals(rightWidth)}
        </Box>
      )}
      {ui.overlay?.kind === 'confirm' ? <ConfirmBar message={ui.overlay.message} /> : null}
      {ui.overlay?.kind === 'deny' ? <DenyPrompt text={ui.overlay.text} /> : null}
      {footer === 1 ? (
        <Text
          wrap="truncate"
          color={ui.toast?.tone === 'error' ? 'red' : data.error ? 'red' : 'gray'}
        >
          {ui.toast?.text ??
            (data.error
              ? `⚠ ${data.error}`
              : 'Tab/h/l panes · j/k move · r run · a/d approve/deny · K kill · ? help · q quit')}
        </Text>
      ) : null}
    </Box>
  );
}
