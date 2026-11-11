# CLAUDE.md – project notes for Claude Code sessions

Untrackable removes tracking parameters from URLs. Principles: privacy by
default, zero friction, functionality first (never break auth/payment/signed
links), local only, minimal permissions. Docs in English; the maintainer
communicates in German.

## Layout

- `rules/rules.json` – tracker + protection rules (single source of truth, lower-case only)
- `docs/architecture/engine-spec.md` – **normative** cleaning algorithm
- `packages/core` – TS engine (`engine.ts`), rule validation (`rules.ts`), DNR compiler (`dnr.ts`)
- `crates/untrackable-core` – Rust engine; must match TS exactly
- `tests/fixtures/cases.json` – shared conformance fixtures run by both engines
- `apps/browser-extension` – MV3 extension (`src/background.ts`, `content.ts`, `popup.ts`, `options.ts`, `offscreen.ts`, `settings.ts`), static assets in `static/`, e2e in `e2e/`
- `docs/` – architecture overview, threat model, privacy, roadmap, development

## Commands

```sh
npm ci
npm test                 # vitest: fixtures, unit, property, DNR tests
npm run typecheck && npm run lint && npm run format:check
npm run test:e2e         # builds, then Playwright + real Chromium (needs Chromium)
cargo test --all && cargo clippy --all-targets -- -D warnings && cargo fmt --all -- --check
npm run test:conformance # TS vs Rust differential test (corpus generated from rules.json)
npm run package -w apps/browser-extension   # reproducible zip in artifacts/
```

In the Claude Code cloud container Chromium is preinstalled; Playwright is pinned
to 1.63.0 to match it.

## Conventions

- Behaviour changes: spec first, then both engines, then fixtures – in one change.
- Prefer leaving URLs unchanged over risking breakage. Unknown params are always kept.
- Never log URLs; never add network requests or telemetry; stored data = settings plus the optional aggregate `stats` numbers (no URLs, hosts, names or times). Statistics count only removals verified against the engine (`verifiedRemovals`) and only while the optional `webRequest` permission is granted.
- Extension pages render user data with `textContent` only. No eval / dynamic code.
- Privileged runtime messages are authorised by `sender.url` (extension origin), not `sender.tab`.
- DNR `removeParams` is exact + case-sensitive; case-insensitive regexSubstitution fallback rules (chunks of 4 names – larger case-insensitive regexes exceed Chromium's 2 KB limit) handle mixed case. Every compiled rule must install (e2e asserts it; if a protection rule cannot install, the fail-safe disables all redirects and shows `!`). Protection regexes are chunked by a character budget (`REGEX_CHUNK_CHARS`) – long case-insensitive alternations exceed the 2 KB limit. Chromium only falls through from a no-op redirect to the _other_ matcher kind (URL-pattern vs regex) – keep exact rules regex-free. `packages/core/test/dnr-simulator.ts` models this and is checked against Chromium in e2e.
- Copy cleaning never touches the copy event (no setData/preventDefault): the content script reports keyboard copies (`copied`), the service worker decides with the settings and, for a single link, ALWAYS rewrites the clipboard (clean or unchanged) – writing only when cleaning would leak settings via `clipboardchange`. Latest copy wins (`copySeq`). Settings must never reach the page process.
- Redirect-loop helper: never navigate to a stored or page-supplied URL; only `tabs.reload` after an explicit click, host-scoped bypass, store host only.
- "Open link without cleaning": no blind navigation retry (could consume one-time links); wait for the blank tab instead; the bypass ends when the destination commits.
- Experimental mode strips every non-empty query segment (fragment kept) after the usual protection plus `protection.experimentalParams`; navigation uses one GET-only `transform.query: ''` rule. Protection regexes match after `?`, `&` and `#` (Chromium matches the URL incl. fragment). Manual "… without query parameters" actions use `stripQuery` (ignores protection – explicit user intent).
- Rule files: both engines validate strictly (unknown fields rejected); `npm run test:conformance` also checks validation parity.
- npm dependencies pinned exactly; Rust dependencies use semver ranges locked by `Cargo.lock` (CI uses `--locked`); GitHub Actions pinned by SHA.

## Status

v0.1.0 released on GitHub (tag on c0cf8d2, published by `release.yml`).
v0.2.0 (Experimental mode, PR #6) approved by the maintainer after their
macOS test; released via an annotated `v0.2.0` tag on the merge commit – the
session cannot push tags (403), so the maintainer pushes it. See `docs/release/`.
Build release candidates from a fresh clone with its own `npm ci` (never via a
`node_modules` symlink into another checkout – the workspace package would
resolve there).
Phase 2 (desktop) and Phase 3 not started – see `docs/roadmap/roadmap.md`.
Not published to any store – Chrome Web Store submission and future releases need maintainer approval.
