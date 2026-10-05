# ADR-019: Plugin sandbox, DNS-checked browsing and the plugin catalog

Status: Accepted (M8)

## Context

ADR-014 left three gaps, recorded in PLAN §7 for M8:

- Plugin servers run as the owner's user without an OS sandbox. Orbit's
  policy decides every call and their environment is allowlisted, but a
  plugin with a bug or a hostile dependency could still read `~/.ssh`,
  `~/.claude`, `$ORBIT_HOME` (the vault key file, other Bots' workspaces) or
  write anywhere the owner can.
- The Browser plugin's filter proxy checks host names, not the addresses they
  resolve to: an allowed name that resolves to `127.0.0.1`, a LAN address or
  the cloud metadata service is reachable (and DNS rebinding can switch the
  answer between a check and the connection).
- Plugins come only from the repository or a folder the owner adds; there is
  no way to install one from a catalog or npm.

Constraints: child environments stay allowlisted (`buildPluginEnv`); nothing
a plugin says at run time may widen what it gets; the manifest hash keeps
pinning what the owner enabled; and installing must never run package code.

## Decision

### 1. Plugin servers in an OS sandbox

`plugins.sandbox` (`ORBIT_PLUGIN_SANDBOX`): `auto` (default) sandboxes when
the host can and says when it cannot; `required` refuses to start a plugin
it cannot sandbox (its state becomes `error`, enabling fails, Runs report
why); `off` keeps the M7 behaviour, with a doctor warning. Linux uses
bubblewrap, macOS a generated `sandbox-exec` profile. Detection
(`detectPluginSandbox`) runs once: bwrap must be on PATH **and** build a
namespace sandbox (a probe), since containers and AppArmor can forbid user
namespaces. http plugins are `remote`: nothing runs locally.

**Manifest.** A new, optional `sandbox` section declares needs:
`workspace: none | read | write`, `network: boolean`, `paths` (folders taken
from the plugin's own settings or env names, `read` or `write`, `parent` for
a file whose folder is needed, and `default` folders such as
`~/.cache/ms-playwright`), and `nestedSandbox` (it starts a program with its
own sandbox: Chromium). A manifest without the section gets the safe
defaults: no workspace, no network, no folders — an owner-added plugin that
needs more must say so, which changes its hash and so needs the owner to
enable it again. The section is optional (not defaulted) so manifests written
before M8 keep their hash. Every reference manifest states it; a repo guard
checks that, with a positive control:

| Plugin     | Workspace  | Network | Folders                                                  |
| ---------- | ---------- | ------- | -------------------------------------------------------- |
| GitHub     | read-write | yes     | —                                                        |
| Slack      | none       | yes     | —                                                        |
| Gmail      | none       | yes     | —                                                        |
| Filesystem | none       | no      | `FS_ROOTS` read-write                                    |
| Browser    | none       | yes     | Chromium's folder, `PLAYWRIGHT_BROWSERS_PATH` or default |

**Profile (Linux, bubblewrap).** Derived from the manifest and Orbit's
context, never from the plugin at run time; the wrapper only adds arguments
(the environment stays `buildPluginEnv`):

- new user, pid, ipc, uts and cgroup namespaces, and a network namespace of
  its own unless `network` (`--unshare-all` [+ `--share-net`]);
  `--die-with-parent`, `--new-session`, `--cap-drop ALL`;
- `/usr`, `/bin`, `/sbin`, `/lib*`, `/etc` and `/nix/store` read-only (merged
  `/usr` links recreated); a fresh `/proc` (its own pid namespace), `/dev`
  and `/tmp`;
- the owner's `$HOME` replaced in place by an empty tmpfs: `~/.ssh`,
  `~/.claude`, `~/.aws`, gcloud, netrc and keychains are simply not there;
- read-only: Node's install prefix, the plugin's directory, and the package
  stores its `node_modules` links point into (a pnpm workspace's store and
  sibling packages, followed a few levels; a link target counts only if it is
  a store or a folder with a `package.json`); `${tsx}`'s store when used; the
  real `resolv.conf` when it lives under `/run`;
- owner folders as declared; any folder that overlaps a credential store,
  `$ORBIT_HOME`, the plugin store, `/dev`, `/proc`, `/sys`, `/run` or
  `/var/run` is dropped (so `FS_ROOTS=~` never re-opens `~/.ssh`), and the
  plugin's status says which;
- denied paths that lie inside a bind are masked (a tmpfs, or `/dev/null`
  for a file), before the workspace is bound — `$ORBIT_HOME` is absent even
  when the Bot's workspace inside it is shown;
- the workspace read-only or read-write only as declared; for a worktree Bot,
  the owner repository's common git directory with the same access, its
  `config`, `hooks` and `info` bound read-only on top (a plugin cannot plant
  a hook or filter for the owner's own git);
- working directory: the workspace when bound, else the empty home;
  `TMPDIR=/tmp`.

**Profile (macOS, Seatbelt).** A deny-default profile written only with
allow rules that never conflict (`require-all`/`require-not`, so rule order
does not matter): reads everywhere except the home, `$ORBIT_HOME`, the denied
paths and the shared temporary folders, plus the plugin, its runtime and
folders, the workspace and a private directory; metadata reads everywhere
(path resolution needs them); writes only to the private directory and to
writable folders and the workspace (a git directory without config, hooks
and info); network only when declared; a short list of system services.
macOS cannot hide `$HOME` in place, so HOME and TMPDIR point at the private
directory (removed when the process exits).

**Chromium.** Investigated: under bubblewrap Chromium keeps its own sandbox
— it needs nested unprivileged user namespaces, which bwrap does not block
(checked in the dev container as a non-root user; CI's e2e job runs the
test as one); Orbit never passes `--no-sandbox`. Seatbelt profiles do not
nest, so on macOS a `nestedSandbox` plugin is `unsandboxed` in `auto` (with
that reason) and refused in `required`.

**Reporting.** `PluginStatus.sandbox` (`sandboxed | unsandboxed | refused |
off | remote`, engine, reason, needs) and `source` reach the App (a badge and
a sentence on each card, the enable confirmation), `orbit plugin show`, the
TUI and doctor (`sandbox.plugins`: mode, availability, enabled plugins that
run without it; warnings `plugin_sandbox_off`, `plugin_unsandboxed`,
`plugin_sandbox_refused`).

### 2. DNS-checked browsing

The filter proxy resolves every allowed name itself, once (`dns.lookup`,
all answers), and refuses it when **any** answer is private, loopback,
link-local, CGNAT (100.64/10), unique-local (fc00::/7), multicast, reserved
(documentation, benchmarking, 240/4, Teredo, …), unspecified, cloud metadata
(169.254.169.254, fd00:ec2::254), or an IPv4-mapped, IPv4-compatible, NAT64
or 6to4 form of one of those. Exceptions: an IP literal the owner listed
exactly, and the new setting `BROWSER_ALLOW_PRIVATE_ADDRESSES=true` for
intranet sites (metadata, unspecified, multicast and reserved stay refused
even then). The connection goes to exactly the checked addresses (a pinned
`lookup`), so a second, different answer never reaches it. Chromium resolves
nothing itself: `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1`
on top of the proxy for every scheme, no DNS prefetch, no QUIC, no background
networking, WebRTC kept off non-proxied UDP. Through an owner proxy
(`HTTPS_PROXY`) that proxy resolves for itself: Orbit refuses a private
answer it sees locally and passes on names that do not resolve locally (the
owner's proxy is their egress policy).

### 3. The plugin catalog and npm installs

**Catalog.** A JSON index (`PluginCatalog` in `@orbit/core`):
`schemaVersion`, a description, and entries with `id`, name, description,
npm `package`, exact `version`, `integrity` (SRI sha512) and optionally the
`manifestHash`. Default URL `plugins.catalogUrl` (`ORBIT_PLUGIN_CATALOG_URL`;
https, http on loopback, or `file:`) is this repository's
`plugins/catalog.json` on `main`. **It lists no plugins today**: no
third-party plugin has been reviewed and published, and the reference
plugins ship with Orbit. The file is the schema in use and the place where
reviewed entries will go.

**Install** (`POST /v1/plugin-installs`, owner only like every API route;
`orbit plugin install <id>` or `npm:<package>@<version> --integrity
sha512-…`; Settings → Integrations "Install from catalog"):

1. orbitd downloads `<registry>/<name>/-/<name>-<version>.tgz` from
   `plugins.npmRegistry` (`ORBIT_NPM_REGISTRY`, default
   `https://registry.npmjs.org`, https or loopback http), capped in size;
2. checks the SRI **before reading a byte of it** (constant-time compare);
3. unpacks it with a strict extractor (gzip + ustar with checksums; regular
   files and folders only — symlinks, hard links, devices, FIFOs, GNU long
   names and pax `linkpath`/`size` are refused; no absolute paths, `..`, `.`,
   backslashes or control characters; one top-level folder; no duplicates or
   entries inside a file; limits on size, count, depth and gunzip output),
   validating everything before writing; files 0644 (never executable),
   folders 0755, created exclusively in a fresh staging folder;
4. requires `package.json` to name the requested package and version, the
   manifest id to match the catalog entry and, when the catalog names one,
   the manifest hash; the stdio server must be `${node}` running a
   JavaScript file inside the package (no other executable, no Node options
   before it, no `${tsx}`, no http servers — add those by folder);
5. a dry run reports what it would install (integrity, manifest hash, tools
   with effective tiers, secrets, settings, env, sandbox needs, file count)
   and keeps nothing; the CLI shows it and asks `y` unless `--yes`, the App
   shows it in a confirmation;
6. otherwise the package moves to `<store>/<id>@<version>/package`, Orbit's
   record (`install.json`) goes beside it, and it is registered like a folder
   the owner added: off until enabled; enabling shows exactly what it gets
   and pins the manifest hash. Nothing in the package runs during an install
   (no scripts, no `npm install`).

**Store.** `plugins.storeDir` (`ORBIT_PLUGIN_STORE`), default
`$XDG_DATA_HOME/orbit/plugins` (`~/.local/share/orbit/plugins`; macOS
`~/Library/Application Support/Orbit/plugins`). Never inside `$ORBIT_HOME`
(orbitd refuses to start with such a store): Bots write under `$ORBIT_HOME`,
and the M7 rule that refuses plugin folders there has the same reason. The
store is a denied path for every plugin (the Filesystem plugin refuses it; no
sandbox binds it), `orbit plugin add` refuses folders inside it, and
removing an installed plugin deletes its files (only inside the store, only
where Orbit's record is). Installs are recorded beside the package, not in
the database, so no migration is needed.

## Consequences

- With bwrap installed (CI's check job now installs it), every plugin the
  API, CLI and App tests start runs sandboxed; real-sandbox tests prove a
  plugin cannot read the real home or `$ORBIT_HOME`, cannot write outside its
  binds and has no network unless declared, and that the Filesystem, GitHub
  (`git_commit`) and Browser (Chromium) plugins work inside it.
- Owner-added plugins without a `sandbox` section get no network under the
  sandbox; their owners declare what they need (a hash change, so they review
  and enable again). Existing enabled reference plugins show `changed` once
  after the upgrade (their manifests gained the section) and need enabling
  again.
- Not verified live: the macOS profile (no macOS here; `auto` turns it on
  there, a plugin that fails shows the error at enable and `off` is the
  escape hatch), and npm installs against the real registry (a local fake
  registry serves tarballs built in the tests).
- Residual: a sandboxed GitHub plugin sees the owner repository's whole git
  directory read-write (objects and other branches' refs), except its config,
  hooks and info; narrowing that to the Bot's own refs is future work. Linux
  system folders (`/etc`, `/usr`) stay readable. A link in an owner-added
  folder's `node_modules` can make a package folder outside it readable.
