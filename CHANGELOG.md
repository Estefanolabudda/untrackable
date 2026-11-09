# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Navigation cleaning of mixed-case spellings (`Utm_Source`) and unlisted
  `utm_*` names via case-insensitive declarativeNetRequest fallback rules.
- Optional redirect-loop helper (optional `webNavigation` permission, off by
  default): a `↻` badge and a "Retry once without cleaning" button in the
  popup. Never retries automatically.
- Differential conformance test generating >50,000 URLs from `rules.json`
  (incl. control characters, `+`/non-ASCII/invalid-UTF-8 keys, encoded path
  words, fragments) and requiring identical TypeScript and Rust results, plus
  validation parity on mutated rule sets (CI job).
- Case-insensitive fallback for domain-specific trackers; guard keeps the
  fallback chain below Chromium's redirect limit.
- e2e test comparing the DNR model with real Chromium on generated URLs.
- Rust toolchain pinned (`rust-toolchain.toml`); weekly scheduled CI for new
  advisories.

### Changed

- Rule files are validated strictly and identically in both engines: unknown
  fields, `null` lists and missing protection lists are rejected.
- Protection tuned against over-protection of ordinary links.

### Fixed

- Redirect-loop recovery could retry forever, could forward trackers to
  another site, and – being automatic – let pages trigger browser-initiated
  requests that bypass SameSite/Referer CSRF defences; now explicit only.
- Copy cleaning could be probed by page scripts (execCommand after a click or
  right-click); now requires a keyboard copy with unchanged selection.
- Navigation: `code`+`state` protection also matches valueless adjacent keys;
  fallback guard lowered to 6 `&` so redirect chains stay below the limit.
- A rule Chromium cannot compile no longer blocks the whole rule update;
  unsupported protection rules disable redirects (fail safe).

## [0.1.0] – release candidate

### Added

- Shared tracker rule set with Clean and Strict rules and domain-specific rules.
- Protection heuristics for OAuth/OIDC/SAML, password reset, verification,
  invitation, signed/expiring download and payment URLs.
- TypeScript cleaning engine and Rust cleaning engine with 130 shared
  conformance fixtures and property-based tests (fixtures also run inside Chromium).
- Chromium MV3 extension: automatic navigation cleaning, copy cleaning,
  "Copy clean link" / "Copy clean page link" / "Open link without cleaning"
  context menu items, Alt+Shift+U shortcut, Clean/Strict modes, global off,
  15-minute pause, per-tab pause, one-time bypass, domain exceptions, popup
  and options page with link preview.
- Chromium end-to-end test suite, GitHub Actions CI, dependency audits,
  reproducible extension packaging.
