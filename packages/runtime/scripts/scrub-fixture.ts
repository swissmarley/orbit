/**
 * Turn a raw `claude -p --output-format stream-json --verbose` recording into a
 * committed MockDriver fixture:
 *   tsx scripts/scrub-fixture.ts <raw.jsonl> <out.jsonl> <recording-cwd>
 *
 * - session ids and message uuids → stable placeholder UUIDs
 * - the recording directory → /workspace, home → /home/orbit
 * - thinking signatures removed; environment-specific init lists trimmed
 * - rate-limit numbers replaced with neutral values (account usage is private)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const [, , input, output, recordingCwd] = process.argv;
if (!input || !output || !recordingCwd) {
  console.error('usage: scrub-fixture.ts <raw.jsonl> <out.jsonl> <recording-cwd>');
  process.exit(2);
}

const BUILTIN_TOOLS = new Set([
  'Task',
  'Agent',
  'Bash',
  'Glob',
  'Grep',
  'Read',
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Keys whose values describe the recording machine rather than the session. */
const DROPPED_KEYS = new Set([
  'scratchpad_path',
  'scratchpad_dir',
  'transcript_path',
  'memory_paths',
  'request_id',
  'messaging_socket_path',
  'startup_timing',
  'time_origin_ms',
]);
const recordingRoot: string = recordingCwd;
const encodedCwd = recordingRoot.replace(/[/.]/g, '-');

const uuidMap = new Map<string, string>();
const placeholder = (u: string): string => {
  let v = uuidMap.get(u);
  if (!v) {
    v = `00000000-0000-4000-8000-${String(uuidMap.size + 1).padStart(12, '0')}`;
    uuidMap.set(u, v);
  }
  return v;
};

function scrub(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key === 'signature') return '';
    return value
      .split(recordingRoot)
      .join('/workspace')
      .split(encodedCwd)
      .join('-workspace')
      .replace(/\/tmp\/claude-\d+\/[^"\s]*/g, '/tmp/orbit')
      .split(homedir())
      .join('/home/orbit')
      .replace(UUID, placeholder);
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!DROPPED_KEYS.has(k)) out[k] = scrub(v, k);
    }
    return out;
  }
  return value;
}

const lines = readFileSync(input, 'utf8')
  .split('\n')
  .filter((l) => l.trim());
const out = lines.map((line) => {
  const msg = JSON.parse(line) as Record<string, unknown>;
  if (msg.type === 'system' && msg.subtype === 'init') {
    msg.tools = (msg.tools as string[]).filter((t) => BUILTIN_TOOLS.has(t));
    for (const k of [
      'slash_commands',
      'terminal_slash_commands',
      'skills',
      'plugins',
      'agents',
      'capabilities',
    ]) {
      msg[k] = [];
    }
  }
  if (msg.type === 'rate_limit_event') {
    msg.rate_limit_info = {
      status: 'allowed',
      resetsAt: 1791158400,
      rateLimitType: 'five_hour',
      utilization: 0.2,
      isUsingOverage: false,
    };
  }
  return JSON.stringify(scrub(msg));
});
writeFileSync(output, out.join('\n') + '\n');
console.log(`wrote ${out.length} messages to ${output}`);
