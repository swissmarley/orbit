# ADR-021: Guided engine setup in the App and terminal

Status: Accepted

## Context

The welcome screen and doctor explained the active engine but could not
configure it. A user could add a credential while the saved mock driver
continued to force demo mode. Switching to a real engine required terminal
environment variables and a daemon restart, which also signed the browser
out. The same friction affected the terminal UI.

## Decision

- The App's welcome flow and Settings → Engine, `orbit setup`, and the
  full-screen terminal UI use the same typed setup API. Users choose a demo,
  an Anthropic API key, or an existing local Claude Code login and a model.
  Models are aliases or user-supplied IDs, never fixed provider model IDs.
- Only an owner may inspect or change engine setup. The existing Host,
  Origin, session, role, and CSRF checks protect these routes. Hosted and
  environment-managed installations explain their administrative boundary
  instead of silently saving settings that cannot take effect.
- Setup saves an API key in the existing encrypted vault. Neither the key
  nor OAuth credentials enter config.json, responses, audit details, browser
  storage, or terminal history. Browser input is masked and cleared after
  use. The terminal supports hidden input and a standard-input option for
  scripts; an API key is never accepted as a command-line argument.
  A separate, explicit choice removes the saved key and returns to the demo;
  ordinary mode changes retain it for later reuse.
- Mode and default model are saved atomically. Idle-only reconfiguration
  replaces the engine and its credential dependencies without restarting the
  daemon or invalidating browser sessions. Setup refuses to interrupt
  existing work and serializes changes to prevent races with engine use.
- Saving verifies local readiness and detected credentials, not a key's
  validity with the provider. Setup makes no model call. Creating a Bot and
  sending its first real message are explicit user actions; the demo's
  recorded approval scenario is available only with the mock driver.
- Claude Code manages its own login. Orbit never reads or copies its OAuth
  credential. The flow explains how to sign in outside Orbit and recheck.

## Consequences

Users can move from a demo to a real engine without learning environment
variables, editing files, or re-opening a sign-in link. The terminal and web
flows share validation, persistence, and credential handling. A readiness
indicator does not promise a successful provider call; the first real Run
can still fail because of an expired key, billing, or provider availability.
