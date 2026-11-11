# Release readiness – Untrackable 0.1.0

Status: **release candidate, not yet published.** Release approved by the
maintainer on 2026-11-10; tag `v0.1.0` not created yet (tag push needs the
maintainer). A redirect-loop report from the maintainer's test on 2026-11-11
(ChatGPT e-mail link) is fixed on top of the approved commit and needs a new
approval before the release is published. Not published in the Chrome Web
Store.

## Verification summary

| Area                | Evidence                                                                                                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine correctness  | 157 shared fixtures pass in TypeScript, Rust and inside Chromium's URL parser; property tests (fast-check, proptest)                                                                                                                                                    |
| Engine consistency  | Differential test: >51,000 URLs generated from `rules/rules.json` give identical results in TS and Rust; validation parity on 60 mutated rule sets (CI job)                                                                                                             |
| Browser behaviour   | 60 Chromium end-to-end tests against the built extension (navigation, protection, modes, exceptions, pauses, bypasses, copy cleaning, privacy of storage, loop helper, popup per-tab controls, DNR model vs real Chromium on 200 generated URLs); stable under CPU load |
| Static checks       | Prettier, ESLint, TypeScript strict, rustfmt, clippy `-D warnings`                                                                                                                                                                                                      |
| Dependencies        | `npm audit --audit-level=high`, `cargo audit`: no findings (10 moderate dev-only npm advisories in eslint's `minimatch`)                                                                                                                                                |
| Packaging           | Reproducible zip (identical SHA-256 across clean clones); unzipped artifact loads in Chromium, installs all rules                                                                                                                                                       |
| Independent reviews | Five rounds (code, security, privacy, release, focused re-verification) by separate reviewers; all confirmed findings fixed with regression tests – see commit history of PR #1                                                                                         |

## Permissions

Install-time warnings (measured): "Read and change all your data on all
websites", "Modify data you copy and paste". Every permission is used by a
shipped feature (`docs/security/threat-model.md`). Expect an in-depth Chrome
Web Store review because of the broad host permissions plus a content script
on all sites.

## Known limitations (accepted for 0.1.0)

- Not an anonymity tool.
- Protection of sign-in/payment/signed links is heuristic (escape hatches:
  site exception, tab pause, "Open link without cleaning").
- Navigation cleaning (declarativeNetRequest): no fragments; URLs with
  percent-encoded letters/digits/`-._/` in path or keys are left alone;
  valueless parameters may become `edit=`; mixed-case trackers only in URLs
  with fewer than 7 parameters; top-level navigations only.
- Copy cleaning: keyboard shortcut only (not Edit menu/touch), exactly one
  link selected, not in iframes/shadow-DOM inputs; a paste within a few
  milliseconds may still contain the original link; the clean link is
  written as plain text; pages can see whether copy cleaning is switched on.
- "Open link without cleaning" disables cleaning in that tab until the
  destination page commits (≤ 1 minute, e.g. for downloads).
- Redirect-loop helper needs the optional `webNavigation` permission.
- Tested automatically only on Chromium 153 (Linux, headless).

## Open before a public release

1. **Manual test pass** on Chrome for macOS – done by the maintainer
   (2026-11-10), all passed: automatic UTM removal, OAuth-style protected URL,
   Cmd+C copy cleaning, domain exceptions, extension deactivation, "Copy clean
   link" context menu, Alt+Shift+U. Not yet covered manually: real
   third-party sign-ins and payments, popup/dark mode, redirect-loop helper
   (remaining items of `docs/release/manual-testing-macos.md`).
2. **Chrome Web Store listing material** (not created): 1280×800 screenshots,
   440×280 promo tile, detailed description, single-purpose statement,
   permission justifications, data-usage disclosure ("no data collected"),
   hosted privacy policy URL (from `docs/privacy/privacy.md`), support URL,
   developer account (verified e-mail, EU trader declaration).
3. **Maintainer decisions:** merge PR #1; set the release date in
   `CHANGELOG.md`; tag `v0.1.0` and attach the CI zip; enable GitHub private
   vulnerability reporting (referenced by `SECURITY.md`).

## Recommendation

Released on GitHub as v0.1.0 after automated verification and the
maintainer's manual tests. Before a Chrome Web Store submission: complete the
remaining manual checklist items and prepare the listing material (item 2).
