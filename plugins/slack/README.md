# Slack plugin

Orbit's reference Slack plugin (ADR-014): a Bot can read the channels its
Slack app is a member of, look people up, and post messages or add reactions,
with your approval.

## Tools

| Tool                  | Tier     | What it does                                                                     |
| --------------------- | -------- | -------------------------------------------------------------------------------- |
| `list_channels`       | READ     | Public and private channels the bot is a member of (`conversations.list`)        |
| `get_channel_history` | READ     | Recent messages of a channel, oldest first, up to 50 (`conversations.history`)   |
| `get_thread_replies`  | READ     | A thread's parent and replies (`conversations.replies`)                          |
| `lookup_user`         | READ     | A user's name and real name (`users.info`); never their email or profile         |
| `post_message`        | EXTERNAL | Post up to 4000 characters to a channel or thread (`chat.postMessage`); asks you |
| `add_reaction`        | EXTERNAL | Add an emoji reaction to a message (`reactions.add`); asks you                   |

READ tools run automatically. EXTERNAL tools always wait for your approval;
Orbit would raise `post_message` to EXTERNAL from its name even if the
manifest said otherwise. Posts never unfurl links or media.

History lines look like
`[1717171717.000100] U123 (thread: 3 replies): text`; use `lookup_user` to
turn a user id into a name.

## Setup

1. Create a Slack app at <https://api.slack.com/apps> ("From scratch") in your
   workspace.
2. Under **OAuth & Permissions → Bot Token Scopes** add: `channels:history`,
   `channels:read`, `groups:history`, `groups:read`, `chat:write`,
   `reactions:write`, `users:read`. Install the app to the workspace and copy
   the **Bot User OAuth Token** (`xoxb-…`).
3. Invite the bot to each channel it should see (`/invite @your-app`). It only
   reads channels it is a member of.
4. Store the token and enable the plugin:

   ```sh
   orbit plugin secret slack SLACK_BOT_TOKEN < bot-token.txt
   orbit plugin enable slack
   ```

5. Optional: set `SLACK_DEFAULT_CHANNEL` (a channel id such as `C0123ABCD`) as
   the channel `post_message` uses when the Bot names none.
6. List `slack` in a Bot's `plugins` to let that Bot use it.

### Slack trigger (Socket Mode)

To start Runs from Slack messages, enable **Socket Mode** in the app settings,
create an **app-level token** with the `connections:write` scope (`xapp-…`),
subscribe to the message events you want (for example `message.channels`,
`app_mention`), and store the token:

```sh
orbit plugin secret slack SLACK_APP_TOKEN < app-token.txt
```

Orbit opens the Socket Mode connection outward; nothing listens on a public
URL. The plugin's tools never use the app-level token.

`SLACK_API_URL` (default `https://slack.com/api`) may be set in orbitd's
environment to point the plugin elsewhere (tests use a local fake).

## Security notes

- The bot token comes from Orbit's vault (`plugin_slack_SLACK_BOT_TOKEN`) and
  reaches only this plugin's process; it never appears in a tool result or an
  error, and Orbit's redactor masks it everywhere else.
- Everything read from Slack (messages, names, topics) is written by other
  people. The plugin returns it as plain text (control characters removed,
  continuation lines indented so a message cannot pose as another), and Orbit
  marks the Run tainted after any plugin call: a tainted Run cannot
  auto-allow an EXTERNAL action.
- Channel ids, user ids and message timestamps are validated before any
  request; Slack's `{ ok: false, error }` answers become tool errors naming
  Slack's error code.
- Grant the app only the scopes above; the plugin needs no admin, file or
  email scopes.
