# Roadmap

## Phase 1 – Chromium extension (v0.1, this release)

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

## v0.2 – Experimental mode (in development)

- Opt-in "Experimental – strip query parameters" mode with protection of
  recognised sign-in/payment/signed links and an explicit confirmation.
- Context-menu actions "Copy/Open link without query parameters".

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
- Optional, local-only statistics
- WASM build of the Rust engine if it simplifies maintenance
