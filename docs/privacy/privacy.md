# Privacy

Untrackable is built on one rule: **your links never leave your device
because of Untrackable.**

## What the extension can access

Because of its host permissions, the extension _could_ read and change data
on http(s) pages. It uses that access only for:

- letting Chromium's `declarativeNetRequest` engine rewrite navigation URLs
  (the extension's own code does not see these navigations – unless you
  enable the redirect-loop retry offer, see below),
- a content script that, when you press Ctrl/Cmd+C, reads the current
  selection and – only if it is exactly one link – hands it to the
  extension's background worker, which writes the link to the clipboard
  again – cleaned, or unchanged if it must not be cleaned. Your settings and
  exception list are never shared with web pages, and pages cannot tell from
  the clipboard activity whether a link was cleaned (they can tell whether
  copy cleaning is switched on),
- reading the active tab's URL when **you** choose "Copy clean link",
- only if you enable the redirect-loop retry offer: receiving navigation
  error events (optional `webNavigation` permission). Chromium then delivers
  error events, including their URLs, for all frames to the extension.
  Untrackable reacts only to "too many redirects" errors of the top-level
  page: it keeps only that page's **host name** in memory
  (`chrome.storage.session`) so the popup can offer "Reload once without
  cleaning", and forgets it when used, on the tab's next successful page load,
  when the tab closes, when you remove the permission, or after 10 minutes.

## What is processed

- URLs you navigate to – matched by Chromium's rule engine against rules the
  extension installed; the extension is not notified.
- The text you copy on a web page – checked locally whether it is exactly one
  link; otherwise ignored.
- Links you explicitly act on (context menu, popup, keyboard shortcut,
  "Check a link" in the settings).

All processing happens locally, synchronously, in memory.

## What is stored

| Where                                                              | Content                                                                                                                                        |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `chrome.storage.local`                                             | Your settings only: on/off, mode, pause end time, copy-cleaning switch, the list of exception domains you entered                              |
| `chrome.storage.session` (memory, cleared when the browser closes) | Only with the retry offer: tab id → time of the last retry; tab id → host name of a page that failed with a redirect loop (see above). No URLs |
| DNR session rules and alarms (memory)                              | Tab ids you paused or opened without cleaning (until the page has loaded, at most 1 minute); for a loop reload, the host name                  |

No URLs, page titles, history, counters or statistics are stored – only
the settings and the short-lived host names / tab ids above. End-to-end tests
inspect storage after normal browsing and while a loop offer exists.

## What is never collected

- No telemetry, analytics or crash reporting.
- The extension makes no network requests of its own. (The only
  navigations it ever triggers are ones you ask for: "Reload once without
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
