# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

## [0.1.0] – unreleased (release candidate)

First release. Chromium extension (Phase 1) and reusable cleaning engines.

### Added

- **Rules:** shared tracker rule set (`rules/rules.json`) with Clean and Strict
  rules and domain-specific rules; strict, identical validation in both
  engines.
- **Protection** for sign-in (OAuth/OIDC/SAML), password reset, e-mail
  verification, invitations, unsubscribe/preference centres, signed and
  expiring downloads (S3, GCS, Azure, CloudFront, Akamai) and payment pages.
- **Engines:** TypeScript engine (extension) and Rust engine (future desktop
  app, CLI example) with 150 shared conformance fixtures, property-based tests
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
  also fails after "Reload once without cleaning"; it says the loop is not
  caused by Untrackable.

### Known limitations

See `README.md` ("Known limitations") and `docs/release/release-readiness.md`.
