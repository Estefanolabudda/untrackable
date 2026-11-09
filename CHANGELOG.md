# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
