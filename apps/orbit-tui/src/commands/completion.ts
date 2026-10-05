import type { Command } from 'commander';
import { OrbitError } from '@orbit/core';
import type { Io } from '../io';

interface Node {
  name: string;
  options: string[];
  children: Node[];
}

function tree(cmd: Command): Node {
  return {
    name: cmd.name(),
    options: cmd.options.flatMap((o) => [o.long, o.short].filter((x): x is string => Boolean(x))),
    children: cmd.commands.filter((c) => c.name() !== 'help').map(tree),
  };
}

/** Every command path ("" for the root) with its subcommands and options. */
function paths(node: Node, prefix: string[] = []): { path: string[]; node: Node }[] {
  return [{ path: prefix, node }, ...node.children.flatMap((c) => paths(c, [...prefix, c.name]))];
}

function words(n: Node): string {
  return [...n.children.map((c) => c.name), ...n.options, '--help'].join(' ');
}

export function bashCompletion(root: Node): string {
  const cases = paths(root)
    .map(({ path, node }) => `      "${path.join(' ')}") opts="${words(node)}" ;;`)
    .join('\n');
  return `# orbit bash completion — add to ~/.bashrc:  source <(orbit completion bash)
_orbit_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" path="" w opts
  for w in "\${COMP_WORDS[@]:1:COMP_CWORD-1}"; do
    case "$w" in -*) ;; *) path="\${path:+$path }$w" ;; esac
  done
  # Drop trailing arguments (bot names, run ids) until a command path matches.
  while :; do
    opts=""
    case "$path" in
${cases}
    esac
    if [ -n "$opts" ] || [ -z "$path" ]; then break; fi
    case "$path" in *" "*) path="\${path% *}" ;; *) path="" ;; esac
  done
  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
}
complete -F _orbit_complete orbit
`;
}

export function zshCompletion(root: Node): string {
  const cases = paths(root)
    .map(({ path, node }) => `      "${path.join(' ')}") opts=(${words(node)}) ;;`)
    .join('\n');
  return `#compdef orbit
# orbit zsh completion — add to ~/.zshrc:  source <(orbit completion zsh)
_orbit() {
  local -a opts
  local p="" w
  for w in \${words[2,CURRENT-1]}; do
    [[ $w == -* ]] || p="\${p:+$p }$w"
  done
  while :; do
    opts=()
    case "$p" in
${cases}
    esac
    if (( \${#opts} )) || [[ -z $p ]]; then break; fi
    if [[ $p == *" "* ]]; then p="\${p% *}"; else p=""; fi
  done
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

export { tree as completionTree };
