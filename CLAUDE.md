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
- Never log URLs; never add network requests or telemetry; settings are the only stored data.
- Extension pages render user data with `textContent` only. No eval / dynamic code.
- Privileged runtime messages are authorised by `sender.url` (extension origin), not `sender.tab`.
- DNR `removeParams` is exact + case-sensitive; case-insensitive regexSubstitution fallback rules (chunks of 4 names – larger case-insensitive regexes exceed Chromium's 2 KB limit) handle mixed case. Every compiled rule must install (e2e asserts it). Chromium only falls through from a no-op redirect to the _other_ matcher kind (URL-pattern vs regex) – keep exact rules regex-free. `packages/core/test/dnr-simulator.ts` models this and is checked against Chromium in e2e.
- Rule files: both engines validate strictly (unknown fields rejected); `npm run test:conformance` also checks validation parity.
- npm dependencies pinned exactly; Rust dependencies use semver ranges locked by `Cargo.lock` (CI uses `--locked`); GitHub Actions pinned by SHA.

## Status (v0.1.0 release candidate)

Phase 1 (Chromium extension) implemented and tested. Phase 2 (desktop) and
Phase 3 not started – see `docs/roadmap/roadmap.md`. Not published to any
store.
