# Local statistics – privacy and accuracy

Untrackable can show how many tracking parameters it removed – today, in the
last 7 days and in total. This document explains exactly what that feature
needs, sees, stores and counts. It is the reference for reviews; the code is
in `apps/browser-extension/src/stats.ts` (pure logic, unit-tested) and the
"Local statistics" section of `src/background.ts`.

**Summary.** Statistics are **off by default**. Turning them on grants one
optional permission (`webRequest`, read-only). Only numbers are stored, on this
device: one pair of counters per local calendar day for the last 7 days and a
total. No address, host name, parameter name or value, page title or time of
day is ever stored. Turning statistics off – or removing the permission in the
browser – deletes the numbers. Statistics never change what is cleaned.

## 1. Permissions

| Permission   | Kind                                                     | Why                                                                                                                                                       |
| ------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webRequest` | **optional**, requested only when you turn statistics on | Chromium's rule engine (declarativeNetRequest) does not report the redirects it makes; observing page loads is the only reliable way to confirm a removal |

Not requested: `webRequestBlocking` (Untrackable cannot block, delay or change
a request through `webRequest`), `declarativeNetRequestFeedback`, `tabs`,
`history`.

- **Warnings.** Measured with `chrome.management.getPermissionWarningsByManifest`
  (asserted in the e2e suite on Chromium 153, Chrome for Testing 116 and 157):
  adding `webRequest` adds **no** warning beyond the host-permission warning the
  extension already has ("Read and change all your data on all websites").
  Chromium therefore grants it on the click without a dialog.
- **The permission is the setting.** Granted = statistics on; removed = off.
  There is no separate stored switch that could disagree with it.
- **Alternatives considered.** `declarativeNetRequest.getMatchedRules` needs
  the `declarativeNetRequestFeedback` permission (or activeTab), only covers
  the last five minutes, is rate-limited and reports rule matches, not
  removed parameters – rejected as neither reliable nor more private.

## 2. What the API delivers

Listeners: `onBeforeRequest`, `onBeforeRedirect`, `onCompleted`,
`onErrorOccurred`, filtered to `types: ['main_frame']` and `http://*/*`,
`https://*/*`, registered without `extraInfoSpec` – so **no request or
response headers and no request bodies** are delivered.

What each event contains (per Chromium's API): request id, the full URL
(including the query), method, tab id, frame ids, document lifecycle,
initiator, time stamp; for redirects additionally the redirect target URL,
status code, status line, server IP (absent for redirects made inside the
browser) and whether the response came from cache; for errors the error text.

Untrackable uses only: request id, URL, tab id, document lifecycle, redirect
target, status code, status line and the absence of an IP. Nothing of it is
written to storage or logs, sent anywhere or given to web pages.

## 3. How a removal is verified

Two situations change a top-level URL without an event of their own, so both
are observed:

1. **Rule-engine redirect.** Untrackable's rules redirect `…?id=1&utm_source=x`
   to `…?id=1`. Chromium reports it as `onBeforeRedirect` with status 307, status
   line "Internal Redirect" and no server IP.
2. **In-place rewrite.** After a server redirect to a URL with trackers,
   Chromium applies the rules to the redirect target directly: the URL announced
   in `onBeforeRequest` differs from the URL in the next `onBeforeRedirect` or
   `onCompleted` for the same request.

For both, `verifiedRemovals(from, to, mode, exceptions)` counts only if **all**
of the following hold, otherwise it counts **0**:

- scheme, user info, host, port and path are identical;
- the remaining query segments of `to` appear in `from` in the same order,
  unchanged – i.e. `to` is `from` with some segments taken out;
- every removed segment's key is one the engine (`cleanUrl`) removes from
  `from` with the **current** mode and exceptions (multiset: duplicates are
  matched one by one);
- automatic cleaning is active (not off, not paused globally, no pause or
  one-time bypass in that tab);
- the tab is not incognito and the page is not being prerendered.

Server redirects (they have a server IP), HSTS upgrades (scheme changes),
another extension removing a parameter Untrackable keeps, re-encoded values,
reordered parameters and protected or excepted URLs all count 0 (unit tests in
`apps/browser-extension/test/stats.test.ts`, e2e in the "local statistics"
suite).

**Copies.** "Copy clean link" (popup, context menu, shortcut) and keyboard
copy cleaning count the parameters removed from the link that was actually
written to the clipboard (a newer copy that superseded it is not counted).
"… without query parameters" actions are not counted (they remove parameters
on explicit request, not as tracker removal).

**Trackers vs other parameters.** In Clean and Strict every verified removal
is a tracking parameter. In Experimental, a removed parameter counts as a
tracker only if the Strict rules would remove it too; the rest is shown
separately as "non-tracking parameters (Experimental, total)".

**Upper bound.** One page load or copy adds at most 20 – a page cannot inflate
the numbers with a crafted URL carrying thousands of trackers.

## 4. Double counting and miscounts

- **No double counting across hops.** Each hop of a request is compared once:
  the in-memory "requested URL" of a request is replaced at every
  `onBeforeRequest` and deleted after the redirect/completion that consumed it.
  A rule-engine redirect is counted at `onBeforeRedirect`; the request that
  follows starts with the cleaned URL, so its completion shows no difference.
- **Possible under-counting** (numbers can be lower than the real removals):
  - the service worker is stopped by the browser between a removal and the
    write (counts are written 250 ms after the event; Chromium keeps a worker
    alive for at least 30 s after an event, so this is unlikely);
  - a worker restart in the middle of a request loses the in-memory requested
    URL of that request – an in-place rewrite of that one request is then not
    seen (rule-engine redirects are unaffected);
  - removals the browser does not report (e.g. a page served from the
    back/forward cache is not a request – but then nothing was removed either);
  - in the first ~0.1 s after turning statistics on in Chrome 116 (the browser
    exposes the API slightly after the permission is granted).
- **Possible over-counting:**
  - another cleaning extension that removes exactly the same parameters before
    Untrackable can be counted (it is indistinguishable from Untrackable's own
    redirect);
  - a page that reloads itself with trackers raises the numbers (by at most 20
    per load) – the numbers are never shown to or readable by pages.

## 5. Redirects and service-worker restarts

- **Redirect chains:** each hop is checked independently; a chain such as
  click tracker → destination with trackers → cleaned destination counts the
  trackers removed from the destination once. Server redirects themselves count 0.
- **Service-worker restarts:** listeners are registered synchronously when the
  worker starts (Chromium wakes the worker for each event). The only state in
  memory is the per-request URL (bounded to 500 entries, URLs over 32 KB are not
  kept) and a tab-id → incognito map (bounded to 500); both are lost on a
  restart, which can only cause under-counting (section 4), never a stored URL.
- **Clock and date:** counts are filed under the local calendar date when they
  are written. Dates outside the 7-day window – including future dates after a
  clock change – are dropped when the numbers are read or written.

## 6. What is stored

`chrome.storage.local`, key `stats`, only while statistics are on:

```json
{
  "total": { "trackers": 2431, "other": 0 },
  "days": { "2026-11-11": { "trackers": 12, "other": 0 }, "2026-11-10": { "trackers": 136, "other": 0 } }
}
```

At most 7 day entries. Values are sanitised integers (`sanitizeStats`); any
other content is dropped on the next write.

**Sensitive URLs or domains are never stored persistently** – not in
`chrome.storage.local`, `chrome.storage.session`, logs or messages. URLs exist
only in the service worker's memory for the duration of a request. The e2e
suite browses with statistics on and asserts that storage contains only the
`stats` object above and no `http`, host, path or parameter text.

## 7. Turning statistics off, revoking the permission

- **Settings or popup switch off:** the permission is removed and the service
  worker deletes the numbers – queued behind any pending write, so a write in
  flight cannot bring them back. "Reset numbers" deletes them the same way and
  keeps statistics on.
- **Permission removed in `chrome://extensions`:** `permissions.onRemoved`
  wakes the worker, which deletes the numbers. A write that was already running
  re-checks the permission afterwards and deletes what it wrote. On every worker
  start, numbers left without the permission are deleted.
- After that the listeners receive no more events (the browser stops
  delivering them without the permission); nothing is counted until statistics
  are turned on again.

## 8. Effect on cleaning

None by design: the listeners are observe-only (no blocking), cleaning is done
by Chromium's rule engine independently of them, and rules are recompiled only
when a **settings** key changes (not when statistics are written). The cost is
that the service worker wakes for every top-level page load while statistics
are on; the work per load is a few map operations, plus at most three engine
runs when a redirect or rewrite is observed.

## 9. Do the labels match the measurement?

| Label (popup / settings)            | Measured exactly as                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| Tracking parameters removed (popup) / Count removed tracking parameters on this device (settings) | verified removals of tracking parameters from page loads and copies, in this browser profile; not a count of blocked trackers |
| Today                               | counts filed under today's local date                                                        |
| Last 7 days                         | today and the six previous local dates                                                       |
| Total                               | since statistics were turned on or last reset                                                |
| + N non-tracking parameters (Experimental, total) | non-tracking parameters removed in Experimental mode, total                                  |

The settings page explains the limits ("What is counted and stored").

## 10. Incognito

Incognito tabs are never counted, also when you allow Untrackable in
incognito: their numbers would outlive the private session. Verified by an e2e
test with a **real incognito window** (developer mode and "Allow in Incognito"
switched on through `chrome://extensions`, as a user would): the link is
cleaned there, neither the page load nor an explicit copy is counted, and the
same page load in a normal window is (Chromium 153, Chrome for Testing 116).

Manual check (for a release candidate): allow Untrackable in incognito
(`chrome://extensions` → Details → Allow in Incognito), turn statistics on,
note the numbers, open an incognito window, visit
`https://example.com/?utm_source=test&id=1` (the address bar shows
`?id=1`), copy the clean link with the popup, close the window – the numbers
must not change. Then visit the same address in a normal window – "Today"
increases by 1.
