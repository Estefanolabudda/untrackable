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

### Rule decisions for reported parameters

Parameters reported as "not removed" are only added to a rule once their
purpose is established as tracking **and** removing them is shown not to break
a legitimate function. Otherwise they stay unknown (and are therefore kept);
the decision is recorded here and pinned by fixtures in
`tests/fixtures/cases.json`.

#### `email_id` on `support.stripe.com` – kept (Clean and Strict)

Reported twice from maintainer tests (links from Stripe e-mails, e.g.
`https://support.stripe.com/?email_id=em_…`). Findings (2026-11-11, logged
out, synthetic `em_…` values):

- **No protection rule is involved.** `email_id` is in no rule at all; the
  engine returns `unchanged` (not `protected`), because unknown parameters are
  always kept. `support.stripe.com` is not a protected domain (only
  `checkout.stripe.com` is).
- **Observable use is analytics/attribution.** The server copies the value
  into the URL of the support conversation widget
  (`support-conversations.stripe.com/widget?…&email_id=…`). In the JavaScript
  of both the support site and the widget the name appears only in
  `defaultQueryParamsAllowList` – the list of URL parameters Stripe's analytics
  client may record unredacted, next to `utm_campaign` and similar. Status
  code, redirects and cookies are identical with and without the parameter.
  The `em_` prefix marks a Stripe e-mail message id, i.e. it ties the visit to
  one sent e-mail.
- **Not proven harmless.** Server-side use cannot be observed, and the
  logged-in case (a support e-mail about an open case, chat continuation) was
  not tested. Stripe support is a support/billing flow, so the safe variant is
  kept.

A Strict-only domain rule (`domains: ["support.stripe.com"]`,
`params: ["email_id"]`) would be technically safe in scope – it cannot affect
other sites or `checkout.stripe.com` / `dashboard.stripe.com` – and is the
intended fix **if** a logged-in test shows that a support e-mail link behaves
identically without `email_id`. A global `email_id` rule is ruled out: the
name is generic, and other senders use it functionally (for example in
unsubscribe or preference links, which are protected by path anyway).

#### Other e-mail parameters (checked 2026-11-11)

Removed in Clean already: Mailchimp `mc_cid`/`mc_eid`, HubSpot
`_hsenc`/`_hsmi`, Marketo `mkt_tok`, Vero `vero_id`/`vero_conv`; Omeda
`oly_enc_id` in Strict. Not removed today (unknown, kept) and candidates for a
later, separately reviewed rule change: Klaviyo `_kx`, Eloqua `elqTrackId` /
`elqTrack`, Salesforce Marketing Cloud `sfmc_id` / `sfmc_activityid`,
Listrak `trk_contact`, Bronto `_bta_tid`. Several of these identify the
recipient, but some vendors also use them for on-site sign-in or preference
features (e.g. Kit/ConvertKit `ck_subscriber_id`, MailerLite
`ml_subscriber*`), so each needs its own evidence before it is added.

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
- Fragments are never sent to servers and navigation cleaning does not touch
  them. Chromium does match rules against the URL **including** the fragment
  (verified), so since v0.2 the protection allow rules also look for
  parameter signals after `#` (e.g. `/a?utm_source=x#access_token=…` is left
  unchanged, like the engine does). The engine reads fragment keys only when
  the fragment contains `=`; RE2 cannot express that condition exactly (an
  attempt missed valueless keys such as `#token&a=1` – found in review), so a
  plain anchor named like a signal (`#api-token`) also stops navigation
  cleaning. Over-protection in the safe direction; copy cleaning is exact. A
  fuzzer with ~100,000 URLs per run found no URL the engine protects that
  navigation changes.
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

### Experimental mode – strip query parameters (v0.2)

An opt-in fourth mode for maximum URL minimisation. It is never the default
and needs an explicit confirmation in the popup or settings.

| Aspect               | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is removed      | The whole query string (`?…`) – trackers, functional and unknown parameters alike; no allow- or blocklist. Empty queries (`?`, `?&&`) are left alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| What is kept         | Scheme, host, port, path and fragment, byte for byte (raw string surgery, same as Clean/Strict).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Protected links      | Everything protected in Clean/Strict, plus the Experimental-only names in `protection.experimentalParams` (OAuth `code`/`error`, device codes, WS-Federation, German eID `tcTokenURL`, Firebase `oobCode`, Supabase `token_hash`, CSRF/WordPress nonces, Stripe/PayPal/3-D Secure/GoCardless/Amazon Pay/Worldpay/EU payment returns, short verification/invitation names, Akamai/Wowza/CDN tokens, Dropbox `rlkey`, Drive `resourcekey`, `expires`/`key`, login-redirect targets such as `return_to`) and the signal `value:url` – a parameter value that is itself an (encoded) http(s) URL, i.e. a wrapped link such as Outlook SafeLinks, Google `/url?q=` or Facebook `l.php?u=`. Such URLs keep **all** their parameters – trackers included (see limitations). |
| Exceptions, bypasses | Unchanged: domain exceptions, global off, timed pause, tab pause, one-time bypass and the redirect-loop helper behave as in the other modes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Navigation (DNR)     | One `redirect` rule with `transform: { query: "" }`, `GET` main-frame requests only, guarded by `regexFilter` `^[^?#]*\?[^#]*[^&#]` so no no-op redirect can match. Same protection/exception `allow` rules above it; tracker rules are not installed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Copy cleaning        | Keyboard copies (Ctrl/Cmd+C) are cleaned with the **Strict** rules, not stripped: a silently replaced clipboard must not hold a link that may no longer work. The explicit actions "Copy clean link" (strips in Experimental) and "Copy link without query parameters" strip.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Design decisions:

- **Query only, fragment kept.** The request specification asked to keep the
  fragment; navigation cannot see it anyway, and fragments often carry SPA
  routes or text anchors.
- **Protection still wins.** Stripping is far more likely to break sign-in,
  payment and signed links than tracker removal, so the existing signals plus
  `experimentalParams` apply. A protected URL is left completely unchanged –
  Experimental therefore does **not** remove every query.
- **`experimentalParams` is Experimental-only.** Names such as `code`,
  `state` or `key` are common; protecting them in Clean/Strict would let
  trackers ride along on many ordinary links, where unknown names are kept
  anyway.
- **GET only.** A form `POST` to `/submit?step=2` keeps its query: the target
  query is part of the form's function, and a 307 redirect would resend the
  body.
- **No loop amplification.** The first request already goes out stripped (the
  original URL is never sent, so one-time links are not consumed). A server
  that insists on a query loops until Chromium's 20-redirect limit
  (`ERR_TOO_MANY_REDIRECTS`), the same deterministic failure as in Clean; the
  optional loop helper offers one host-scoped reload.
- **Over-protection is accepted.** A URL protected only by an
  `experimentalParams` name (e.g. a coupon `?code=…`) keeps all its
  parameters, including trackers – Clean would remove those. Falling back to
  Strict cleaning would be nicer, but navigation rules cannot express "skip
  only the strip rule" (an `allow` stops all rules), so the engine stays
  consistent with navigation instead. Broad names that bought little safety
  (`next`, `continue`, `redirect`, `exp`, `expiry`, `md`, and `state` –
  OAuth `code`+`state` is protected as a combination in every mode) were
  dropped in review. A later version may fall back to Strict cleaning for such
  URLs (a higher-priority regex `redirect` with Strict's parameters looks
  expressible in DNR; not yet verified).
- **Not protected (accepted risk):** opaque click trackers whose target is
  not a URL value (SendGrid `/ls/click?upn=`, Mailchimp `/track/click?u=`) –
  they become dead links; one-time or reset links with short, site-chosen
  names (`?t=`, `?k=`, `?inv=`, `/reset?t=` – `reset` is not a path keyword
  because article slugs use it), payment returns with generic names
  (`?id=tr_…`, `tx`/`st`), generic return targets (`return`, `goto`, `url`)
  and signed CDN URLs with one-letter keys. Such links break in Experimental;
  this is the main reason it is experimental. A `POST` answered with a redirect
  to a `GET` page with a query (some payment returns) is stripped as well.
- **Manual actions** "Copy link without query parameters" and "Open link
  without query parameters" (context menu on links, all modes) call
  `stripQuery`, which ignores protection and exceptions – the click is the
  user's explicit intent. "Open" is a plain new-tab navigation to the
  stripped URL: no bypass rule, no retry, later hops are cleaned normally.

### Copy cleaning

How it works: the content script listens for a trusted Ctrl/Cmd+C or
Ctrl+Insert keystroke (matched by physical key and by character, so Dvorak
and non-Latin layouts work). On the following copy event it does **not**
touch the event. After the page's own handlers have run it reports the copy
to the service worker – with the text if the selection is exactly one
http(s) link and the page did not handle the copy itself. The service worker
applies the settings and, for such a link, rewrites the clipboard through the
offscreen document right after the native copy: with the clean link, or with
the same link unchanged if it must not be cleaned (exception, protected URL,
pause). Consequences:

- Web pages cannot observe settings: the copy event is untouched and every
  keyboard-copied link produces the same clipboard-change notifications,
  whatever the mode, pause state or exception list. (Two earlier designs were
  observable – setting data in the copy event, and writing only when
  something was cleaned; both found in review.) Only "copy cleaning switched
  off" is visible, because then nothing is written.
- Only the most recent copy may write, so a slow write never replaces
  something copied afterwards.
- If you paste within a few milliseconds, you may still get the original
  link. The rewrite is plain text.
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
