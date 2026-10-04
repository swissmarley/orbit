#!/usr/bin/env node
// Claude Code command hook used by Orbit's CliDriver. Forwards the hook input
// (stdin JSON) to orbitd's loopback hook bridge and prints the decision.
// Fails closed: if Orbit cannot be reached, PreToolUse is denied.
const url = process.env.ORBIT_HOOK_URL;
const token = process.env.ORBIT_HOOK_TOKEN;

function failClosed(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Orbit permission bridge unavailable (${reason}); denied by default`,
      },
    }),
  );
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', async () => {
  if (!url || !token) return failClosed('not configured');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: input,
    });
    if (!res.ok) return failClosed(`HTTP ${res.status}`);
    process.stdout.write(await res.text());
  } catch (err) {
    failClosed(err instanceof Error ? err.message : 'request failed');
  }
});
