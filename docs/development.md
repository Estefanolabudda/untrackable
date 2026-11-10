# Development

## Prerequisites

- Node.js ≥ 22.12 and npm
- Rust 1.97.0 with `rustfmt` and `clippy` (pinned in `rust-toolchain.toml`;
  rustup installs it automatically)
- For browser tests: Playwright's Chromium (`npx playwright install chromium`)

## Setup

```sh
npm ci
```

## Common commands

| Task                                                    | Command                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Build the extension into `apps/browser-extension/dist/` | `npm run build`                                                                     |
| Package a reproducible zip into `artifacts/`            | `npm run package -w apps/browser-extension`                                         |
| TypeScript unit + fixture + property tests              | `npm test`                                                                          |
| Chromium end-to-end tests (builds first)                | `npm run test:e2e`                                                                  |
| Type checking                                           | `npm run typecheck`                                                                 |
| Lint / format check                                     | `npm run lint` / `npm run format:check`                                             |
| Everything except e2e                                   | `npm run check`                                                                     |
| Rust tests                                              | `cargo test --all`                                                                  |
| Rust lint                                               | `cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings`           |
| Try the Rust engine                                     | `cargo run -q --example clean -- --strict 'https://example.com/?utm_source=x&id=1'` |
| Regenerate icons                                        | `node scripts/gen-icons.mjs`                                                        |

Set `CHROMIUM_PATH=/path/to/chromium` to run the e2e suite with a specific
browser binary.

## Loading the extension manually

1. `npm run build`
2. Open `chrome://extensions`, enable _Developer mode_
3. _Load unpacked_ → select `apps/browser-extension/dist`

## Changing rules

1. Edit `rules/rules.json` (lower-case names only; validation enforces it).
2. Add fixtures to `tests/fixtures/cases.json` – both engines must pass them.
3. Run `npm test`, `cargo test --all` and `npm run test:e2e`.

When adding a parameter to a _prefix_ rule, also list common concrete names
in `params`: navigation cleaning can only remove exact names.

## Changing engine behaviour

Update `docs/architecture/engine-spec.md` first, then both engines and the
fixtures in the same change.

## Release preparation

1. Bump `version` in `apps/browser-extension/package.json` (the manifest is
   updated by the build), `packages/core/package.json` and the exact
   `@untrackable/core` dependency of the extension,
   `crates/untrackable-core/Cargo.toml`; then refresh `package-lock.json`
   (`npm install`) and `Cargo.lock` (`cargo build`).
2. Update `CHANGELOG.md`.
3. Run the full test suite including `npm run test:e2e`.
4. `npm run package -w apps/browser-extension` → `artifacts/untrackable-chromium-<version>.zip`
   The archive is reproducible by default (fixed 2000-01-01 timestamps;
   `SOURCE_DATE_EPOCH` overrides them). File modes are stored, so build from
   a checkout made with a normal umask (e.g. 022).
5. Add `docs/release/vX.Y.Z-release-notes.md`, merge to `main` and wait for
   green CI on that commit.
6. Create and push an annotated tag on that commit:
   `git tag -a vX.Y.Z -m "Untrackable X.Y.Z" <sha> && git push origin vX.Y.Z`.
   `.github/workflows/release.yml` then verifies the tag (annotated, on
   `main`, matches the package version, release notes present), runs the unit
   tests, builds the reproducible zip from exactly that commit and publishes
   the GitHub release with the zip and `SHA256SUMS`.
7. Publishing to browser stores is a separate, manual, maintainer-approved
   step.
