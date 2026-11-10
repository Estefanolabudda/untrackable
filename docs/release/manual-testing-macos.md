# Manual test checklist – Chrome on macOS (v0.1.0)

Automated tests cover the engine, the declarativeNetRequest rules and most
extension flows in headless Chromium. This checklist covers what automation
cannot: the real browser UI (toolbar popup, context menus, keyboard
shortcuts, permission prompts), real websites and real sign-in flows.

Record for each step: ✅ / ❌ and a note. Use a **fresh Chrome profile**
(Chrome menu → profile icon → _Add_) so other extensions do not interfere.

## 0. Setup

| #   | Step                                                                                          | Expected                                                                                      |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 0.1 | `git checkout claude/ecstatic-einstein-qf1mtx && npm ci && npm run build`                     | Build finishes, `apps/browser-extension/dist/` exists                                         |
| 0.2 | `chrome://extensions` → _Developer mode_ on → _Load unpacked_ → `apps/browser-extension/dist` | "Untrackable 0.1.0" appears without errors; no "Errors" button                                |
| 0.3 | Pin the extension (puzzle icon → pin)                                                         | Green icon in toolbar, no badge                                                               |
| 0.4 | Note Chrome version (`chrome://version`)                                                      | ≥ 116                                                                                         |
| 0.5 | _Details_ → check permissions shown                                                           | Exactly: "Read and change all your data on all websites" and "Modify data you copy and paste" |

## 1. Automatic navigation cleaning

Open each URL by pasting it into the address bar (example.com is a real,
harmless site that ignores parameters).

| #   | URL                                                                       | Expected address bar afterwards                |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| 1.1 | `https://example.com/?utm_source=newsletter&utm_medium=email&id=123`      | `https://example.com/?id=123`                  |
| 1.2 | `https://example.com/?fbclid=abc&gclid=def`                               | `https://example.com/`                         |
| 1.3 | `https://example.com/?UTM_SOURCE=x&Utm_Medium=y&q=1`                      | `https://example.com/?q=1`                     |
| 1.4 | `https://example.com/?q=1`                                                | unchanged, page loads once (no flicker/loop)   |
| 1.5 | `https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc123`                   | `si` removed, video loads                      |
| 1.6 | A real newsletter link from your inbox with `utm_*`                       | Lands on the article; `utm_*` gone; page works |
| 1.7 | A Kleinanzeigen share link (`…?utm_source=sharesheet…`)                   | Ad opens; `utm_*` gone                         |
| 1.8 | A Google search result → click an ad or shop result with `gclid`          | Target page works; `gclid` gone                |
| 1.9 | Click a link with `utm_*` inside a page (e.g. from a newsletter web view) | Cleaned the same way                           |

## 2. Protected URLs (must stay unchanged)

| #    | Action                                                                                                 | Expected                                               |
| ---- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 2.1  | `https://example.com/oauth/authorize?client_id=1&state=2&utm_source=x`                                 | Address bar keeps `utm_source`                         |
| 2.2  | `https://example.com/account/reset-password?token=abc&utm_source=x`                                    | Unchanged                                              |
| 2.3  | `https://example.com/file.pdf?X-Amz-Signature=abc&utm_source=x`                                        | Unchanged                                              |
| 2.4  | **Google sign-in:** sign out of Google, then sign in at `https://accounts.google.com` (2FA if enabled) | Sign-in completes normally                             |
| 2.5  | **"Sign in with Google/GitHub/Apple" on a third-party site** (e.g. a developer tool you use)           | OAuth redirect and callback work; you end up signed in |
| 2.6  | **Microsoft login** (`login.microsoftonline.com`, e.g. Outlook web)                                    | Works                                                  |
| 2.7  | A **password-reset e-mail** link from any service                                                      | Reset form opens and accepts the new password          |
| 2.8  | An **e-mail verification / magic-link** sign-in (e.g. Slack, Notion)                                   | Signed in                                              |
| 2.9  | A **checkout with PayPal or Klarna** (stop before paying, or use a sandbox)                            | Redirects to the payment provider and back work        |
| 2.10 | A **shared Google Drive / Dropbox / S3 download link**                                                 | Download starts                                        |

If any of these breaks: note the full URL **with tokens replaced by `XXX`**,
then test whether "Never clean links to this site" fixes it (section 6).

## 3. Popup

| #    | Step                                                                                  | Expected                                                                              |
| ---- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 3.1  | Open popup on `https://example.com`                                                   | Status "Active", Clean selected, site section shows `example.com`                     |
| 3.2  | Select _Strict_, open `https://example.com/?ref=hn&id=1`                              | `ref` removed; badge `S`                                                              |
| 3.3  | Back to _Clean_, same URL                                                             | `ref` stays                                                                           |
| 3.4  | _Pause for 15 minutes_, open 1.1                                                      | Not cleaned; badge `off`; status "Paused until …"                                     |
| 3.5  | _Resume now_, open 1.1                                                                | Cleaned again                                                                         |
| 3.6  | Uncheck _Clean links automatically_, open 1.1                                         | Not cleaned; badge `off`                                                              |
| 3.7  | Re-enable; check _Pause in this tab_; open 1.1 in **this** tab and in **another** tab | This tab: not cleaned. Other tab: cleaned                                             |
| 3.8  | Close and reopen the popup in the paused tab                                          | Checkbox still checked                                                                |
| 3.9  | _Copy clean link_ on 1.1 (before cleaning, e.g. while paused)                         | Clipboard (paste in TextEdit) = cleaned URL; popup says "Copied – removed 2 trackers" |
| 3.10 | Keyboard: Tab through the popup, toggle with Space                                    | All controls reachable; focus visible                                                 |
| 3.11 | macOS dark mode (System Settings → Appearance → Dark)                                 | Popup and settings readable                                                           |

## 4. Copy cleaning (keyboard)

Use TextEdit or Notes to paste and inspect the result.

| #   | Step                                                                                                              | Expected                                            |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 4.1 | On any page, select the text of a URL with `utm_source` (e.g. in a GitHub issue or a text field), press **Cmd+C** | Pasted text is the cleaned URL                      |
| 4.2 | Same in an `<input>` / search field                                                                               | Cleaned                                             |
| 4.3 | Select a sentence that _contains_ a URL with `utm_*`, Cmd+C                                                       | Pasted text unchanged (by design)                   |
| 4.4 | Select a protected URL (2.1) as text, Cmd+C                                                                       | Unchanged                                           |
| 4.5 | Select a URL, use **Edit → Copy** from the macOS menu bar                                                         | Not cleaned (documented limitation)                 |
| 4.6 | Settings → uncheck "Clean a link when I copy it", repeat 4.1                                                      | Unchanged                                           |
| 4.7 | Switch keyboard input source to a non-Latin layout (e.g. Russian), repeat 4.1                                     | Cleaned                                             |
| 4.8 | Google Docs / a rich-text editor: select a URL, Cmd+C, paste back                                                 | Clean URL; no formatting breakage beyond plain text |

## 5. Context menus and shortcut

| #   | Step                                                                                                | Expected                                                  |
| --- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 5.1 | Right-click a link with `utm_*` → **Copy clean link**                                               | Clipboard = cleaned URL                                   |
| 5.2 | Right-click page background → **Copy clean page link**                                              | Clipboard = cleaned page URL                              |
| 5.3 | Right-click a link with `utm_*` → **Open link without cleaning**                                    | New tab next to the current one with the **original** URL |
| 5.4 | In that new tab, open 1.1                                                                           | Cleaned again (bypass was one-time)                       |
| 5.5 | Press **⌥⇧U** (Option+Shift+U) on a page whose URL has trackers (pause first so the URL keeps them) | Clipboard = cleaned URL                                   |
| 5.6 | `chrome://extensions/shortcuts` → change the shortcut, test again                                   | New shortcut works                                        |
| 5.7 | Settings page → _Check a link_ → paste 1.1 → _Open original link without cleaning_                  | Opens original once                                       |

## 6. Domain exceptions

| #   | Step                                                                      | Expected                        |
| --- | ------------------------------------------------------------------------- | ------------------------------- |
| 6.1 | Popup on `example.com` → check _Never clean links to this site_; open 1.1 | Not cleaned                     |
| 6.2 | Open `https://www.example.com/?utm_source=x`                              | Not cleaned (subdomain covered) |
| 6.3 | Open `https://example.org/?utm_source=x`                                  | Cleaned                         |
| 6.4 | Settings page → exception list shows `example.com`; _Remove_              | Removed; 1.1 cleaned again      |
| 6.5 | Settings → add `Bücher.de`                                                | Stored as `xn--bcher-kva.de`    |
| 6.6 | Add invalid text (`not a domain!`)                                        | Error message, nothing stored   |
| 6.7 | Copy-clean (4.1) a URL on an excepted domain                              | Unchanged                       |

## 7. Redirect-loop helper (optional permission)

| #   | Step                                                           | Expected                                                                                                                                        |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1 | Settings → check "Offer a one-click retry…"                    | Checkbox stays checked. Chrome may not show a prompt, because the "webNavigation" warning is already covered by the host permission             |
| 7.2 | Uncheck it again, reopen the settings                          | Checkbox unchecked                                                                                                                              |
| 7.3 | (Only if you know a site that forces its tracker back) open it | Error page; badge `↻`; popup on that tab offers "Reload once without cleaning"; click → page loads once; navigating elsewhere removes the offer |

## 8. Lifecycle and privacy

| #   | Step                                                                 | Expected                                                                            |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 8.1 | Quit Chrome completely (Cmd+Q), reopen, open 1.1                     | Cleaned; settings and exceptions kept                                               |
| 8.2 | Pause in a tab, quit and reopen Chrome                               | Tab pause is gone (session-only)                                                    |
| 8.3 | `chrome://extensions` → Untrackable → _service worker_ → Console     | No errors, no log output with URLs                                                  |
| 8.4 | Same DevTools → Network tab while browsing                           | **No** requests made by the extension                                               |
| 8.5 | DevTools console: `chrome.storage.local.get(null).then(console.log)` | Only settings keys (enabled, mode, exceptions, pausedUntil, copyCleaning) – no URLs |
| 8.6 | Disable and re-enable the extension                                  | Works immediately                                                                   |

## 9. Sign-off

- Chrome version, macOS version, tester, date
- List of ❌ items with sanitised URLs and screenshots
- Decision: ready / not ready for release
