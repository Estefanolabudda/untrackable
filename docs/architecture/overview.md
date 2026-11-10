# Architecture Overview

Untrackable is a monorepo with one shared rule set, two interchangeable
cleaning engines and (currently) one product: a Chromium Manifest V3
extension.

```
untrackable/
├── rules/rules.json                 # single source of truth for trackers + protection signals
├── tests/fixtures/cases.json        # shared conformance cases for every engine
├── packages/core/                   # TypeScript engine + DNR rule compiler (used by the extension)
├── crates/untrackable-core/         # Rust engine (for the future macOS/Linux app, CLI example)
├── apps/browser-extension/          # Chromium MV3 extension (+ Playwright e2e tests)
├── scripts/gen-icons.mjs            # dependency-free icon generator
└── docs/                            # architecture, security, privacy, roadmap, development
```

## Components and data flow

```
                 rules/rules.json
                 /              \
   packages/core (TS)        crates/untrackable-core (Rust)
     │      │                     │
     │      └─ compileDnrRules     └─ desktop app (Phase 2), CLI
     │            │
     │            ▼
     │   chrome.declarativeNetRequest  ◄── settings (chrome.storage.local)
     │   (navigation cleaning, in the browser's network stack)
     │
     └─ cleanUrl()  ← content script (copy), service worker (context menu,
                      shortcut), popup ("Copy clean link"), options (preview)
```

### Cleaning engine

The engine is a pure function `clean(input, { mode, exceptions }) → result`
with no I/O. It is specified in [`engine-spec.md`](engine-spec.md). Key
properties:

- **Encoding preservation** – output is produced by raw string surgery on
  the original input, so parameter order, percent-encoding, IDN spelling and
  ports are preserved byte-for-byte. Unchanged input is returned verbatim.
- **Conservative protection** – URLs that look like sign-in, password reset,
  verification, invitation, signed/expiring download or payment flows are
  never modified (`status: "protected"` with a machine-readable reason).
- **Structured results** – status, removed keys (never values) and the
  responsible rule id, which powers the transparent preview in the options
  page.

### Why two engine implementations?

Rust + WebAssembly was considered for the extension. We evaluated it
for the extension and chose TypeScript there:

| Concern       | Rust → WASM in the extension                                                                                                                            | TypeScript in the extension               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Copy cleaning | The `copy` event handler must set clipboard data **synchronously**; WASM must be instantiated in every page's content script (async, ~100 KB per page). | Synchronous, ~26 KB (unminified) bundle.  |
| CSP           | Needs `'wasm-unsafe-eval'` in the extension CSP.                                                                                                        | Default strict CSP (`script-src 'self'`). |
| Navigation    | Not usable either way: navigations are rewritten by `declarativeNetRequest`, which cannot call extension code.                                          | Same.                                     |
| Build/CI      | wasm-pack/wasm-bindgen toolchain.                                                                                                                       | esbuild only.                             |

The Rust crate still exists because the desktop app (Phase 2) needs a native
engine. Divergence risk is controlled by the shared rule file, the shared
fixture file that both test suites execute, and a differential test
(`npm run test:conformance`) that generates tens of thousands of URLs from
`rules.json` – every rule, domain and protection signal plus random spelling,
encoding and structure – and requires byte-identical results from both
engines in CI. New rules are covered without writing new tests; the spec is
the tie-breaker. A WASM build of the Rust crate remains possible later.

## Browser extension

| Capability               | Mechanism                                                                                      | Automatic?                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Navigation cleaning      | `declarativeNetRequest` dynamic rules (`queryTransform.removeParams`) on `main_frame` requests | Yes – before the request leaves the browser |
| Protection               | Higher-priority DNR `allow` rules compiled from protection signals                             | Yes                                         |
| Domain exceptions        | DNR `allow` rule with `requestDomains`                                                         | Yes                                         |
| Global off / timed pause | Dynamic rules removed; `chrome.alarms` restores them                                           | User action                                 |
| Pause in this tab        | DNR **session** `allow` rule with `tabIds`                                                     | User action                                 |
| One-time bypass          | New tab + session `allow` rule, removed when the page finished loading                         | User action (context menu / options)        |
| Copy cleaning            | Content script `copy` listener; only when the selection is exactly one http(s) link            | Yes, on copy                                |
| Copy clean link          | Context menu / Alt+Shift+U / popup button → engine → offscreen document → clipboard            | User action                                 |

### Navigation cleaning (declarativeNetRequest)

MV3 extensions cannot run their own code synchronously for navigations
(blocking `webRequest` is unavailable). `compileDnrRules` therefore turns the
rule set into DNR rules:

| Priority | Rule                                                                                                                    | Ids           |
| -------- | ----------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1        | case-insensitive `regexSubstitution` fallback, global and per domain rule (one remaining tracker per internal redirect) | 500–998       |
| 2        | fallback guard `allow` (6+ `&` after `?`): stops the fallback chain, exact rules still run                              | 999           |
| 3        | global `redirect` (`removeParams`)                                                                                      | 1             |
| 4        | per-domain `redirect` (domain + global parameters, since only one redirect can win)                                     | 100–499       |
| 5        | protection `allow` rules (domains, path keywords/substrings, parameters, combinations, encoded characters)              | 1000+         |
| 6        | user exception `allow` rule                                                                                             | 2000          |
| 7        | per-tab session `allow` rules (pause, one-time bypass, loop retry scoped to one host)                                   | session rules |

Chromium does not redirect when the transformed URL equals the original, so
there are no redirect loops (verified by e2e test).

**Known differences from the engine** (documented, tested in
`packages/core/test/dnr.test.ts`):

- `removeParams` matches keys exactly and case-sensitively, so it handles the
  listed lower-case and ALL-UPPER-CASE spellings in one redirect. Mixed case
  (`Utm_Source`) and unlisted names of prefix rules (`utm_*`) are removed by
  lower-priority, case-insensitive `regexSubstitution` fallback rules (global
  and per domain rule) – one parameter per internal redirect, byte-preserving.
- **How Chromium chooses** (verified in Chromium 153, encoded in
  `packages/core/test/dnr-simulator.ts` and checked against the real browser
  on 200 generated URLs by the e2e suite): URL-pattern rules and regex rules
  each contribute only their highest-priority match; if the winner is a
  redirect that would not change the URL, the other kind's candidate is
  tried. The exact rules are therefore kept regex-free, so the regex fallback
  can run after them.
- **Redirect limit:** Chromium aborts after 20 redirects, counted over the
  whole chain including the server's own redirects. A guard `allow` rule
  disables the one-per-hop fallback once a URL has 6 or more `&` after its
  `?` (exact rules still run), so at most 6 fallback hops happen per URL;
  beyond that, mixed-case or unlisted trackers are left in place instead of
  breaking the page (e2e: 25 unlisted `utm_*`; two server hops each adding
  five unlisted trackers).
- **Valueless and empty segments:** when an exact rule removes something,
  Chromium re-serialises the query – `?edit&utm_source=1` becomes
  `?edit=`, an empty segment in the middle becomes `=`, a trailing `&` is
  dropped. Servers treat `edit` and `edit=` alike in practice, but the result
  is not byte-identical to the engine (copy cleaning is). Avoiding this would
  require regex conditions on the exact rules, which disables the fallback
  (see above), so it is documented instead.
- DNR cannot percent-decode. URLs whose path or any parameter key contains a
  percent-encoded letter, digit, `-`, `.`, `/` or `_` are therefore left
  completely alone during navigation (e.g. `utm%5Fsource` is not removed, `/%6Cogin` is not
  cleaned). Encoded non-ASCII paths (`/stra%C3%9Fe`) are still cleaned.
- Fragments are never sent to servers; navigation cleaning does not touch
  them and **cannot see fragment-based protection signals**. Example:
  `/a?utm_source=x#access_token=…` becomes `/a#access_token=…` (the engine
  would leave it unchanged). The fragment itself is preserved by the browser,
  so implicit-flow tokens still reach the page.
- Only `main_frame` navigations are cleaned. Sub-frames, `fetch`/XHR and
  links rewritten by page scripts after load (e.g. `history.replaceState`)
  are not modified.

The safety property is enforced by tests (simulated in
`dnr.test.ts`, spot-checked in real Chromium in the e2e suite): apart from the
fragment case above, DNR never modifies a fixture URL that the engine reports
as protected, excepted or unchanged, and never removes a parameter the engine
keeps.

**Redirect loops:** if a server insists on a tracking parameter and redirects
back to a URL containing it, Chromium aborts with `ERR_TOO_MANY_REDIRECTS`.
DNR cannot observe this. Users can enable a _reload offer_ in the settings,
which requests the optional `webNavigation` permission (its warning is
already covered by the host permission). Untrackable then marks such a tab
with a `↻` badge, and the popup offers **Reload once without cleaning**.
Safeguards (three review rounds, each covered by e2e tests):

- never automatic – an extension-initiated load is treated like a typed URL
  (no Referer, SameSite=Strict cookies sent);
- the button installs a one-time bypass for the failed page's host in that
  tab and calls `tabs.reload` on the tab's own error page – Untrackable never
  navigates to a stored or page-supplied URL and stores only the host;
- no offer when the failing URL is protected or excepted (our rules cannot
  have caused that loop);
- at most one reload per tab per minute;
- an offer disappears on the tab's next successful top-level navigation, on
  tab close, on permission removal and after 10 minutes;
- a redirector cannot use the bypass to forward trackers to another site.

Without the permission the user resolves a loop with a site exception, the
tab pause or "Open link without cleaning".

**Rule installation safety:** `updateDynamicRules` is atomic, so one rule
Chromium cannot compile would block the whole update. The service worker
checks every regex with `isRegexSupported`, drops unsupported fallback rules,
installs **no** redirects if any protection rule is unsupported (fail safe),
and retries without the optional fallback rules if an update still fails. An
e2e test asserts that every compiled rule is actually installed.

### Copy cleaning

How it works: the content script listens for a trusted Ctrl/Cmd+C or
Ctrl+Insert keystroke (matched by physical key and by character, so Dvorak
and non-Latin layouts work). On the following copy event it does **not**
touch the event; it reads the selection and, if it is exactly one http(s)
link, sends it to the service worker. The service worker applies the
settings (switch, mode, exceptions, global and tab pause) and, if the engine
cleans the link, writes the clean link through the offscreen document right
after the native copy. Consequences:

- Web pages cannot observe whether, or how, Untrackable reacted – settings
  and exceptions never reach the page process (this replaced an earlier
  design that set the clipboard data in the copy event, which pages could
  probe; found in review).
- If you paste within a few milliseconds, you may still get the original
  link.
- Orphaned content scripts (extension disabled, reloaded or updated) detach
  themselves instead of acting on stale settings.

Limits:

- Text that merely _contains_ links is copied unchanged.
- Copying via the browser's Edit/context menu, touch gestures, the address
  bar or the native "Copy link address" is not cleaned; use the context-menu
  item "Copy clean link" instead. The address bar is usually already clean
  thanks to navigation cleaning.
- Inputs inside shadow DOM, selections inside iframes and editors that
  replace the copied data with their own (e.g. some rich-text editors) are not
  covered.
- Clipboard operations in other applications are out of reach.

## Future desktop compatibility (Phase 2)

The Rust crate exposes `Engine::clean`, serde-serialisable results (JSON
shape identical to the TS engine) and an example CLI
(`cargo run --example clean -- --strict URL`). A desktop app can register as
the default URL handler, clean the URL with the crate and forward it to the
preferred browser. A system-wide URL handler only sees links handed to the
OS; links opened inside an application's own web view are out of reach.
