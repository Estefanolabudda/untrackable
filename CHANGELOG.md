# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Optional local statistics** (off by default): how many tracking
  parameters Untrackable removed today, in the last 7 days and in total, shown
  in the popup and the settings. Only removals Untrackable can confirm are
  counted; only numbers are stored, on this device. Uses the optional,
  read-only `webRequest` permission while switched on; turning it off deletes
  the numbers.

### Changed

- **Redesigned popup and settings page**: a clear status header with the
  main switch, a mode choice with one-line explanations, real switches for the
  site exception and the tab pause, a single primary action, light and dark
  themes, larger type (Chromium's extension pages shrank text to 10.5 px),
  visible focus, high-contrast support, and a new icon (a link whose query is
  cut off).

### Security and reliability

- Regression corpus of 259 sensitive real-world URL shapes (sign-in, reset,
  payment, signed downloads, banking/government, CSRF), checked per mode in
  both engines and against the navigation rules.
- Experimental mode keeps the query of sign-in and payment hosts (first host
  label `login`, `signin`, `auth`, `oauth`, `sso`, `idp`, `id`, `accounts`,
  `account`, `secure`, `pay`, `payment(s)`, `checkout`, `banking`) and of
  OAuth requests (`client_id`, `code_challenge`) and Microsoft device login
  (`otc`). Clean and Strict are unchanged.
- Settings carry a format version and are migrated conservatively on install,
  update and browser start; context menus are refreshed on every update.
- Upgrade tests install the published 0.1.0 and 0.2.0 releases (checksums
  verified), update them in place as documented (replace the folder, reload)
  and check settings, menus,
  rules and navigation.
- The full end-to-end suite also runs on Chrome for Testing 116 (minimum
  supported version) and 157 (stable); no functional differences found, only
  a harmless empty `?` that older versions leave after removal.

### Maintenance

- Dependabot: `@types/node` majors (must match Node 22) and `playwright`
  (pinned to the development container's Chromium) are updated deliberately;
  `bit-vec` (dev-only) patch update.

## [0.2.0] – 2026-11-11

### Added

- **Experimental mode – strip query parameters** (opt-in, never default):
  removes the whole query string of links, known tracker or not, while
  keeping scheme, host, path and fragment. Sign-in, payment, signed and
  expiring links that Untrackable recognises keep all their parameters; an
  Experimental-only protection list (`experimentalParams`: OAuth
  `code`/`state`, CSRF, payment return, expiry, login-redirect targets) adds
  names that are too common to protect in Clean/Strict. Only `GET`
  navigations are rewritten. Badge `E`.
- Activating Experimental shows a warning and needs an explicit confirmation;
  a "Back to Clean" button is shown while it is active (popup and settings).
- Experimental leaves wrapped links alone (a parameter value that is an
  http(s) URL: Outlook SafeLinks, Google/Facebook redirects) and cleans
  keyboard copies with the Strict rules instead of stripping them.
- Context menu on links: **Copy link without query parameters** and **Open
  link without query parameters** – explicit one-off actions in every mode.
- Rule schema: optional `protection.experimentalParams`; both engines and the
  differential test support the new mode.

### Changed

- The popup labels the master switch as Bypass when off and describes the
  three cleaning modes.
- Navigation protection rules also match parameter signals in the fragment
  (Chromium matches rules against the URL including `#…`), as the engine
  always did: e.g. `?utm_source=x#access_token=…` is now left unchanged
  while navigating, too.
- Signed Discord/Meta CDN URLs (`ex`+`hm`, `oh`+`oe`), nginx secure links
  (`st`+`e`), Computop returns (`Len`+`Data`), Akamai `hdnea` and the CSRF
  parameters `sesskey`/`logouthash` are protected in every mode.
- A plain anchor named like a protection signal (e.g. `#api-token`) now also
  stops navigation cleaning – the safe side of matching fragment keys.
- `npm audit`: dev-only `minimatch` advisory fixed with an exact override.
- The extension zip is reproducible regardless of umask (file modes
  normalised; CI checks it).
- Settings are saved key by key, so concurrent changes cannot undo each
  other.
- If the cleaning rules cannot be installed, the badge shows `!` and stale
  rules of another mode are removed.

## [0.1.0] – 2026-11-11

First release. Chromium extension (Phase 1) and reusable cleaning engines.

### Added

- **Rules:** shared tracker rule set (`rules/rules.json`) with Clean and Strict
  rules and domain-specific rules; strict, identical validation in both
  engines.
- **Protection** for sign-in (OAuth/OIDC/SAML), password reset, e-mail
  verification, invitations, unsubscribe/preference centres, signed and
  expiring downloads (S3, GCS, Azure, CloudFront, Akamai) and payment pages.
- **Engines:** TypeScript engine (extension) and Rust engine (future desktop
  app, CLI example) with 157 shared conformance fixtures, property-based tests
  and a differential test that requires identical results on >50,000 URLs
  generated from the rule file.
- **Chromium MV3 extension:**
  - automatic navigation cleaning via declarativeNetRequest, including
    mixed-case spellings (`Utm_Source`) and unlisted `utm_*` names;
  - keyboard copy cleaning (Ctrl/Cmd+C, Ctrl+Insert) that pages cannot
    observe;
  - context menu "Copy clean link", "Copy clean page link", "Open link
    without cleaning"; shortcut Alt+Shift+U;
  - Clean / Strict / Bypass: global off, 15-minute pause, pause in a tab,
    one-time bypass, domain exceptions;
  - optional redirect-loop helper (optional `webNavigation` permission, off by
    default): `↻` badge and "Reload once without cleaning";
  - popup and options page with link preview; badge states `S`, `off`, `!`,
    `↻`.
- **Quality:** Chromium end-to-end suite (incl. a check of the DNR model
  against real Chromium), GitHub Actions CI (Rust, TypeScript, e2e,
  conformance, dependency audits, weekly schedule), reproducible extension
  zip, pinned Rust toolchain and SHA-pinned actions.
- **Docs:** architecture, engine specification, threat model, privacy
  statement, development guide, manual test checklist, release-readiness
  notes.

### Security and privacy hardening (found in independent reviews before release)

- Copy cleaning no longer modifies the copy event; the service worker
  rewrites the clipboard after every keyboard-copied link (clean or
  unchanged), so neither the event nor clipboard-change notifications reveal
  mode, pause state or exception domains; the latest copy always wins; a
  page's own copy handling is respected.
- Redirect-loop helper never navigates on its own or to a stored URL; only an
  explicit click reloads the failed tab once, with a bypass limited to that
  host; only the host name is kept, briefly.
- Orphaned content scripts stop acting after the extension is disabled or
  updated.
- "Open link without cleaning" no longer sends a request twice (one-time links
  stay valid), covers redirectors in front of the destination and ends as
  soon as the destination commits.
- Rule installation is fail-safe: a protection rule Chromium cannot compile
  disables redirects instead of cleaning unprotected.
- Message authorisation by extension origin; offscreen clipboard writer only
  accepts the service worker; no network requests, telemetry or URL logging.

### Fixed before release (maintainer test, 2026-11-11)

- A ChatGPT e-mail deep link (`…/images?…&auth_modal=1&login_hint=…&utm_*`)
  could end in "too many redirects": such links start a sign-in flow, and a
  site that restores the original URL after sign-in loops if parameters are
  stripped. URLs carrying the OpenID Connect hints `login_hint`,
  `id_token_hint` or `domain_hint` are now protected (left unchanged).
- The redirect-loop helper no longer blames tracker cleaning when the page
  also fails after "Reload once without cleaning"; it says the loop is
  probably not caused by Untrackable and points to "Pause in this tab".
- The popup no longer shows the redirect-loop notice ("failed with too many
  redirects" and its reload button) when there was no loop: a layout rule
  overrode the `hidden` attribute.
- Checked on report: `email_id` on `support.stripe.com` is intentionally kept
  (also in Strict). Its observable use is Stripe's own analytics (passed to
  the support widget, recorded via an analytics allowlist), but removing it is
  not shown to be harmless for logged-in support flows. A Strict rule limited
  to `support.stripe.com` is described in `docs/architecture/overview.md`,
  pending a logged-in test.

### Known limitations

See `README.md` ("Known limitations") and `docs/release/release-readiness.md`.
