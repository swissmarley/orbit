/** @jsxRuntime automatic @jsxImportSource react */
import { Box, Text } from 'ink';
import type { Overlay } from './model';
import { scrubControls } from '../render';

export type SetupOverlayState = Extract<Overlay, { kind: 'setup' }>;

/** No credential value reaches an Ink Text node, including while editing or saving. */
export function SetupOverlay({
  overlay: o,
  width,
  height,
}: {
  overlay: SetupOverlayState;
  width: number;
  height: number;
}) {
  const status = o.status;
  const current = status?.doctor;
  const field = (name: SetupOverlayState['field']) => (o.field === name ? '›' : ' ');
  const highlight = (on: boolean) => (on ? { color: 'cyan' as const } : {});
  const choices = [
    ['api', '1  Anthropic API key', 'real replies · API billing'],
    ['cli', '2  Existing Claude Code login', 'personal, local use'],
    ['demo', '3  Demo', 'recorded replies · no credentials or charges'],
  ] as const;
  const keyLabel = o.apiKey
    ? '*'.repeat(Math.min(40, o.apiKey.length))
    : status?.apiKeyStored || current?.apiCredential
      ? '(saved credential — leave blank to keep)'
      : '(paste a key; input stays hidden)';
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      width={width}
      height={height}
      paddingX={1}
      overflow="hidden"
    >
      <Text bold>Set up Orbit</Text>
      <Text color="gray" wrap="truncate">
        This engine applies to every Bot, including scheduled work.
      </Text>
      <Text> </Text>
      {choices.map(([mode, name, description]) => (
        <Text key={mode} {...highlight(o.field === 'mode' && o.mode === mode)} wrap="truncate">
          {o.field === 'mode' && o.mode === mode ? '›' : ' '} {o.mode === mode ? '●' : '○'} {name} ·{' '}
          {description}
        </Text>
      ))}
      <Text> </Text>
      <Text {...highlight(o.field === 'model')} wrap="truncate">
        {field('model')} Default model: {scrubControls(o.model)}
        {o.field === 'model' ? '▌' : ''}
      </Text>
      {o.mode === 'api' ? (
        <>
          <Text {...highlight(o.field === 'apiKey')} wrap="truncate">
            {field('apiKey')} API key: {keyLabel}
          </Text>
          <Text color="gray" wrap="truncate">
            Create a key: platform.claude.com/settings/keys · stored encrypted
          </Text>
        </>
      ) : o.mode === 'cli' ? (
        <Text color="gray" wrap="truncate">
          Sign in outside Orbit with claude auth login, then Ctrl-R to recheck.
        </Text>
      ) : (
        <Text color="gray" wrap="truncate">
          {o.forgetApiKey ? '[x]' : '[ ]'} Forget saved API key · x toggles while choosing Demo
        </Text>
      )}
      <Text color={status && !status.canConfigure ? 'yellow' : 'gray'} wrap="truncate">
        {o.busy
          ? 'Checking / saving setup…'
          : status?.reason
            ? scrubControls(status.reason)
            : current?.driver === 'mock'
              ? 'Current engine: Demo. Choose API or CLI for real replies.'
              : current?.ok
                ? 'Credentials detected. Setup has not made a paid model request.'
                : 'Connect credentials before running a real Bot.'}
      </Text>
      <Box flexGrow={1} />
      <Text {...highlight(o.field === 'save')}>
        {field('save')}{' '}
        {o.forgetApiKey ? 'Save Demo and remove the saved API key' : 'Save connection'}
      </Text>
      <Text color="gray" wrap="truncate">
        1/2/3 choose · Tab fields · Ctrl-S save · Ctrl-R recheck · Esc close
      </Text>
    </Box>
  );
}
