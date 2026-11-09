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
}

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

        // 1. Trim; reject embedded TAB/LF/CR.
        let trimmed = trim_input(input);
        if trimmed.contains(['\t', '\n', '\r']) {
            return untouched(Status::Invalid, None);
        }

        // 2. Parse.
        let parsed = match url::Url::parse(trimmed) {
            Ok(u) => u,
            Err(_) => return untouched(Status::Invalid, None),
        };

        // 3. Scheme.
        if !matches!(parsed.scheme(), "http" | "https") {
            return untouched(Status::Unsupported, None);
        }
        if !is_sane_host(&parsed.host_str().unwrap_or("").to_ascii_lowercase()) {
            return untouched(Status::Invalid, None);
        }

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
        if let Some(reason) = self.protection_reason(&host, parsed.path(), &parts) {
            return untouched(Status::Protected, Some(reason));
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

    fn protection_reason(&self, host: &str, pathname: &str, parts: &Parts<'_>) -> Option<String> {
        let p = &self.protection;

        // 1. Domain.
        if let Some(d) = p.domains.iter().find(|d| domain_matches(host, d)) {
            return Some(format!("domain:{d}"));
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
        combo.map(|c| format!("combination:{}", c.join("+")))
    }
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
