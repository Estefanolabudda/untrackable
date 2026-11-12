//! The cleaning engine (see `docs/architecture/engine-spec.md`).

use std::collections::HashSet;

use regex::Regex;

use crate::rules::{RuleMode, RuleSet, RuleSetError};
use crate::util::{
    domain_matches, is_param_shaped_fragment, is_sane_host, normalize_exception, normalize_host,
    normalize_key, percent_decode_or_raw, raw_key, trim_input,
};
use crate::{CleanOptions, CleanResult, Location, Mode, RemovedParam, Status};

#[derive(Debug, Clone)]
struct CompiledRule {
    id: String,
    mode: RuleMode,
    domains: Vec<String>,
    params: HashSet<String>,
    prefixes: Vec<String>,
}

impl CompiledRule {
    fn applies(&self, mode: Mode, host: &str) -> bool {
        let mode_ok = match self.mode {
            RuleMode::Clean => true,
            RuleMode::Strict => mode == Mode::Strict,
        };
        mode_ok && (self.domains.is_empty() || self.domains.iter().any(|d| domain_matches(host, d)))
    }

    fn matches(&self, key: &str) -> bool {
        self.params.contains(key) || self.prefixes.iter().any(|p| key.starts_with(p.as_str()))
    }
}

#[derive(Debug, Clone)]
struct CompiledProtection {
    domains: Vec<String>,
    path_keywords: Vec<(String, Regex)>,
    path_substrings: Vec<String>,
    params: HashSet<String>,
    param_prefixes: Vec<String>,
    param_suffixes: Vec<String>,
    param_combinations: Vec<Vec<String>>,
    experimental_params: HashSet<String>,
    experimental_host_labels: HashSet<String>,
}

/// `rule_id` reported for parameters removed by experimental query stripping
/// ([`Mode::Experimental`]) and by [`strip_query`].
pub const EXPERIMENTAL_RULE_ID: &str = "experimental";

/// A cleaning engine bound to one [`RuleSet`]. Cheap to share (`Send + Sync`);
/// construct once and reuse.
#[derive(Debug, Clone)]
pub struct Engine {
    rules: Vec<CompiledRule>,
    protection: CompiledProtection,
}

/// Raw string decomposition of a trimmed URL.
struct Parts<'a> {
    prefix: &'a str,
    query: Option<&'a str>,
    fragment: Option<&'a str>,
}

/// Input validation, spec steps 1–3: trim, reject TAB/LF/CR, parse, require
/// `http`/`https` and a sane host. Returns the trimmed input and the parsed URL.
fn validate_input(input: &str) -> Result<(&str, url::Url), Status> {
    // 1. Trim; reject embedded TAB/LF/CR.
    let trimmed = trim_input(input);
    if trimmed.contains(['\t', '\n', '\r']) {
        return Err(Status::Invalid);
    }

    // 2. Parse.
    let parsed = url::Url::parse(trimmed).map_err(|_| Status::Invalid)?;

    // 3. Scheme.
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(Status::Unsupported);
    }
    if !is_sane_host(&parsed.host_str().unwrap_or("").to_ascii_lowercase()) {
        return Err(Status::Invalid);
    }
    Ok((trimmed, parsed))
}

/// Explicit user action "Copy/Open link without query parameters": strips the
/// whole query of an `http`/`https` URL. Unlike [`Engine::clean`] this ignores
/// mode, exceptions and protection signals; input validation (spec steps 1–3)
/// is the same. Every non-empty query segment is reported with rule id
/// [`EXPERIMENTAL_RULE_ID`]; the fragment is kept verbatim. Never panics.
pub fn strip_query(input: &str) -> CleanResult {
    match validate_input(input) {
        Ok((trimmed, _)) => strip_parts(input, &split_parts(trimmed)),
        Err(status) => CleanResult {
            url: input.to_owned(),
            changed: false,
            status,
            removed: Vec::new(),
            reason: None,
        },
    }
}

/// Removes every non-empty query segment and keeps the fragment verbatim (spec:
/// "Experimental mode: query stripping"). `input` is the untrimmed original.
fn strip_parts(input: &str, parts: &Parts<'_>) -> CleanResult {
    let removed: Vec<RemovedParam> = parts
        .query
        .unwrap_or("")
        .split('&')
        .filter(|seg| !seg.is_empty())
        .map(|seg| RemovedParam {
            name: raw_key(seg).to_owned(),
            location: Location::Query,
            rule_id: EXPERIMENTAL_RULE_ID.to_owned(),
        })
        .collect();
    if removed.is_empty() {
        return CleanResult {
            url: input.to_owned(),
            changed: false,
            status: Status::Unchanged,
            removed,
            reason: None,
        };
    }
    let mut url = String::with_capacity(input.len());
    url.push_str(parts.prefix);
    if let Some(f) = parts.fragment {
        url.push('#');
        url.push_str(f);
    }
    let url = encode_trailing_controls(url);
    let changed = url != input;
    CleanResult {
        url,
        changed,
        status: Status::Cleaned,
        removed,
        reason: None,
    }
}

fn split_parts(trimmed: &str) -> Parts<'_> {
    let fragment_start = trimmed.find('#');
    let before_fragment = &trimmed[..fragment_start.unwrap_or(trimmed.len())];
    let query_start = before_fragment.find('?');
    let prefix_end = query_start.or(fragment_start).unwrap_or(trimmed.len());
    Parts {
        prefix: &trimmed[..prefix_end],
        query: query_start.map(|q| &before_fragment[q + 1..]),
        fragment: fragment_start.map(|f| &trimmed[f + 1..]),
    }
}

impl Engine {
    /// Builds an engine from an already-parsed rule set.
    pub fn new(rules: RuleSet) -> Result<Self, RuleSetError> {
        let compiled_rules = rules
            .rules
            .into_iter()
            .map(|r| CompiledRule {
                id: r.id,
                mode: r.mode,
                domains: r.domains.unwrap_or_default(),
                params: r.params.into_iter().collect(),
                prefixes: r.prefixes,
            })
            .collect();

        let p = rules.protection;
        let mut path_keywords = Vec::with_capacity(p.path_keywords.len());
        for kw in p.path_keywords {
            let pattern = format!("(^|[/_.-])({})($|[/_.0-9-])", regex::escape(&kw));
            match Regex::new(&pattern) {
                Ok(re) => path_keywords.push((kw, re)),
                Err(source) => {
                    return Err(RuleSetError::PathKeyword {
                        keyword: kw,
                        source,
                    })
                }
            }
        }

        Ok(Engine {
            rules: compiled_rules,
            protection: CompiledProtection {
                domains: p.domains,
                path_keywords,
                path_substrings: p.path_substrings,
                params: p.params.into_iter().collect(),
                param_prefixes: p.param_prefixes,
                param_suffixes: p.param_suffixes,
                param_combinations: p.param_combinations,
                experimental_params: p.experimental_params.into_iter().collect(),
                experimental_host_labels: p.experimental_host_labels.into_iter().collect(),
            },
        })
    }

    /// Builds an engine from rule-set JSON text (same schema as `rules/rules.json`).
    /// Never panics; malformed input yields an error.
    pub fn from_json(json: &str) -> Result<Self, RuleSetError> {
        Engine::new(RuleSet::from_json(json)?)
    }

    /// Cleans `input` according to the spec. Never panics.
    pub fn clean(&self, input: &str, opts: &CleanOptions) -> CleanResult {
        let untouched = |status: Status, reason: Option<String>| CleanResult {
            url: input.to_owned(),
            changed: false,
            status,
            removed: Vec::new(),
            reason,
        };

        // 1.–3. Trim, parse, scheme.
        let (trimmed, parsed) = match validate_input(input) {
            Ok(v) => v,
            Err(status) => return untouched(status, None),
        };

        // 4. Bypass.
        if opts.mode == Mode::Bypass {
            return untouched(Status::Bypassed, None);
        }

        // 5. Host + user exceptions.
        let host = normalize_host(parsed.host_str().unwrap_or(""));
        let excepted = opts
            .exceptions
            .iter()
            .filter_map(|e| normalize_exception(e))
            .any(|d| domain_matches(&host, &d));
        if excepted {
            return untouched(Status::Excepted, None);
        }

        let parts = split_parts(trimmed);

        // 6. Protection.
        let experimental = opts.mode == Mode::Experimental;
        if let Some(reason) = self.protection_reason(&host, parsed.path(), &parts, experimental) {
            return untouched(Status::Protected, Some(reason));
        }

        // 7'. Experimental: query stripping, every non-empty segment goes.
        if experimental {
            return strip_parts(input, &parts);
        }

        // 7. Cleaning.
        let applicable: Vec<&CompiledRule> = self
            .rules
            .iter()
            .filter(|r| r.applies(opts.mode, &host))
            .collect();
        let mut removed = Vec::new();

        // Each part is `Some((new_text, removed_something))` when it existed in the input.
        let new_query = parts.query.map(|q| {
            let before = removed.len();
            let text = clean_params(q, &applicable, Location::Query, &mut removed);
            (text, removed.len() > before)
        });
        let new_fragment = parts.fragment.map(|f| {
            if opts.mode == Mode::Strict && is_param_shaped_fragment(f) {
                let before = removed.len();
                let text = clean_params(f, &applicable, Location::Fragment, &mut removed);
                (text, removed.len() > before)
            } else {
                (f.to_owned(), false)
            }
        });

        // 8. Result.
        if removed.is_empty() {
            return untouched(Status::Unchanged, None);
        }

        // A delimiter is dropped only when its part was rewritten and became empty;
        // otherwise it is kept (with the possibly empty original text).
        let mut url = String::with_capacity(trimmed.len());
        url.push_str(parts.prefix);
        if let Some((q, rewritten)) = new_query {
            if !(rewritten && q.is_empty()) {
                url.push('?');
                url.push_str(&q);
            }
        }
        if let Some((f, rewritten)) = new_fragment {
            if !(rewritten && f.is_empty()) {
                url.push('#');
                url.push_str(&f);
            }
        }
        let url = encode_trailing_controls(url);
        let changed = url != input;
        CleanResult {
            url,
            changed,
            status: Status::Cleaned,
            removed,
            reason: None,
        }
    }

    fn protection_reason(
        &self,
        host: &str,
        pathname: &str,
        parts: &Parts<'_>,
        experimental: bool,
    ) -> Option<String> {
        let p = &self.protection;

        // 1. Domain.
        if let Some(d) = p.domains.iter().find(|d| domain_matches(host, d)) {
            return Some(format!("domain:{d}"));
        }
        // 1b. Experimental only: a sign-in/payment host label (`login.example.com`).
        if experimental {
            if let Some((label, _)) = host.split_once('.') {
                if !label.is_empty() && p.experimental_host_labels.contains(label) {
                    return Some(format!("host:{label}"));
                }
            }
        }

        // 2. Path keyword (first keyword in file order).
        let path = percent_decode_or_raw(pathname).to_ascii_lowercase();
        if let Some((kw, _)) = p.path_keywords.iter().find(|(_, re)| re.is_match(&path)) {
            return Some(format!("path:{kw}"));
        }
        // 2b. Path substrings (first entry in file order), only if no keyword matched.
        if let Some(sub) = p
            .path_substrings
            .iter()
            .find(|sub| path.contains(sub.as_str()))
        {
            return Some(format!("path:{sub}"));
        }

        // 3. Params (query keys first, then fragment keys when the fragment contains '=').
        let mut keys: Vec<String> = Vec::new();
        if let Some(q) = parts.query {
            keys.extend(q.split('&').map(|s| normalize_key(raw_key(s))));
        }
        if let Some(f) = parts.fragment.filter(|f| f.contains('=')) {
            keys.extend(f.split('&').map(|s| normalize_key(raw_key(s))));
        }
        let protected_key = keys.iter().find(|k| {
            p.params.contains(k.as_str())
                || (experimental && p.experimental_params.contains(k.as_str()))
                || p.param_prefixes.iter().any(|x| k.starts_with(x.as_str()))
                || p.param_suffixes.iter().any(|x| k.ends_with(x.as_str()))
        });
        if let Some(k) = protected_key {
            return Some(format!("param:{k}"));
        }

        // 4. Combinations.
        let combo = p
            .param_combinations
            .iter()
            .find(|c| c.iter().all(|needed| keys.iter().any(|k| k == needed)));
        if let Some(c) = combo {
            return Some(format!("combination:{}", c.join("+")));
        }

        // 5. Experimental only: a value that is itself an (encoded) http(s) URL.
        if experimental {
            let query_segments = parts.query.into_iter().flat_map(|q| q.split('&'));
            let fragment_segments = parts
                .fragment
                .filter(|f| f.contains('='))
                .into_iter()
                .flat_map(|f| f.split('&'));
            if query_segments.chain(fragment_segments).any(value_is_url) {
                return Some("value:url".to_owned());
            }
        }
        None
    }
}

/// Spec signal `value:url`: the segment's raw value starts with an (encoded) http(s) URL.
fn value_is_url(segment: &str) -> bool {
    let Some((_, value)) = segment.split_once('=') else {
        return false;
    };
    let v = value.as_bytes();
    ["http://", "https://", "http%3a%2f%2f", "https%3a%2f%2f"]
        .iter()
        .any(|p| v.len() >= p.len() && v[..p.len()].eq_ignore_ascii_case(p.as_bytes()))
}

/// Trailing whitespace guard: replaces every trailing char `<= U+0020` with its
/// `%HH` encoding (upper-case hex) so a WHATWG parser cannot strip it.
fn encode_trailing_controls(mut url: String) -> String {
    let kept_len = url.trim_end_matches(|c: char| c <= '\u{20}').len();
    if kept_len == url.len() {
        return url;
    }
    let tail: String = url[kept_len..]
        .bytes()
        .map(|b| format!("%{b:02X}"))
        .collect();
    url.truncate(kept_len);
    url.push_str(&tail);
    url
}

/// Splits `s` on `&`, removes tracking segments, records them and returns the rest joined.
fn clean_params(
    s: &str,
    applicable: &[&CompiledRule],
    location: Location,
    removed: &mut Vec<RemovedParam>,
) -> String {
    let mut kept: Vec<&str> = Vec::new();
    for segment in s.split('&') {
        let raw = raw_key(segment);
        let key = normalize_key(raw);
        match applicable.iter().find(|r| r.matches(&key)) {
            Some(rule) => removed.push(RemovedParam {
                name: raw.to_owned(),
                location,
                rule_id: rule.id.clone(),
            }),
            None => kept.push(segment),
        }
    }
    kept.join("&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_parts_basic() {
        let p = split_parts("https://a/b?c=1#d?e");
        assert_eq!(p.prefix, "https://a/b");
        assert_eq!(p.query, Some("c=1"));
        assert_eq!(p.fragment, Some("d?e"));

        let p = split_parts("https://a/#x?y");
        assert_eq!(p.prefix, "https://a/");
        assert_eq!(p.query, None);
        assert_eq!(p.fragment, Some("x?y"));

        let p = split_parts("https://a/?");
        assert_eq!(p.prefix, "https://a/");
        assert_eq!(p.query, Some(""));
        assert_eq!(p.fragment, None);
    }

    fn run(input: &str, mode: Mode) -> CleanResult {
        crate::clean(input, &CleanOptions::new(mode))
    }

    #[test]
    fn text_fragment_never_rewritten() {
        let r = run(
            "https://e.com/p?utm_source=x#:~:text=a&utm_medium=b",
            Mode::Strict,
        );
        assert_eq!(r.url, "https://e.com/p#:~:text=a&utm_medium=b");
        assert_eq!(r.removed.len(), 1);
        let r = run("https://e.com/p#:~:text=a&utm_medium=b", Mode::Strict);
        assert_eq!(r.status, Status::Unchanged);
    }

    #[test]
    fn delimiters_dropped_only_when_part_rewritten_to_empty() {
        // Empty original fragment is kept.
        let r = run("https://e.com/?utm_source=x#", Mode::Clean);
        assert_eq!(r.url, "https://e.com/#");
        assert_eq!(r.status, Status::Cleaned);
        // Non-param fragment kept verbatim.
        let r = run("https://e.com/?utm_source=x#top", Mode::Strict);
        assert_eq!(r.url, "https://e.com/#top");
        // Fragment rewritten to empty: '#' dropped.
        let r = run("https://e.com/a?id=1#utm_source=x", Mode::Strict);
        assert_eq!(r.url, "https://e.com/a?id=1");
        // Originally empty query, fragment param removed: '?' kept.
        let r = run("https://e.com/a?#utm_source=x&k=1", Mode::Strict);
        assert_eq!(r.url, "https://e.com/a?#k=1");
        // Query untouched (non-empty), fragment rewritten to empty.
        let r = run("https://e.com/a?k=1#utm_source=x", Mode::Strict);
        assert_eq!(r.url, "https://e.com/a?k=1");
        // Query rewritten to empty → '?' dropped; empty original '#' kept.
        let r = run("https://e.com/a?utm_source=x#", Mode::Strict);
        assert_eq!(r.url, "https://e.com/a#");
        // Query rewritten to only an empty segment joins to "" → '?' dropped.
        let r = run("https://e.com/a?&utm_source=x", Mode::Clean);
        assert_eq!(r.url, "https://e.com/a");
        // Nothing removed: verbatim.
        let r = run("https://e.com/?#", Mode::Strict);
        assert_eq!(r.status, Status::Unchanged);
        assert_eq!(r.url, "https://e.com/?#");
    }

    fn names(r: &CleanResult) -> Vec<(&str, Location, &str)> {
        r.removed
            .iter()
            .map(|p| (p.name.as_str(), p.location, p.rule_id.as_str()))
            .collect()
    }

    #[test]
    fn experimental_mode_strips_query_keeps_fragment() {
        let r = run(
            "https://example.com/a?utm_source=x&id=1&&ref=y#top",
            Mode::Experimental,
        );
        assert_eq!(r.url, "https://example.com/a#top");
        assert_eq!(r.status, Status::Cleaned);
        assert!(r.changed);
        assert_eq!(
            names(&r),
            vec![
                ("utm_source", Location::Query, EXPERIMENTAL_RULE_ID),
                ("id", Location::Query, EXPERIMENTAL_RULE_ID),
                ("ref", Location::Query, EXPERIMENTAL_RULE_ID),
            ]
        );
        // Param-shaped fragment is never touched; empty original '#' kept.
        let r = run("https://e.com/?x=1#utm_source=y", Mode::Experimental);
        assert_eq!(r.url, "https://e.com/#utm_source=y");
        let r = run("https://e.com/?x=1#", Mode::Experimental);
        assert_eq!(r.url, "https://e.com/#");
        // Only empty segments / no query: verbatim, untrimmed.
        for u in [
            " https://e.com/?&& ",
            "https://e.com/?",
            "https://e.com/#a=1",
        ] {
            let r = run(u, Mode::Experimental);
            assert_eq!(r.status, Status::Unchanged, "{u}");
            assert_eq!(r.url, u);
            assert!(r.removed.is_empty());
        }
        // Trailing whitespace guard applies.
        assert_eq!(
            run("https://e.com/a ?x=1", Mode::Experimental).url,
            "https://e.com/a%20"
        );
    }

    #[test]
    fn experimental_params_protect_only_in_experimental_mode() {
        let r = run("https://app.example/welcome?code=abc", Mode::Experimental);
        assert_eq!(r.status, Status::Protected);
        assert_eq!(r.reason.as_deref(), Some("param:code"));
        // In clean/strict mode `code` is just an unknown (kept) parameter.
        for mode in [Mode::Clean, Mode::Strict] {
            let r = run("https://app.example/welcome?code=abc&utm_source=x", mode);
            assert_eq!(r.status, Status::Cleaned);
            assert_eq!(r.url, "https://app.example/welcome?code=abc");
        }
        // Same key-order position as `params`: the first protected key wins.
        let engine = Engine::from_json(
            r#"{"schemaVersion":1,"rules":[],"protection":{"domains":[],"pathKeywords":[],
               "pathSubstrings":[],"params":["sig"],"paramPrefixes":[],"paramSuffixes":["_token"],
               "paramCombinations":[],"experimentalParams":["state"]}}"#,
        )
        .expect("valid");
        let reason = |u: &str| {
            engine
                .clean(u, &CleanOptions::new(Mode::Experimental))
                .reason
        };
        assert_eq!(
            reason("https://e.com/?state=1&sig=2").as_deref(),
            Some("param:state")
        );
        assert_eq!(
            reason("https://e.com/?a_token=1&state=2").as_deref(),
            Some("param:a_token")
        );
        assert_eq!(
            reason("https://e.com/?x=1#STATE=2").as_deref(),
            Some("param:state")
        );
        assert_eq!(reason("https://e.com/?x=1#STATE"), None);
    }

    #[test]
    fn strip_query_ignores_mode_exceptions_and_protection() {
        let r = strip_query("https://app.example/login?code=abc&utm_source=x#top");
        assert_eq!(r.url, "https://app.example/login#top");
        assert_eq!(r.status, Status::Cleaned);
        assert_eq!(r.reason, None);
        assert_eq!(
            names(&r),
            vec![
                ("code", Location::Query, EXPERIMENTAL_RULE_ID),
                ("utm_source", Location::Query, EXPERIMENTAL_RULE_ID),
            ]
        );
        let r = strip_query("https://checkout.stripe.com/x?a=1&&B");
        assert_eq!(r.url, "https://checkout.stripe.com/x");
        assert_eq!(names(&r).len(), 2);
        // Leading/trailing whitespace trimmed; exposed trailing whitespace encoded.
        let r = strip_query("  https://e.com/a ?x=1\u{1}");
        assert_eq!(r.url, "https://e.com/a%20");
        assert!(r.changed);
    }

    #[test]
    fn strip_query_unchanged_and_validation() {
        for u in [
            "https://e.com/",
            "https://e.com/?",
            "https://e.com/?&#a=1",
            " http://e.com/#x?y=1 ",
        ] {
            let r = strip_query(u);
            assert_eq!(r.status, Status::Unchanged, "{u}");
            assert_eq!(r.url, u);
            assert!(!r.changed);
        }
        let status = |u: &str| strip_query(u).status;
        assert_eq!(status("ftp://e.com/?x=1"), Status::Unsupported);
        assert_eq!(status("mailto:a@b.example?subject=x"), Status::Unsupported);
        assert_eq!(status("not a url"), Status::Invalid);
        assert_eq!(status(""), Status::Invalid);
        assert_eq!(status("https://e.com/?a=1\tb"), Status::Invalid);
        assert_eq!(status("https://e.com/?a=\n1"), Status::Invalid);
        let r = strip_query("ftp://e.com/?x=1");
        assert_eq!(r.url, "ftp://e.com/?x=1");
        assert!(r.removed.is_empty());
    }

    #[test]
    fn exceptions_and_host_trailing_dots() {
        let opts = |e: &str| CleanOptions::default().with_exceptions([e]);
        let r = crate::clean(
            "https://xn--bcher-kva.example/?utm_source=x",
            &opts("bücher.example"),
        );
        assert_eq!(r.status, Status::Excepted);
        let r = crate::clean(
            "https://bücher.example/?utm_source=x",
            &opts("BÜCHER.example"),
        );
        assert_eq!(r.status, Status::Excepted);
        let r = crate::clean(
            "https://www.example.com/?utm_source=x",
            &opts("example.com/path"),
        );
        assert_eq!(r.status, Status::Excepted);
        let r = crate::clean("https://example.com../?utm_source=x", &opts("example.com"));
        assert_eq!(r.status, Status::Excepted);
        let r = crate::clean("http://[::1]:8080/?utm_source=x", &opts("[::1]"));
        assert_eq!(r.status, Status::Excepted);
        let r = crate::clean("https://example.com/?utm_source=x", &opts("exa mple.com"));
        assert_eq!(r.status, Status::Cleaned);
        // All trailing dots stripped for rule domains too.
        let r = run("https://youtube.com../watch?v=1&si=2", Mode::Clean);
        assert_eq!(r.url, "https://youtube.com../watch?v=1");
    }
}
