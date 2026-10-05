import type { Command } from 'commander';
import { OrbitError, slugify } from '@orbit/core';
import { defaultHome } from '@orbit/runtime';
import { type OrbitClient, localClient } from '@orbit/sdk-client';
import type { Io } from '../io';

/** What the first argument of a command names, for dynamic completion. */
export type CompletionKind = 'bots' | 'runs' | 'approvals' | 'plugins';
export const COMPLETION_KINDS: readonly CompletionKind[] = ['bots', 'runs', 'approvals', 'plugins'];

interface Node {
  name: string;
  options: string[];
  children: Node[];
  /** Candidates for the first argument come from `orbit __complete <dynamic>`. */
  dynamic: CompletionKind | null;
}

/** Names end up inside shell quotes: only plain words are allowed (review F6). */
const SAFE_COMMAND = /^[a-z0-9][a-z0-9-]*$/;
const SAFE_OPTION = /^--?[a-zA-Z0-9][a-zA-Z0-9-]*$/;
/**
 * Dynamic candidates (Bot slugs, run, approval and plugin ids) go through
 * `compgen -W`, which expands what it is given: anything but a plain word is
 * skipped, never quoted.
 */
const SAFE_CANDIDATE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function safeCandidates(names: readonly string[]): string[] {
  return [...new Set(names.filter((n) => SAFE_CANDIDATE.test(n)))];
}

/**
 * The kind of a command's first argument: `<bot>` and `<run>` by name,
 * approval and plugin ids by their description.
 */
function argumentKind(cmd: Command): CompletionKind | null {
  const first = cmd.registeredArguments[0];
  if (!first) return null;
  const name = first.name();
  const description = first.description;
  if (name === 'bot') return 'bots';
  if (name === 'run') return 'runs';
  if (description.startsWith('approval id')) return 'approvals';
  if (description.startsWith('plugin id')) return 'plugins';
  return null;
}

function tree(cmd: Command): Node {
  const name = cmd.name();
  if (!SAFE_COMMAND.test(name)) throw new Error(`Unsafe command name for completion: ${name}`);
  const options = cmd.options.flatMap((o) =>
    [o.long, o.short].filter((x): x is string => Boolean(x)),
  );
  for (const o of options) {
    if (!SAFE_OPTION.test(o)) throw new Error(`Unsafe option for completion: ${o}`);
  }
  return {
    name,
    options,
    // Hidden commands (`__complete`) are not offered.
    children: cmd
      .createHelp()
      .visibleCommands(cmd)
      .filter((c) => c.name() !== 'help')
      .map(tree),
    dynamic: argumentKind(cmd),
  };
}

/** Every command path ("" for the root) with its subcommands and options. */
function paths(node: Node, prefix: string[] = []): { path: string[]; node: Node }[] {
  return [{ path: prefix, node }, ...node.children.flatMap((c) => paths(c, [...prefix, c.name]))];
}

function words(n: Node): string {
  return [...n.children.map((c) => c.name), ...n.options, '--help'].join(' ');
}

/** `; dyn="bots"` for a command whose first argument completes dynamically. */
const dyn = (n: Node, assign: (kind: string) => string) =>
  n.dynamic ? ` ${assign(n.dynamic)}` : '';

export function bashCompletion(root: Node): string {
  const cases = paths(root)
    .map(
      ({ path, node }) =>
        `      "${path.join(' ')}") opts="${words(node)}"${dyn(node, (k) => `dyn="${k}"`)} ;;`,
    )
    .join('\n');
  return `# orbit bash completion — add to ~/.bashrc:  source <(orbit completion bash)
_orbit_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" path="" w opts dyn args=0
  for w in "\${COMP_WORDS[@]:1:COMP_CWORD-1}"; do
    case "$w" in -*) ;; *) path="\${path:+$path }$w" ;; esac
  done
  # Drop trailing arguments (bot names, run ids) until a command path matches.
  while :; do
    opts="" dyn=""
    case "$path" in
${cases}
    esac
    if [ -n "$opts" ] || [ -z "$path" ]; then break; fi
    args=$((args + 1))
    case "$path" in *" "*) path="\${path% *}" ;; *) path="" ;; esac
  done
  # The first argument: Bot names, run, approval or plugin ids from a running orbitd
  # (never started for this; nothing when it is not running).
  if [ -n "$dyn" ] && [ "$args" -eq 0 ] && [ "\${cur#-}" = "$cur" ]; then
    opts="$opts $(command orbit __complete "$dyn" 2>/dev/null)"
  fi
  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
}
complete -F _orbit_complete orbit
`;
}

export function zshCompletion(root: Node): string {
  const cases = paths(root)
    .map(
      ({ path, node }) =>
        `      "${path.join(' ')}") opts=(${words(node)})${dyn(node, (k) => `dyn=${k}`)} ;;`,
    )
    .join('\n');
  return `#compdef orbit
# orbit zsh completion — add to ~/.zshrc:  source <(orbit completion zsh)
_orbit() {
  local -a opts
  local p="" w dyn="" args=0
  for w in \${words[2,CURRENT-1]}; do
    [[ $w == -* ]] || p="\${p:+$p }$w"
  done
  while :; do
    opts=() dyn=""
    case "$p" in
${cases}
    esac
    if (( \${#opts} )) || [[ -z $p ]]; then break; fi
    (( args++ ))
    if [[ $p == *" "* ]]; then p="\${p% *}"; else p=""; fi
  done
  # The first argument: names and ids from a running orbitd (never started for this).
  if [[ -n $dyn && $args -eq 0 && $PREFIX != -* ]]; then
    opts+=(\${(f)"$(command orbit __complete $dyn 2>/dev/null)"})
  fi
  compadd -- $opts
}
compdef _orbit orbit
`;
}

export function fishCompletion(root: Node): string {
  const lines = ['# orbit fish completion — save as ~/.config/fish/completions/orbit.fish'];
  for (const { path, node } of paths(root)) {
    const cond =
      path.length === 0 ? '__fish_use_subcommand' : `__fish_seen_subcommand_from ${path.at(-1)}`;
    for (const c of node.children) lines.push(`complete -c orbit -f -n '${cond}' -a '${c.name}'`);
    for (const o of node.options.filter((x) => x.startsWith('--'))) {
      lines.push(`complete -c orbit -f -n '${cond}' -l '${o.slice(2)}'`);
    }
    // Names and ids from a running orbitd (never started for this).
    if (node.dynamic && path.length > 0) {
      lines.push(
        `complete -c orbit -f -n '${cond}' -a '(command orbit __complete ${node.dynamic} 2>/dev/null)'`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function completion(io: Io, program: Command, shell: string): number {
  const root = tree(program);
  const out =
    shell === 'bash'
      ? bashCompletion(root)
      : shell === 'zsh'
        ? zshCompletion(root)
        : shell === 'fish'
          ? fishCompletion(root)
          : null;
  if (out === null) {
    throw new OrbitError('invalid_input', `Unknown shell "${shell}" (bash, zsh or fish)`);
  }
  io.out(out);
  return 0;
}

/** How long `__complete` waits for orbitd before printing nothing. */
export const COMPLETE_TIMEOUT_MS = 300;

async function namesOf(client: OrbitClient, kind: CompletionKind): Promise<string[]> {
  switch (kind) {
    case 'bots':
      return (await client.bots.list()).map((b) => slugify(b.spec.name));
    case 'runs':
      return (await client.runs.list({ limit: 50 })).map((r) => r.runId);
    case 'approvals':
      return (await client.approvals.list()).map((a) => a.id);
    case 'plugins':
      return (await client.plugins.list()).map((p) => p.id);
  }
}

/**
 * `orbit __complete <kind>` (hidden), called by the completion scripts:
 * candidates from a daemon that is already running — never started for
 * this — one per line, plain words only. Any failure (no daemon, a slow
 * one, an unknown kind) prints nothing and exits 0, so a shell never shows
 * an error while completing.
 */
export async function completeNames(
  io: Io,
  kind: string | undefined,
  client: (home: string) => OrbitClient | null = (home) =>
    localClient(home, { timeoutMs: COMPLETE_TIMEOUT_MS }),
): Promise<number> {
  try {
    if (!COMPLETION_KINDS.includes(kind as CompletionKind)) return 0;
    const c = client(defaultHome(io.env));
    if (!c) return 0;
    for (const name of safeCandidates(await namesOf(c, kind as CompletionKind))) io.out(name);
  } catch {
    // nothing to offer
  }
  return 0;
}

export { tree as completionTree };
