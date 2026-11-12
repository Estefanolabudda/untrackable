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
browser binary. CI runs the suite against Playwright's Chromium and against
[Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/)
116 (minimum supported version) and a recent stable release (job `compat`,
archives pinned by SHA-256). Branded Google Chrome cannot be used: it no
longer loads extensions from the command line. The suite detects older
behaviour at startup (an empty `?` left after removal) and skips checks that a
browser version cannot support (no `clipboardchange` event, no CDP
`Extensions` domain for the upgrade tests) with a reason.

Regression safety nets:

- `tests/corpus/sensitive-urls.json` – 259 real-world sign-in, payment,
  signed-download and similar URL shapes with per-mode expectations, checked
  in both engines and against the navigation rules. Changing an expectation is
  a reviewed decision.
- `apps/browser-extension/e2e/releases/` – the published release ZIPs
  (SHA-256 checked) used by the upgrade tests.

### What the upgrade tests prove – and what they do not

The "upgrades from published releases" e2e tests cover exactly this path:

1. The contents of the **published** 0.1.0 and 0.2.0 ZIPs (SHA-256 checked
   against the GitHub release assets) are installed as an unpacked extension
   into a fresh profile (CDP `Extensions.loadUnpacked`).
2. Settings are written to `chrome.storage.local` from the old version's own
   extension page, in the format that version stores (not by clicking through
   its UI).
3. The folder contents are replaced by the current build and the extension is
   reloaded by loading the same folder again (`Extensions.loadUnpacked` on the
   same path – the extension keeps its id and storage, and Chromium reports an
   update to `onInstalled`, like the reload button in `chrome://extensions`).
4. Checked afterwards: new version, settings unchanged, `settingsVersion`
   written, all five context menus, mode-specific navigation rules, real
   navigation cleaning and exceptions.

Not covered (known limits):

- the reload **button** in `chrome://extensions` itself (the CDP call is used
  as its equivalent; the manual macOS release test uses the button);
- updates through the Chrome Web Store or a packed `.crx` (Untrackable is not
  distributed that way yet);
- replacing the folder and only **restarting** the browser – not an update in
  Chromium: the previously registered service worker keeps running until the
  extension is reloaded (verified; the README tells users to reload);
- Chrome 116 (it has no CDP `Extensions` domain; the tests are skipped there
  and run on current Chromium and Chrome for Testing 157);
- downgrades (only unit-tested: a newer settings format is left untouched);
- other Chromium browsers (Edge, Brave, Vivaldi, Opera).

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
   `SOURCE_DATE_EPOCH` overrides them; file modes are normalised to 644/755,
   so the umask does not matter). To verify a published zip, build from a
   **fresh clone** of the tag with its own `npm ci` – never from a worktree
   whose `node_modules` points into another checkout (the workspace package
   `@untrackable/core` would then come from that checkout).
5. Add `docs/release/vX.Y.Z-release-notes.md`, merge to `main` and wait for
   green CI on that commit.
6. Create and push an annotated tag on that commit, with the project identity
   as tagger (never a personal address – tag objects are public):
   `git -c user.name="Untrackable" -c user.email="untrackable@estefano.me" tag -a vX.Y.Z -m "Untrackable X.Y.Z" <sha>`,
   check it with `git cat-file -p vX.Y.Z`, then `git push origin vX.Y.Z`.
   `.github/workflows/release.yml` then verifies the tag (annotated, on
   `main`, matches the package version, release notes present), runs the unit
   tests, builds the reproducible zip from exactly that commit and publishes
   the GitHub release with the zip and `SHA256SUMS`.
7. Publishing to browser stores is a separate, manual, maintainer-approved
   step.
