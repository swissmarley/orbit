# Compliance note: subscription or API key, and who may start Runs

Orbit can run its Bots on two kinds of Claude access. They are not
interchangeable: which one you may use depends on **who** the Bots work for
and **where** Orbit runs. This note explains the rule and how Orbit enforces
it. It is not legal advice; Anthropic's terms are what count — read
[Anthropic's Consumer Terms](https://www.anthropic.com/legal/consumer-terms),
[Commercial Terms](https://www.anthropic.com/legal/commercial-terms) and
[Usage Policy](https://www.anthropic.com/legal/aup).

## The two modes

|                         | **Subscription mode** (CliDriver)          | **API-key mode** (SdkDriver)                                            |
| ----------------------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| Credentials             | your own `claude login` (Claude Pro / Max) | `ANTHROPIC_API_KEY`, an `apiKeyHelper`, Amazon Bedrock or Google Vertex |
| Billing                 | your subscription's usage limits           | pay as you go, per token                                                |
| Who it is for           | **you alone**, on your own computer        | anyone: teams, servers, hosted deployments                              |
| Where orbitd may listen | loopback only (`127.0.0.1`)                | loopback, a container, or hosted mode with TLS and OIDC                 |
| Docker sandbox          | no (your login never enters a container)   | yes                                                                     |

## Why subscription mode is personal-only

A Claude subscription is for the person who holds it. Anthropic does not
allow third parties to offer claude.ai login or subscription rate limits to
other people, so Orbit must never turn your subscription into a service for
anyone else. Orbit therefore allows the CliDriver **only** when all of these
hold, and refuses to start a Run otherwise (with an explanation and the way
to use an API key instead):

- orbitd listens on a loopback address — not on a network address, not in a
  container with a wildcard bind;
- exactly one human principal is configured (you);
- Orbit is not in hosted mode (`ORBIT_MODE=hosted`).

In subscription mode Orbit also:

- never reads, copies, stores, logs or forwards your Claude OAuth credentials
  — your own `claude` binary reads them, Orbit only starts it;
- never passes subscription credentials to the Agent SDK;
- removes `ANTHROPIC_API_KEY` from the CLI engine's environment, so a stray key
  cannot silently switch billing (`orbit doctor` warns when both are present:
  with a key set, Orbit uses pay-as-you-go billing);
- defaults to at most **2** concurrent Runs and caps Runs per day per Bot, so
  always-on Bots do not exhaust the usage you need for your own work, and
  pauses on a usage limit until it resets;
- counts and caps every model call Orbit itself makes outside a Run (post-run
  summaries, the Create Bot proposal) and shows them to you.

## Who may start Runs

A Run spends your Claude access. Orbit only starts Runs on behalf of people
and systems you chose:

- **You**, through the CLI, the TUI or the App (bearer token or App session).
- **Schedules** you configured on a Bot (cron or interval).
- **Delegation** between your own Bots, only to peers you listed.
- **Inbound triggers** you set up:
  - **Webhooks** carry an HMAC signature made with a secret only you mint
    (`orbit trigger webhook-secret`) and give to a system you configure.
  - **Slack** triggers on the subscription engine must list the Slack users
    who may start Runs (`users`); without that list the trigger starts
    nothing. Otherwise anyone in a channel could spend your subscription.
  - **File and git** triggers watch folders and repositories you chose.
- **Hosted mode** (API key only): the principals you list in the config,
  signed in through your OIDC identity provider, with a role each — `viewer`
  (read only), `operator` (start, stop and resume Runs, decide approvals) or
  `owner` (everything, including Bots, policy, secrets, plugins and the kill
  switch). Every action is attributed to the principal in the audit log.

Content from triggers is always treated as untrusted (see the
[security model](security.md)): someone who can send your Bot a Slack message
or an email can influence what it _proposes_, never what it _does_ without
your approval.

## Choosing a mode

- **Just you, on your laptop or workstation:** either mode. Subscription mode
  uses the plan you already pay for; API-key mode adds the Docker sandbox.
- **A shared machine, a server, a team, a container or anything reachable over
  the network:** API-key mode. `docker compose up` and hosted mode require it.
- **Several people using one Orbit:** API-key mode with hosted mode (OIDC
  principals and roles).

`orbit doctor` (and the App's Settings → Auth & engine) shows which mode is
active, why, and what it bills.
