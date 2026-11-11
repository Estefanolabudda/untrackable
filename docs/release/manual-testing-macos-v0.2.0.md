# Manual test plan – Experimental mode, Chrome on macOS (v0.2.0)

Short plan for the maintainer before approving the v0.2.0 merge. The full
v0.1.0 checklist (`manual-testing-macos.md`) still applies to Clean/Strict.

## 0. Setup

1. Download the CI artifact `untrackable-chromium-0.2.0.zip` of the v0.2.0
   pull request (or `npm ci && npm run package -w apps/browser-extension`),
   check its SHA-256, unzip.
2. `chrome://extensions` → remove the old Untrackable (or use a separate
   Chrome profile) → Developer mode → **Load unpacked** → the unzipped folder.

## 1. Opt-in and way back

- [ ] Popup → select **Experimental**: a warning appears, nothing changes yet
      (badge still empty). **Cancel** (or Escape) returns to Clean.
- [ ] Select Experimental again → **Use Experimental**: badge `E`, status
      "Experimental", notice with **Back to Clean**.
- [ ] **Back to Clean** → badge empty, Clean selected. Same in Settings.

## 2. Stripping (Experimental on)

- [ ] `https://example.com/?utm_source=x&id=1#top` → address bar shows
      `https://example.com/#top`.
- [ ] A link from a newsletter e-mail (e.g. Stripe support
      `support.stripe.com/?email_id=…`) opens without `?…`.
- [ ] A search on a site of your choice: the results page probably breaks
      (expected) – **Back to Clean** fixes it.

## 3. Must keep working (Experimental on)

- [ ] Sign in with Google / Microsoft / GitHub on a third-party site.
- [ ] A password-reset or "verify your e-mail" link from a real e-mail.
- [ ] A test purchase or the Stripe/PayPal return page of a shop you use.
- [ ] The ChatGPT e-mail link from the v0.1.0 report (signed in).
- [ ] A Google Drive / Dropbox shared download link.

## 4. Controls (Experimental on)

- [ ] Site exception for a site → its links keep their query.
- [ ] Pause for 15 minutes, Pause in this tab → queries kept; resume →
      stripped again.
- [ ] Right-click a link → **Open link without cleaning** → original opens.
- [ ] Right-click → **Copy link without query parameters** → paste: no `?…`
      (also in Clean mode).
- [ ] Right-click → **Open link without query parameters** → new tab without
      `?…`.
- [ ] Cmd+C on a selected link (Experimental on) → link with trackers removed
      (Strict rules), functional parameters kept.
- [ ] An Outlook/Google redirect link (`…?url=https%3A…`) opens normally.

## 5. Sign-off

Record: Chrome version, macOS version, ZIP SHA-256, date, failures.
