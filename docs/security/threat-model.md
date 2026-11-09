# Threat Model

Scope: the Chromium extension (`apps/browser-extension`), the cleaning
engines (`packages/core`, `crates/untrackable-core`) and the rule set
(`rules/rules.json`).

## Assets

1. **Functionality of the user's links** – sign-ins, password resets,
   purchases, signed downloads must keep working.
2. **The user's browsing data** – URLs visited, copied or cleaned.
3. **Integrity of navigation** – a cleaned link must lead to the same
   destination as the original.
4. **The extension's privileges** – host access to all http(s) sites,
   clipboard write, DNR rules.

## Trust boundaries and adversaries

| Source                                      | Trust                                                            | Examples                                            |
| ------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| Web pages, their DOM and selections         | Untrusted                                                        | Hostile page triggering `copy` events, crafted URLs |
| URLs (navigation, clipboard, context menu)  | Untrusted                                                        | Malformed, huge, IDN homographs, unusual schemes    |
| Content scripts                             | Semi-trusted (run beside hostile pages)                          | Can only query their own tab state                  |
| Extension pages (popup, options, offscreen) | Trusted                                                          | Privileged messages                                 |
| `chrome.storage.local` contents             | Validated on every read                                          | Corrupted or hand-edited settings                   |
| Rule set                                    | Shipped with the extension, validated at load; no remote updates | Future imported lists must use `validateRuleSet`    |

## Threats and mitigations

| #   | Threat                                              | Mitigation                                                                                                                                                                                                                                                           | Residual risk                                                                                                                                                                                                            |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | Cleaning breaks an auth / payment / signed URL      | Protection signals (domains, path keywords, parameter names/prefixes/suffixes, `code`+`state`) evaluated before any removal; unknown parameters always kept; Strict mode opt-in; bypass options (exceptions, pause, per-tab pause, one-time bypass)                  | Heuristics cannot recognise every flow (e.g. a provider using `utm_*`-named parameters functionally, or tokens under neutral names on neutral paths). Navigation cleaning cannot see fragments or percent-encoded paths. |
| T2  | Cleaning changes the destination (scheme/host/path) | Output is the original string with only `&`-separated query/fragment segments removed; prefix (scheme, authority, path) is never modified; only http(s) is processed; hosts outside the host-name alphabet are rejected                                              | None known.                                                                                                                                                                                                              |
| T3  | Redirect loops                                      | DNR only redirects when the transformed URL differs; cleaning is idempotent (property tests)                                                                                                                                                                         | —                                                                                                                                                                                                                        |
| T4  | Hostile page abuses the extension via messages      | `onMessage` checks `sender.id`; privileged messages (`setTabPaused`, `copyText`, `openUnmodified`) are accepted only from extension-origin pages (by `sender.url`); content scripts may only query their own tab; all messages are schema-validated and size-limited | —                                                                                                                                                                                                                        |
| T5  | Clipboard manipulation                              | Copy handler only replaces the clipboard when the selection is exactly one http(s) URL **and** the engine returns `cleaned`; `cut` and rich text are untouched; offscreen clipboard writes happen only after explicit user actions                                   | A page can already control what is copied from it; Untrackable never makes this worse.                                                                                                                                   |
| T6  | XSS in extension pages                              | No `innerHTML`; user data rendered via `textContent`; CSP `script-src 'self'; object-src 'none'`; no `eval`/`Function` (enforced by ESLint)                                                                                                                          | —                                                                                                                                                                                                                        |
| T7  | ReDoS / resource exhaustion on hostile input        | Engine regexes are linear (anchored alternations, no nested quantifiers); Rust `regex` and Chromium RE2 are linear-time; content script ignores selections > 8 KB; messages > 32 KB rejected; exceptions capped at 1,000                                             | JS `RegExp` is backtracking but the patterns used have no ambiguous quantifiers.                                                                                                                                         |
| T8  | Corrupted settings                                  | `sanitizeSettings` coerces every field; exceptions re-validated and punycode-normalised; invalid DNR data is never produced                                                                                                                                          | —                                                                                                                                                                                                                        |
| T9  | Supply chain                                        | No runtime dependencies in the extension bundle besides the in-repo engine; dev dependencies pinned exactly with a lockfile; Rust deps locked (`--locked` in CI); GitHub Actions pinned by commit SHA; `npm audit` and `cargo audit` in CI; Dependabot               | Dev tooling (eslint, vitest, esbuild) runs with developer privileges during builds.                                                                                                                                      |
| T10 | Leakage of sensitive URLs                           | No logging, no network requests, no telemetry; nothing URL-related persisted (see privacy doc); engine never reports parameter values                                                                                                                                | —                                                                                                                                                                                                                        |
| T11 | One-time bypass / tab pause leaking to other tabs   | Session rules are scoped with `tabIds`; removed on tab close, on completion of the bypassed load, and automatically at browser restart (session rules)                                                                                                               | A one-time bypass also covers redirects within that page load (intended).                                                                                                                                                |

## Permissions and justification

| Permission                                   | Why                                                                                                                                                 | Warning shown to users                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `declarativeNetRequest`                      | Navigation cleaning, protection and exceptions                                                                                                      | "Block content on any page"                     |
| host permissions `http://*/*`, `https://*/*` | DNR `redirect` actions require host access to the request URL; content script for copy cleaning; reading the active tab's URL for "Copy clean link" | "Read and change all your data on all websites" |
| `storage`                                    | Settings                                                                                                                                            | none                                            |
| `contextMenus`                               | "Copy clean link", "Copy clean page link", "Open link without cleaning"                                                                             | none                                            |
| `offscreen`                                  | MV3 service workers have no DOM; clipboard writes use an offscreen document                                                                         | none                                            |
| `clipboardWrite`                             | Required for `execCommand('copy')` in the offscreen document (verified: without it the write fails)                                                 | "Modify data you copy and paste"                |
| `alarms`                                     | End a timed pause automatically                                                                                                                     | none                                            |

Not requested: `tabs`, `webNavigation`, `webRequest`, `scripting`,
`cookies`, `history`, `clipboardRead`, `declarativeNetRequestFeedback`.

## Security assumptions

- Chromium enforces extension isolation, CSP and DNR semantics as documented.
- The user's browser profile is not compromised.
- Rules shipped with a release have been reviewed; there is no remote rule
  download in v0.1.

## Reporting vulnerabilities

See [`SECURITY.md`](../../SECURITY.md).
