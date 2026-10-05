# Browser plugin

A headless Chromium, driven by [playwright-core](https://playwright.dev), that
can open and read web pages and fill in forms, but only on the domains you
allow. One of Orbit's reference plugins (ADR-014).

## Tools

| Tool         | Tier         | What it does                                                                                                       |
| ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `open_page`  | READ, egress | Opens an http(s) URL on an allowed domain; returns the final URL, title and visible text (up to 20,000 characters) |
| `get_text`   | READ         | Visible text of the current page, or of the elements matching a CSS selector                                       |
| `list_links` | READ         | Address and text of up to 100 links on the current page; links outside the allowlist are marked                    |
| `click`      | EXTERNAL     | Clicks the first element matching a CSS selector (it may submit a form)                                            |
| `fill`       | EXTERNAL     | Types a value (up to 2,000 characters) into the first field matching a CSS selector                                |

`open_page` is an **egress** READ, like `WebFetch`: the URL the Bot chooses
reaches a website, so it runs without asking while the Run is clean, and asks
you once the Run has seen untrusted content (which can try to make the Bot
put data into a URL). Everything this plugin returns is untrusted page
content, so the first page a Run reads taints it: later `open_page` calls
then wait for your approval. `click` and `fill` always ask you.

## Settings

| Setting                           | Required | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWSER_ALLOWED_DOMAINS`         | yes      | Comma-separated host names. `example.com` allows exactly that host; `*.example.com` allows its subdomains at any depth (not `example.com` itself; list both if you want both). IP addresses are allowed only when listed exactly; a wildcard never covers one. Case, a trailing dot and the port do not matter; international names may be written either way (`bücher.de` or `xn--bcher-kva.de`). An entry with a scheme, port, path, a bare `*` or a wildcard over a single label (`*.com`) is refused. |
| `BROWSER_EXECUTABLE`              | no       | Path to a Chromium binary. Default: Playwright's own Chromium (headless shell).                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `BROWSER_ALLOW_PRIVATE_ADDRESSES` | no       | `true` lets allowed names resolve to private, loopback, link-local, CGNAT or unique-local addresses (an intranet site). Default `false`: such answers are refused. Cloud metadata, unspecified, multicast and reserved addresses are refused even then. An IP address you list exactly in `BROWSER_ALLOWED_DOMAINS` is always reachable.                                                                                                                                                                  |

Environment passed through from orbitd: `PLAYWRIGHT_BROWSERS_PATH` (where
Playwright's browsers are installed). No secrets.

## Setup

```sh
# once, if Playwright's Chromium is not installed yet
npx playwright-core install chromium

orbit plugin setting browser BROWSER_ALLOWED_DOMAINS 'example.com,*.wikipedia.org'
orbit plugin enable browser
```

Then list `browser` in a Bot's `plugins`.

## Security

- **Only the allowed domains, on every request.** The allowlist is checked
  for every request a page makes, not only the address the Bot opens:
  subresources, `fetch`/XHR, beacons, frames, popups, workers and redirects.
  Two layers enforce it. Playwright request routing aborts any request to a
  host that is not allowed. And the browser's only way out is a loopback
  proxy inside the plugin process (`--proxy-server`, loopback included),
  which checks every request and `CONNECT` tunnel again before connecting;
  it catches what Playwright's routing does not see, such as redirect
  targets. An owner proxy in the environment (`HTTPS_PROXY`, `NO_PROXY`) is
  chained behind it.
- **Checked DNS answers (ADR-019).** The proxy resolves every allowed name
  itself, once, and refuses it if any answer is private, loopback,
  link-local, CGNAT (100.64/10), unique-local (fc00::/7), multicast,
  reserved, unspecified, a cloud metadata address (169.254.169.254,
  fd00:ec2::254) or an IPv4-mapped, NAT64 or 6to4 form of one, unless you
  listed that exact address or set `BROWSER_ALLOW_PRIVATE_ADDRESSES`. It then
  connects to exactly the addresses it checked, so a second, different DNS
  answer (rebinding) never reaches the connection. Chromium resolves no name
  itself: every name maps to "not found" (`--host-resolver-rules`), DNS
  prefetch, QUIC and background requests are off, and all traffic goes to the
  proxy. Through an owner proxy (`HTTPS_PROXY`), that proxy resolves for
  itself: Orbit still refuses a private answer it sees locally, and passes on
  names it cannot resolve locally.
- **Web pages only.** `open_page` takes http and https URLs only (no
  `file:`, `data:`, `javascript:`, `chrome:`, `about:` or `view-source:`), and
  refuses URLs with a user name or password; pages cannot load other
  schemes either.
- **No WebSockets, downloads, permissions or service workers.** Page
  WebSockets are closed before they connect, downloads are refused, no
  browser permission is granted, service workers are blocked, and WebRTC may
  not use UDP outside the proxy.
- **A fresh incognito browser per Run segment.** Orbit starts the plugin
  process per segment; it launches one Chromium lazily, with an empty
  profile, and closes it when the process ends (stdin closed or a signal).
  Nothing (cookies, storage, history) carries over between Bots or Runs.
- **Narrow environment.** Chromium gets the plugin's own environment, which
  Orbit builds from an allowlist (never an API key or OAuth token), passed
  explicitly. Chromium's sandbox stays on unless the process runs as root,
  where Chromium cannot use it. On Linux distributions that restrict
  unprivileged user namespaces (Ubuntu 23.10+ with AppArmor), Chromium refuses
  to start ("No usable sandbox"); allow them
  (`sysctl kernel.apparmor_restrict_unprivileged_userns=0`, or an AppArmor
  profile for Chromium) rather than turning the sandbox off.
- **Untrusted output.** Page text, titles and links are data, never
  instructions; the tool descriptions say so and Orbit taints the Run.

- **In an OS sandbox** (ADR-019, `plugins.sandbox`): on Linux the plugin and
  its Chromium run under bubblewrap with the network but without your home
  folder, Orbit's data or the Bot's workspace; Chromium keeps its own sandbox
  inside (it needs unprivileged user namespaces, as above). The sandbox shows
  Playwright's browsers from `PLAYWRIGHT_BROWSERS_PATH`, the folder of
  `BROWSER_EXECUTABLE`, or Playwright's default cache. macOS `sandbox-exec`
  profiles do not nest, so there the Browser runs without an OS sandbox
  (`auto`) or not at all (`required`).

Known limit: page JavaScript runs, so a page on an allowed domain can send
what it sees (including what `fill` typed) back to its own site; approve
`fill` only for sites you trust with that value.

## Development

```sh
npx vitest run --project @orbit/plugin-browser
```

The allowlist and proxy tests need no browser. The Chromium tests (local
`node:http` servers on 127.0.0.1, no internet) run when Playwright's Chromium
is installed (`PLAYWRIGHT_BROWSERS_PATH` or `BROWSER_EXECUTABLE`) and are
skipped otherwise.
