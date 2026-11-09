# Privacy

Untrackable is built on one rule: **your links never leave your device
because of Untrackable.**

## What the extension can access

Because of its host permissions, the extension _could_ read and change data
on http(s) pages. It uses that access only for:

- letting Chromium's `declarativeNetRequest` engine rewrite navigation URLs
  (the extension's own code does not see these navigations – unless you
  enable redirect-loop recovery, see below),
- a content script that reacts to `copy` events, reading the current
  selection only at the moment you copy,
- reading the active tab's URL when **you** choose "Copy clean link",
- only if you enable automatic redirect-loop recovery: receiving navigation
  error events (optional `webNavigation` permission). Chromium then delivers
  error events, including their URLs, for all frames to the extension.
  Untrackable reacts only to "too many redirects" errors of the top-level
  page: it keeps that page's URL in memory (`chrome.storage.session`) for up
  to 10 minutes so the popup can offer "Retry once without cleaning", and
  forgets it when used, when the tab closes or when it expires.

## What is processed

- URLs you navigate to – matched by Chromium's rule engine against rules the
  extension installed; the extension is not notified.
- The text you copy on a web page – checked locally whether it is exactly one
  link; otherwise ignored.
- Links you explicitly act on (context menu, popup, keyboard shortcut,
  "Check a link" in the settings).

All processing happens locally, synchronously, in memory.

## What is stored

| Where                                                              | Content                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `chrome.storage.local`                                             | Your settings only: on/off, mode, pause end time, copy-cleaning switch, the list of exception domains you entered        |
| `chrome.storage.session` (memory, cleared when the browser closes) | Only with loop recovery: tab id → time of the last retry (no URLs)                                                       |
| DNR session rules and alarms (memory)                              | Tab ids you paused or opened without cleaning; for a loop-recovery retry, the host name of that page until it has loaded |

No URLs, page titles, history, counters or statistics are stored. This is
verified by an end-to-end test that inspects storage after browsing.

## What is never collected

- No telemetry, analytics or crash reporting.
- The extension makes no network requests of its own. (The only
  navigations it ever triggers are ones you ask for: "Retry once without
  cleaning" after a redirect loop, or "Open link without cleaning".)
- No remote rule updates.
- No cookies, form data, credentials or page content.

## What Untrackable does **not** protect against

Removing tracking parameters is one privacy measure among many. It does not
prevent:

- cookies and local storage based tracking,
- tracking by IP address,
- browser fingerprinting,
- tracking pixels and third-party scripts,
- redirect-based click tracking (`https://tracker.example/click?u=…`) –
  planned for a later phase,
- tracking information encoded in the URL path or in parameter names we do
  not know.

Websites can notice that their own tracking parameters arrive stripped and
may infer that a cleaner is in use.

**Untrackable does not make you anonymous.**
