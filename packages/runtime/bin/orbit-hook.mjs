#!/usr/bin/env node
// Claude Code command hook used by Orbit's CliDriver. Forwards the hook input
// (stdin JSON) to Orbit's loopback hook bridge and prints the decision.
//
// Fails closed: on ANY failure it prints a deny decision AND exits with code 2,
// which Claude Code treats as a blocking error (the tool call does not run),
// so even an unparseable stdout cannot turn into an allow.
const url = process.env.ORBIT_HOOK_URL;
const token = process.env.ORBIT_HOOK_TOKEN;
// Stay well inside the hook timeout Orbit configures (600 s).
const REQUEST_TIMEOUT_MS = 570_000;

let hookEvent = 'PreToolUse';

function failClosed(reason) {
  // PostToolUse runs after the tool; a failure there must not block anything
  // (the event-store redactor still applies before persistence).
  if (hookEvent !== 'PreToolUse') {
    process.stdout.write('{}');
    process.exit(0);
  }
  const message = `Orbit permission bridge unavailable (${reason}); denied by default`;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: message,
      },
    }),
  );
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

process.on('uncaughtException', (err) => failClosed(err?.message ?? 'uncaught exception'));
process.on('unhandledRejection', (err) => failClosed(err?.message ?? 'unhandled rejection'));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', async () => {
  try {
    hookEvent = JSON.parse(input)?.hook_event_name ?? 'PreToolUse';
  } catch {
    return failClosed('unparseable hook input');
  }
  if (!url || !token) return failClosed('not configured');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: input,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return failClosed(`HTTP ${res.status}`);
    const text = await res.text();
    if (hookEvent === 'PreToolUse') {
      const decision = JSON.parse(text)?.hookSpecificOutput?.permissionDecision;
      if (decision !== 'allow' && decision !== 'deny') return failClosed('invalid decision');
    }
    process.stdout.write(text);
  } catch (err) {
    failClosed(err instanceof Error ? err.message : 'request failed');
  }
});
