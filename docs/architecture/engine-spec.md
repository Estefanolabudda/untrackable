# Cleaning Engine Specification

This document is the normative specification of the Untrackable cleaning
algorithm. There are two implementations that MUST behave identically:

| Implementation | Location                  | Consumers                                                           |
| -------------- | ------------------------- | ------------------------------------------------------------------- |
| TypeScript     | `packages/core`           | Chromium extension (service worker, content script, popup, options) |
| Rust           | `crates/untrackable-core` | Future macOS / Linux desktop app, CLI                               |

Both implementations load the same rule file (`rules/rules.json`) and are
verified against the same fixture file (`tests/fixtures/cases.json`). A change
to either implementation that makes a shared fixture fail is a bug.

## Inputs

- `input` – a string (untrusted).
- `mode` – `clean` | `strict` | `experimental` | `bypass`.
- `exceptions` – list of domain names supplied by the user (may be empty).

## Output

```
{
  url:     string,           // resulting URL (== input when unchanged)
  changed: boolean,          // url !== input
  status:  "cleaned" | "unchanged" | "protected" | "bypassed" |
           "excepted" | "unsupported" | "invalid",
  removed: [{ name, location: "query" | "fragment", ruleId }],
  reason?: string            // short machine-readable reason for protected
}
```

`removed[].name` is the _raw_ (still percent-encoded) parameter key exactly as
it appeared in the input. Parameter **values are never reported** by the engine.

## Algorithm

Evaluation order (first match wins):

1. **Trim** leading/trailing ASCII whitespace and C0 controls (`<= U+0020`).
   If the trimmed input contains TAB, LF or CR anywhere → `invalid`.
2. **Parse** with a WHATWG-compatible URL parser (JS `URL`, Rust `url`
   crate). Failure → `invalid`.
3. **Scheme** must be `http` or `https`, otherwise → `unsupported`.
   The parsed host (lower-cased) must consist only of `a-z 0-9 _ . -` or be a
   bracketed IPv6 literal (`[` hex digits, `:`, `.` `]`), otherwise →
   `invalid`. (Guards against parsers more lenient than WHATWG, e.g.
   Chromium percent-encodes spaces in hosts.)
   _Implementation-defined:_ hosts that are invalid under IDNA/UTS #46 (e.g.
   undecodable `xn--` labels) may be accepted by some parsers (Chromium) and
   rejected by others. Such inputs are not part of the conformance fixtures;
   the safety property – scheme, authority and path are never changed –
   holds regardless.
4. `mode == bypass` → `bypassed`.
5. **Host** = parsed host (ASCII / punycode, lower-case), all trailing `.` removed.
   If host _domain-matches_ any user exception → `excepted`.
6. **Protection** (see below). Any signal → `protected`.
7. **Cleaning** of the query and (strict only) the fragment; in
   `experimental` mode **query stripping** instead (see below).
8. If nothing was removed → `unchanged` and `url` is the original _untrimmed_
   input. Otherwise → `cleaned`.

Statuses 1–6 always return `url = input` (untouched, untrimmed).

### Domain matching

`host` matches domain `d` iff `host == d` or `host` ends with `"." + d`.
Exception entries are normalised before matching:

1. trim characters `<= U+0020`, ASCII lower-case, strip a leading `*.`;
2. empty → ignored;
3. if the entry contains `://` parse it as a URL, otherwise parse
   `"http://" + entry`; parse failure → ignored;
4. take the parsed host (punycode, lower-case) and strip all trailing `.`;
   empty, or not matching the host alphabet from step 3 → ignored.

So `bücher.example`, `*.Bücher.example.` and `https://bücher.example/x` all
normalise to `xn--bcher-kva.example`.

Rule files are parsed as JSON first; JSON-level edge cases (duplicate keys,
`1.0` vs `1`, lone surrogates in strings) are handled by each platform's JSON
parser and are not part of the parity guarantee – the shipped rule file and
CI keep to plain JSON. Rule-set validation rejects: unknown fields, `null`
lists, missing protection lists (when `protection` is present), empty strings, entries containing ASCII upper
case `A-Z` (non-ASCII is allowed), empty `paramCombinations` entries, an empty
`domains` array (omit the key instead), empty or duplicate rule ids.

### Raw string surgery (encoding preservation)

The output is built from the **original trimmed string**, not from a parser
re-serialisation. This preserves percent-encoding, parameter order, IDN
spelling, ports and everything else byte-for-byte.

- `fragmentStart` = index of the first `#` (or end of string).
- `queryStart` = index of the first `?` _before_ `fragmentStart` (or none).
- `prefix` = `trimmed[0 .. queryStart or fragmentStart]`
- `query` = text between `?` and `#` (without them), or none.
- `fragment` = text after `#`, or none.

This is sound for `http(s)` URLs because the WHATWG parser terminates the
authority and path at the first `?` or `#` for special schemes.

Result: `prefix + ("?" + newQuery) + ("#" + newFragment)`, where each part is
emitted whenever it existed in the input, **except** that `?` (resp. `#`) is
dropped when at least one parameter was removed from that part _and_ the part
became empty. A part that was already empty (`https://e.example/?#`) keeps its
delimiter. A fragment is only rewritten in strict mode.

**Trailing whitespace guard:** if the resulting string ends with one or more
characters `<= U+0020` (possible when such a character preceded a removed
segment, e.g. `/download%20 ?utm_source=x`), each of those trailing
characters is replaced by its `%HH` encoding (upper-case hex). A WHATWG
parser would otherwise strip them and change the path or a value.

### Parameter splitting and key normalisation

A query (or param-shaped fragment) is split on `&` into segments. Each segment
keeps its raw text. The **raw key** is the part before the first `=` (the whole
segment if there is no `=`). The **normalised key** is:

1. `+` replaced with a space,
2. percent-decoded as UTF-8 – strictly, like JS `decodeURIComponent`: every
   `%` must be followed by two hex digits and the bytes must be valid UTF-8;
   on failure the string from step 1 is used unchanged,
3. ASCII lower-cased (only `A-Z` are changed).

Empty segments (e.g. from `a=1&&b=2`) are preserved as-is.

### Rule matching

A rule applies when its `mode` is `clean` (applies in clean _and_ strict mode)
or `strict` (strict mode only) **and** it has no `domains` or the host
domain-matches one of them. A segment is removed if its normalised key equals
one of the applicable rules' `params` or starts with one of their `prefixes`.
All occurrences of a key are removed (duplicates included). The `ruleId` in the
result is the first applicable rule (in file order) that matches.

### Experimental mode: query stripping

`experimental` does not use the tracker rules at all. After steps 1–6
(including the additional protection signal `experimentalParams`, see below):

- If there is no query, or every `&`-separated segment of the query is empty
  (`?`, `?&&`), nothing is removed → `unchanged`.
- Otherwise **every non-empty segment** is removed, whatever its name, in order
  of appearance; each is reported with its raw key, `location: "query"` and
  `ruleId: "experimental"`. The query became empty through removal, so the `?`
  is dropped (general delimiter rule). Empty segments are not reported.
- The fragment is **never** modified in `experimental` mode (it is kept
  verbatim, even when param-shaped).
- The trailing whitespace guard applies as usual.

Example: `https://example.com/a?utm_source=x&id=1&&ref=y#top` →
`https://example.com/a#top`, removed `utm_source`, `id`, `ref`.

### Fragments (strict mode only)

A fragment is _param-shaped_ if it contains `=`, does not contain `/` or
`?`, and does not start with `:~:` (text fragments). Param-shaped fragments are split and cleaned exactly like the query.
Fragments that are not param-shaped (anchors, SPA routes like `#/a?b=c`,
text fragments `#:~:text=`) are never modified.

### Protection signals

A URL is protected (never modified) if any of the following holds. The `reason`
string is the first signal found, in this order:

1. `domain:<d>` – host domain-matches `protection.domains`.
2. `path:<kw>` – the percent-decoded (fallback: raw), ASCII-lower-cased
   pathname matches `(^|[/_.-])(kw)($|[/_.0-9-])` for some `kw` in
   `protection.pathKeywords` (keywords are regex-escaped; first keyword in
   file order wins). Then, if no keyword matched: the same decoded path
   **contains** some entry of `protection.pathSubstrings` as a plain
   substring (catches `resetPassword`, `UnsubscribePage.html`, …); the reason
   is `path:<substring>`, first entry in file order wins.
3. `param:<key>` – any normalised key of the **query or the fragment**
   (fragment split on `&` whenever it contains `=`, regardless of shape)
   equals a `protection.params` entry, starts with a `paramPrefixes` entry or
   ends with a `paramSuffixes` entry. Keys are checked in order of appearance,
   query first.
   In `experimental` mode only, a key that equals a
   `protection.experimentalParams` entry is also a signal (same position in
   the order: each key is checked against all of these lists before the next
   key). These names are functional in practice (OAuth `code`/`state`, CSRF
   tokens, payment return parameters, expiry of signed links) but too common
   to protect in Clean and Strict, where unknown parameters are kept anyway.
4. `combination:<a>+<b>` – all keys of a `paramCombinations` entry are present
   among the query and fragment keys.

Protection is a heuristic. It intentionally errs on the side of not cleaning.

## Browser navigation (declarativeNetRequest)

The extension cannot run this algorithm synchronously for navigations, so it
compiles `rules.json` + settings into declarativeNetRequest rules
(`packages/core/src/dnr.ts`). Those rules are a conservative approximation:

- Parameter removal uses `queryTransform.removeParams` (exact keys), followed
  by case-insensitive, byte-preserving `regexSubstitution` fallback rules that
  also cover prefix rules. Chromium normalises valueless/empty query segments
  when `queryTransform` removes something (see the architecture overview).
- Protection is compiled into higher-priority `allow` rules using equivalent
  RE2 regular expressions over the raw URL. Because DNR cannot decode, any
  URL whose path or a parameter key contains a percent-encoded letter, `-`,
  `_` or `.` is additionally allowed (left alone) during navigation.
- Fragments are never sent in HTTP requests and are not touched by navigation
  cleaning. Chromium matches rules against the URL including the fragment, so
  parameter protection signals are matched after `?`, `&` or `#`.
- `experimental` compiles to a single `redirect` with
  `transform: { query: "" }` for `GET` main-frame requests whose query has a
  non-empty segment (`regexFilter` `^[^?#]*\?[^#]*[^&#]`), below the same
  protection, `experimentalParams` and exception `allow` rules. The tracker
  rules are not installed in this mode.

See `docs/architecture/overview.md` for details.
