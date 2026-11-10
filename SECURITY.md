# Security Policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's
private vulnerability reporting ("Security" tab → "Report a vulnerability")
on this repository.

Include affected version, reproduction steps and impact. We aim to
acknowledge reports within 7 days.

Of particular interest:

- URLs that Untrackable modifies in a way that breaks sign-in, payment or
  signed-download flows (functional safety issue),
- ways for a web page to influence the extension's behaviour,
- any data leaving the device.

Never include real tokens, passwords or personal URLs in reports – replace
them with placeholders.

The threat model is documented in [`docs/security/threat-model.md`](docs/security/threat-model.md).
