# Privacy

Untrackable is built on one rule: **your links never leave your device
because of Untrackable.**

## What the extension can access

Because of its host permissions, the extension _could_ read and change data
on http(s) pages. It uses that access only for:

- letting Chromium's `declarativeNetRequest` engine rewrite navigation URLs
  (the extension's own code never sees these navigations),
- a content script that reacts to `copy` events, reading the current
  selection only at the moment you copy,
- reading the active tab's URL when **you** choose "Copy clean link".

## What is processed

- URLs you navigate to – matched by Chromium's rule engine against rules the
  extension installed; the extension is not notified.
- The text you copy on a web page – checked locally whether it is exactly one
  link; otherwise ignored.
- Links you explicitly act on (context menu, popup, keyboard shortcut,
  "Check a link" in the settings).

All processing happens locally, synchronously, in memory.

## What is stored

| Where                                                              | Content                                                                                                           |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `chrome.storage.local`                                             | Your settings only: on/off, mode, pause end time, copy-cleaning switch, the list of exception domains you entered |
| `chrome.storage.session` (memory, cleared when the browser closes) | Ids of tabs that have a pending one-time bypass                                                                   |
| DNR session rules (memory)                                         | Tab ids you paused                                                                                                |

No URLs, page titles, history, counters or statistics are stored. This is
verified by an end-to-end test that inspects storage after browsing.

## What is never collected

- No telemetry, analytics or crash reporting.
- No network requests of any kind are made by the extension.
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

**Untrackable does not make you anonymous.**
