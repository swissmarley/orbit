# Gmail & Calendar plugin

Orbit's reference Google plugin (ADR-014): a Bot can search and read your
Gmail, write drafts and draft replies, and read and add Google Calendar
events. Sending mail and creating events wait for your approval.

## Tools

| Tool            | Tier        | What it does                                                                                                   |
| --------------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| `list_messages` | READ        | Search mail (`q` uses Gmail search syntax), up to 25: id, thread, from, subject, date, snippet, unread         |
| `get_message`   | READ        | One message: headers, attachment names, and its text (text/plain, or HTML reduced to text; ~20,000 characters) |
| `list_drafts`   | READ        | Drafts in the mailbox: draft id, to, subject, snippet                                                          |
| `create_draft`  | WRITE_LOCAL | Create a draft, or a draft reply in the original thread (`replyToMessageId`); nothing is sent                  |
| `send_draft`    | EXTERNAL    | Send a draft by its id; asks you                                                                               |
| `list_events`   | READ        | Events between `timeMin` and `timeMax` (default: the next 7 days), up to 50, ordered by start                  |
| `create_event`  | EXTERNAL    | Create an event; with `attendees`, Google emails them invitations; asks you                                    |

### Drafting is not sending

`create_draft` is WRITE_LOCAL: the draft stays in your mailbox, where you can
read, edit or delete it, and nothing leaves until a draft is sent.
`send_draft` and `create_event` are EXTERNAL, so every send and every event
(which may email invitations) waits for your approval, and Orbit would raise
`send_draft` to EXTERNAL from its name even if the manifest said otherwise. A
Bot that triages your inbox can therefore prepare replies on its own and hand
you the decision to send them.

## Setup

1. In the Google Cloud console, create (or pick) a project and enable the
   **Gmail API** and the **Google Calendar API**.
2. Configure the OAuth consent screen (an "External" app in testing mode with
   yourself as a test user is enough) and create an **OAuth client ID** of type
   **Desktop app**. Note its client id and client secret.
3. Obtain a refresh token once, granting exactly these scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/calendar.events`

   Any OAuth tool for installed apps works (for example the
   [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) with
   "Use your own OAuth credentials", or a short script with Google's auth
   library); ask for offline access so Google returns a refresh token.

4. Store the three secrets, each from a file, and enable the plugin:

   ```sh
   orbit plugin secret google GOOGLE_CLIENT_ID < client-id.txt
   orbit plugin secret google GOOGLE_CLIENT_SECRET < client-secret.txt
   orbit plugin secret google GOOGLE_REFRESH_TOKEN < refresh-token.txt
   orbit plugin enable google
   ```

5. Optional: set `GOOGLE_CALENDAR_ID` (default `primary`) to use another
   calendar.
6. List `google` in a Bot's `plugins` to let that Bot use it.

`GOOGLE_API_URL` (default `https://www.googleapis.com`) and
`GOOGLE_TOKEN_URL` (default `https://oauth2.googleapis.com/token`) may be set
in orbitd's environment to point the plugin elsewhere (tests use local fakes).

## Security notes

- The client id, client secret and refresh token come from Orbit's vault
  (`plugin_google_<NAME>`) and reach only this plugin's process. The plugin
  exchanges the refresh token for a short-lived access token, keeps it in
  memory only (until shortly before it expires), and never shows a secret or
  the access token in a tool result or an error.
- Mail and event text is written by other people. The plugin returns it as
  plain text (control characters removed, HTML reduced to text, scripts and
  styles dropped), and Orbit marks the Run tainted after any plugin call: a
  tainted Run cannot auto-allow an EXTERNAL action.
- `create_draft` refuses line breaks and control characters in `to`, `cc` and
  `subject` (header injection), validates addresses, and builds the RFC 2822
  message itself (base64 text body, RFC 2047 for non-ASCII headers). A reply
  takes its thread, `In-Reply-To` and `References` from the original
  message's `Message-ID`.
- The scopes above cannot delete mail or change settings; `gmail.compose`
  allows creating and sending drafts, which is why sending is EXTERNAL.
