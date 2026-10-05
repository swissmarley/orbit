# GitHub plugin (`github`)

Orbit's reference plugin for GitHub (ADR-014). A Bot can read issues and pull
requests, comment, open issues and pull requests, and commit and push from its
own workspace. It also closes the M2 deferral for worktree Bots: a worktree's
`.git` lives outside the engine sandbox, so the Bot cannot commit from there.
Commits and pushes go through this plugin, which runs git outside the sandbox
with the safeguards listed below.

## Tools

| Tool                  | Tier        | What it does                                                                  |
| --------------------- | ----------- | ----------------------------------------------------------------------------- |
| `list_issues`         | READ        | List a repository's issues (pull requests left out)                           |
| `get_issue`           | READ        | Read an issue with its latest comments (bodies cut at about 8000 characters)  |
| `list_pull_requests`  | READ        | List a repository's pull requests                                             |
| `get_pull_request`    | READ        | Read a pull request, its size and the files it changes                        |
| `comment_on_issue`    | EXTERNAL    | Comment on an issue or pull request                                           |
| `create_issue`        | EXTERNAL    | Open a new issue                                                              |
| `create_pull_request` | EXTERNAL    | Open a pull request (head: the workspace's branch, base: the default branch)  |
| `git_status`          | READ        | The workspace's branch, staged, unstaged and untracked files                  |
| `git_diff`            | READ        | Staged and unstaged diffs plus untracked file names (capped)                  |
| `git_log`             | READ        | The last N commits                                                            |
| `git_commit`          | WRITE_LOCAL | Commit all changes, or the given paths, on the Bot's own `orbit/<bot>` branch |
| `git_push`            | EXTERNAL    | Push the Bot's own `orbit/<bot>` branch to a remote (default `origin`)        |

READ tools run without asking. EXTERNAL tools wait for your approval (and
always do in a tainted Run). Everything GitHub returns is third-party data: it
taints the Run and is never treated as instructions.

## Secrets, settings and environment

| Name                | Kind               | Notes                                                                             |
| ------------------- | ------------------ | --------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`      | secret (optional)  | Needed for private repositories, comments, issues, pull requests and pushes.      |
| `GITHUB_REPOSITORY` | setting (optional) | The repository tools use when a call names none, as `owner/name`.                 |
| `GIT_AUTHOR_NAME`   | setting            | Author and committer name of the Bot's commits (default `Orbit Bot`).             |
| `GIT_AUTHOR_EMAIL`  | setting            | Author and committer email (default `orbit-bot@localhost`).                       |
| `GITHUB_API_URL`    | env passthrough    | API base URL copied from orbitd's environment (default `https://api.github.com`). |

A fine-grained token limited to the repositories the Bot works on is
recommended, with Issues and Pull requests read/write and Contents read/write
(the last only if the Bot pushes).

## Setup

```sh
orbit plugin secret github GITHUB_TOKEN < token-file   # stored in the vault as plugin_github_GITHUB_TOKEN
orbit plugin enable github
```

Set `GITHUB_REPOSITORY` (and the author settings if you like) in Settings →
Integrations, then add `"github"` to a Bot's `plugins` list. Only Bots that
list the plugin can use it.

## Security notes

- **Hooks never run.** Every git command gets `core.hooksPath=/dev/null`
  (commits and pushes also pass `--no-verify`), so nothing the Bot wrote into
  the repository executes. `commit.gpgSign=false`, `core.fsmonitor=false` and
  `protocol.ext.allow=never` and `log.showSignature=false` are set too, and git never prompts
  (`GIT_TERMINAL_PROMPT=0`).
- **Configuration only through the environment.** git runs through
  `execFile` (never a shell). Its configuration is passed only as
  `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, never with
  `-c` on the command line. Inherited `GIT_*` variables are dropped.
- **The token stays in the environment.** For the REST API it goes only into
  the `Authorization` header. For a push to an `https://github.com/` remote it
  is passed as an `http.https://github.com/.extraheader` value in
  `GIT_CONFIG_*`. git scopes that header to github.com itself, so a rewritten
  remote URL never carries it elsewhere. The raw token is never on a command
  line, never in git's environment, and is scrubbed from every result and error.
- **Only the repository and branch Orbit names.** Orbit passes a worktree
  Bot's repository and branch (`ORBIT_GIT_REPO`, `ORBIT_GIT_BRANCH`). git runs
  with an explicit `GIT_DIR` (the worktree's entry in that repository, found by
  its back-pointer to the workspace) and `GIT_WORK_TREE`, so the workspace's
  own `.git` file, which the Bot can rewrite, is never read. Other Bots' kinds
  of workspace get no git tools. `git_commit` and `git_push` refuse unless the
  worktree is checked out on exactly the Bot's own `orbit/<bot>` branch.
- **The approval names what is pushed.** `git_push` takes the branch and the
  commit sha, so the approval card shows both; it pushes exactly
  `<sha>:refs/heads/<branch>` and refuses if the branch moved since. It never
  forces: a diverged remote gives a clear error instead.
- **Paths are checked.** Paths must be relative, without `..` segments, a
  leading `-` or `:`, or NUL characters, and are taken literally
  (`GIT_LITERAL_PATHSPECS=1`).
- **Pushing needs approval.** `git_push`, like every other tool that leaves
  your computer, is EXTERNAL.

## Development

```sh
npx vitest run --project @orbit/plugin-github   # a fake GitHub API on 127.0.0.1 and real git in temp dirs; no network
```
