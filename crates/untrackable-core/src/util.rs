//! Small string helpers shared by the engine. All functions are total (never panic).

use percent_encoding::percent_decode_str;

/// Trims leading/trailing ASCII whitespace and C0 controls (every char `<= U+0020`).
pub(crate) fn trim_input(s: &str) -> &str {
    s.trim_matches(|c: char| c <= '\u{20}')
}

/// Strict percent-decoding with the semantics of JavaScript `decodeURIComponent`:
/// every `%` must be followed by two hex digits and the decoded bytes must be
/// valid UTF-8. Returns `None` on failure.
pub(crate) fn percent_decode_strict(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let ok = matches!(
                (bytes.get(i + 1), bytes.get(i + 2)),
                (Some(a), Some(b)) if a.is_ascii_hexdigit() && b.is_ascii_hexdigit()
            );
            if !ok {
                return None;
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    percent_decode_str(s)
        .decode_utf8()
        .ok()
        .map(|c| c.into_owned())
}

/// Percent-decodes `s`, falling back to the raw string if decoding fails.
pub(crate) fn percent_decode_or_raw(s: &str) -> String {
    percent_decode_strict(s).unwrap_or_else(|| s.to_owned())
}

/// Returns the raw key of a parameter segment (text before the first `=`).
pub(crate) fn raw_key(segment: &str) -> &str {
    match segment.find('=') {
        Some(i) => &segment[..i],
        None => segment,
    }
}

/// Normalises a raw key: (1) `+` → space, (2) strict percent-decoding — on
/// failure the step-1 string (with spaces) is used, (3) ASCII lower-casing.
pub(crate) fn normalize_key(raw: &str) -> String {
    let plus = raw.replace('+', " ");
    match percent_decode_strict(&plus) {
        Some(decoded) => decoded.to_ascii_lowercase(),
        None => plus.to_ascii_lowercase(),
    }
}

/// `host` matches domain `d` iff `host == d` or `host` ends with `"." + d`.
/// An empty domain never matches.
pub(crate) fn domain_matches(host: &str, domain: &str) -> bool {
    if domain.is_empty() {
        return false;
    }
    if host == domain {
        return true;
    }
    host.len() > domain.len()
        && host.ends_with(domain)
        && host.as_bytes().get(host.len() - domain.len() - 1) == Some(&b'.')
}

/// Normalises a host for matching: ASCII lower-case and ALL trailing `.` removed.
pub(crate) fn normalize_host(host: &str) -> String {
    host.to_ascii_lowercase().trim_end_matches('.').to_owned()
}

/// Hosts must consist of `a-z 0-9 _ . -` (after IDNA, lower-cased) or be a
/// bracketed IPv6 literal. Mirrors the TS engine, which needs this guard
/// because Chromium's URL parser is more lenient than WHATWG.
pub(crate) fn is_sane_host(host: &str) -> bool {
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return !inner.is_empty()
            && inner
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.');
    }
    !host.is_empty()
        && host.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.' || b == b'-'
        })
}

/// Normalises a user exception entry. Returns `None` for entries that should be ignored.
///
/// 1. trim chars `<= U+0020`; 2. ASCII lower-case; 3. strip a leading `*.`;
/// 4. parse as a URL if it contains `://`, otherwise parse `"http://" + entry`
///    (parse failure → ignored); 5. take the host (punycode, lower-case);
/// 6. strip all trailing dots; 7. empty → ignored.
pub(crate) fn normalize_exception(entry: &str) -> Option<String> {
    let lower = trim_input(entry).to_ascii_lowercase();
    let value = lower.strip_prefix("*.").unwrap_or(&lower);
    let parsed = if value.contains("://") {
        url::Url::parse(value)
    } else {
        url::Url::parse(&format!("http://{value}"))
    }
    .ok()?;
    let host = normalize_host(parsed.host_str()?);
    if host.is_empty() || !is_sane_host(&host) {
        None
    } else {
        Some(host)
    }
}

/// A fragment is *param-shaped* if it contains `=`, contains neither `/` nor `?`,
/// and does not start with `:~:` (text fragments are never param-shaped).
pub(crate) fn is_param_shaped_fragment(fragment: &str) -> bool {
    fragment.contains('=')
        && !fragment.contains('/')
        && !fragment.contains('?')
        && !fragment.starts_with(":~:")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_strips_c0_and_space_only() {
        assert_eq!(trim_input("\u{0}\u{1f} a b \u{20}\u{7}"), "a b");
        assert_eq!(trim_input("\u{a0}x\u{a0}"), "\u{a0}x\u{a0}");
        assert_eq!(trim_input("   "), "");
    }

    #[test]
    fn strict_decoding() {
        assert_eq!(
            percent_decode_strict("utm%5Fsource").as_deref(),
            Some("utm_source")
        );
        assert_eq!(percent_decode_strict("caf%C3%A9").as_deref(), Some("café"));
        assert_eq!(percent_decode_strict("foo%ZZ"), None);
        assert_eq!(percent_decode_strict("foo%"), None);
        assert_eq!(percent_decode_strict("foo%4"), None);
        assert_eq!(percent_decode_strict("%C3"), None, "invalid UTF-8");
        assert_eq!(percent_decode_strict("%ED%A0%80"), None, "surrogate");
        assert_eq!(percent_decode_strict("plain").as_deref(), Some("plain"));
    }

    #[test]
    fn key_normalisation() {
        assert_eq!(normalize_key("UTM_Source"), "utm_source");
        assert_eq!(normalize_key("utm+source"), "utm source");
        assert_eq!(normalize_key("utm%2Bsource"), "utm+source");
        assert_eq!(normalize_key("utm_%ZZ"), "utm_%zz");
        // Decode failure falls back to the '+'-replaced string, not the raw key.
        assert_eq!(normalize_key("A+B%ZZ"), "a b%zz");
        assert_eq!(normalize_key("A+B%C3"), "a b%c3");
        // Only ASCII letters are lower-cased.
        assert_eq!(normalize_key("ÄB"), "Äb");
        assert_eq!(raw_key("a=b=c"), "a");
        assert_eq!(raw_key("abc"), "abc");
        assert_eq!(raw_key(""), "");
    }

    #[test]
    fn domain_matching() {
        assert!(domain_matches("example.com", "example.com"));
        assert!(domain_matches("a.b.example.com", "example.com"));
        assert!(!domain_matches("badexample.com", "example.com"));
        assert!(!domain_matches("example.com", "www.example.com"));
        assert!(!domain_matches("example.com", ""));
        assert!(!domain_matches("", "example.com"));
        assert!(!domain_matches("com", "example.com"));
    }

    #[test]
    fn host_normalisation() {
        assert_eq!(normalize_host("YouTube.COM."), "youtube.com");
        assert_eq!(normalize_host("[::1]"), "[::1]");
        assert_eq!(normalize_host("example.com..."), "example.com");
    }

    #[test]
    fn exception_normalisation() {
        let n = |e: &str| normalize_exception(e);
        assert_eq!(n("example.com").as_deref(), Some("example.com"));
        assert_eq!(n("  *.EXAMPLE.com. ").as_deref(), Some("example.com"));
        assert_eq!(
            n("https://Example.com/settings").as_deref(),
            Some("example.com")
        );
        // Bare entries are parsed as "http://" + entry.
        assert_eq!(n("example.com/path").as_deref(), Some("example.com"));
        assert_eq!(n("example.com:8080").as_deref(), Some("example.com"));
        assert_eq!(
            n("bücher.example").as_deref(),
            Some("xn--bcher-kva.example")
        );
        assert_eq!(
            n("BÜCHER.example").as_deref(),
            Some("xn--bcher-kva.example")
        );
        assert_eq!(
            n("http://bücher.example/").as_deref(),
            Some("xn--bcher-kva.example")
        );
        // All trailing dots are stripped.
        assert_eq!(n("example.com...").as_deref(), Some("example.com"));
        assert_eq!(n("https://example.com../x").as_deref(), Some("example.com"));
        // Bracketed IPv6 kept as-is.
        assert_eq!(n("[::1]").as_deref(), Some("[::1]"));
        assert_eq!(n("\u{1}\t 192.168.1.10 ").as_deref(), Some("192.168.1.10"));
        // Ignored entries.
        assert_eq!(n(""), None);
        assert_eq!(n("   "), None);
        assert_eq!(n("*."), None);
        assert_eq!(n("."), None);
        assert_eq!(n("..."), None);
        assert_eq!(n("exa mple.com"), None);
        assert_eq!(n("https://exa mple.com/"), None);
        assert_eq!(n("file:///etc/hosts"), None);
    }

    #[test]
    fn fragment_shape() {
        assert!(is_param_shaped_fragment("utm_source=x"));
        assert!(is_param_shaped_fragment("xtor=RSS-3208&page=2"));
        assert!(is_param_shaped_fragment("="));
        assert!(!is_param_shaped_fragment("section-2"));
        assert!(!is_param_shaped_fragment(""));
        assert!(!is_param_shaped_fragment("/inbox?utm_source=x"));
        assert!(!is_param_shaped_fragment("/a=b"));
        assert!(!is_param_shaped_fragment("a?b=c"));
        // Text fragments are never param-shaped.
        assert!(!is_param_shaped_fragment(":~:text=hello"));
        assert!(!is_param_shaped_fragment(":~:text=a&utm_source=x"));
        assert!(is_param_shaped_fragment("x:~:text=a"));
    }
}
