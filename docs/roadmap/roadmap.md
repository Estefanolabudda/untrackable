# Roadmap

## Phase 1 – Chromium extension (v0.1)

- [x] Shared rule set and normative engine specification
- [x] TypeScript engine (extension) and Rust engine (desktop), shared conformance fixtures
- [x] Clean, Strict and Bypass modes
- [x] Protection for sign-in, reset, verification, invitation, signed and payment URLs
- [x] Automatic navigation cleaning (declarativeNetRequest)
- [x] Copy cleaning, "Copy clean link" context menu and keyboard shortcut
- [x] Domain exceptions, global off switch, timed pause, per-tab pause, one-time bypass
- [x] Popup and options page with link preview
- [x] Unit, property-based and Chromium end-to-end tests; CI
- [ ] Chrome Web Store listing (requires maintainer account and approval)

## v0.2 – Experimental mode (released)

- Opt-in "Experimental – strip query parameters" mode with protection of
  recognised sign-in/payment/signed links and an explicit confirmation.
- Context-menu actions "Copy/Open link without query parameters".

## v0.3 – Redesign and local statistics (public beta)

- Redesigned popup and settings page (light and dark, accessibility).
- Optional, local-only statistics of removed tracking parameters (off by
  default, read-only `webRequest` permission, numbers only – see
  `docs/privacy/statistics.md`).
- Regression corpus of sensitive URLs, upgrade tests, Chrome 116/stable
  compatibility CI.
- v0.3.0 is published as a GitHub pre-release (public beta); v0.2.0 remains
  the last regular release.

## Phase 2 – macOS and Linux

Not started. Will only begin once the extension is stable.

- Desktop app registered as default URL handler (`x-scheme-handler/http(s)` on
  Linux via a `.desktop` file, `LSHandlers` on macOS)
- Clean with `crates/untrackable-core`, forward to a preferred browser
- Menu-bar / tray interface with the same modes and exceptions
- Limitation: only links handed to the operating system can be cleaned;
  links opened inside an application's own web view are out of reach

## Phase 3 – Advanced privacy

- Tracking redirect detection (`https://tracker.example/click?url=…`)
- Custom user rules (validated with `validateRuleSet`)
- Signed rule-list updates
- Firefox (MV3 `declarativeNetRequest` support) and other browsers
- WASM build of the Rust engine if it simplifies maintenance
