//! Property tests for the cleaning engine.

use proptest::prelude::*;
use serde_json::Value;
use untrackable_core::{clean, CleanOptions, Mode, Status, EMBEDDED_RULES_JSON};

/// Params of the domain-independent `clean`-mode rules (removed in clean and strict mode
/// on every host). Read from the embedded rule file so the test follows rule changes.
fn global_tracking_keys() -> Vec<String> {
    let rules: Value = serde_json::from_str(EMBEDDED_RULES_JSON).expect("rules parse");
    let mut keys = Vec::new();
    for rule in rules["rules"].as_array().expect("rules array") {
        let global = rule.get("domains").is_none();
        if global && rule["mode"] == "clean" {
            for p in rule["params"].as_array().into_iter().flatten() {
                keys.push(p.as_str().expect("string param").to_owned());
            }
        }
    }
    assert!(!keys.is_empty());
    keys
}

const DOMAINS: &[&str] = &[
    "example.com",
    "shop.example",
    "www.youtube.com",
    "www.amazon.de",
    "www.google.com",
    "x.com",
    "news.example.org",
];

const PATHS: &[&str] = &["/", "/a/b", "/article/42", "/s", "/p/item.html"];

#[derive(Debug, Clone)]
enum Param {
    /// A key from the global tracking rules, possibly with altered ASCII case.
    Tracking { key: String, value: String },
    /// A key that no rule (in any mode, on any host) removes or protects.
    Neutral { key: String, value: String },
}

impl Param {
    fn segment(&self) -> String {
        match self {
            Param::Tracking { key, value } | Param::Neutral { key, value } => {
                format!("{key}={value}")
            }
        }
    }
}

fn param_strategy() -> impl Strategy<Value = Param> {
    let tracking_keys = global_tracking_keys();
    let tracking = (
        proptest::sample::select(tracking_keys),
        any::<bool>(),
        "[A-Za-z0-9]{0,6}",
    )
        .prop_map(|(key, upper, value)| Param::Tracking {
            key: if upper { key.to_ascii_uppercase() } else { key },
            value,
        });
    // "nk" + up to 3 chars: cannot equal/prefix-match any rule param or protection
    // signal (no protection suffix fits, no rule key starts with "nk").
    let neutral = ("nk[a-z0-9]{0,3}", "[A-Za-z0-9%]{0,6}")
        .prop_map(|(key, value)| Param::Neutral { key, value });
    prop_oneof![tracking, neutral]
}

fn url_strategy() -> impl Strategy<Value = (String, Vec<Param>, Option<Vec<Param>>, Mode)> {
    (
        proptest::sample::select(DOMAINS),
        proptest::sample::select(PATHS),
        proptest::collection::vec(param_strategy(), 0..8),
        proptest::option::of(proptest::collection::vec(param_strategy(), 1..4)),
        prop_oneof![Just(Mode::Clean), Just(Mode::Strict)],
    )
        .prop_map(|(domain, path, query, fragment, mode)| {
            let mut url = format!("https://{domain}{path}");
            if !query.is_empty() {
                url.push('?');
                url.push_str(
                    &query
                        .iter()
                        .map(Param::segment)
                        .collect::<Vec<_>>()
                        .join("&"),
                );
            }
            if let Some(f) = &fragment {
                url.push('#');
                url.push_str(&f.iter().map(Param::segment).collect::<Vec<_>>().join("&"));
            }
            (url, query, fragment, mode)
        })
}

fn query_of(url: &str) -> &str {
    let before = url.split('#').next().unwrap_or("");
    before.split_once('?').map(|(_, q)| q).unwrap_or("")
}

fn fragment_of(url: &str) -> &str {
    url.split_once('#').map(|(_, f)| f).unwrap_or("")
}

fn raw_keys(s: &str) -> Vec<&str> {
    if s.is_empty() {
        return Vec::new();
    }
    s.split('&')
        .map(|seg| seg.split('=').next().unwrap_or(""))
        .collect()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// (a) `clean` never panics, in any mode, on arbitrary strings.
    #[test]
    fn never_panics_on_arbitrary_strings(s in any::<String>(), mode in 0u8..3) {
        let mode = [Mode::Clean, Mode::Strict, Mode::Bypass][mode as usize];
        let r = clean(&s, &CleanOptions::new(mode).with_exceptions([s.clone()]));
        prop_assert_eq!(r.changed, r.url != s);
    }

    /// (a') ... including URL-ish strings that reach the cleaning stage.
    #[test]
    fn never_panics_on_urlish_strings(
        s in "(https?|HTTP|ftp)://[a-z.\\[\\]:0-9]{0,12}[/?#&=%a-zA-Z0-9_+.~-]{0,40}",
        strict in any::<bool>(),
    ) {
        let mode = if strict { Mode::Strict } else { Mode::Clean };
        let r = clean(&s, &CleanOptions::new(mode));
        prop_assert_eq!(r.changed, r.url != s);
        if r.status != Status::Cleaned {
            prop_assert_eq!(&r.url, &s);
        }
    }

    /// (b) Idempotence: cleaning the output again changes nothing.
    #[test]
    fn idempotent((url, _q, _f, mode) in url_strategy()) {
        let opts = CleanOptions::new(mode);
        let first = clean(&url, &opts);
        let second = clean(&first.url, &opts);
        prop_assert_eq!(&second.url, &first.url);
        prop_assert!(
            matches!(second.status, Status::Unchanged | Status::Protected),
            "second pass status {:?} for {}", second.status, first.url
        );
        prop_assert!(second.removed.is_empty());
    }

    /// (c) The output never contains a removed tracking key segment, and all
    /// generated tracking keys in the query are removed.
    #[test]
    fn removed_keys_absent((url, query, fragment, mode) in url_strategy()) {
        let r = clean(&url, &CleanOptions::new(mode));
        prop_assert_ne!(r.status, Status::Protected, "generated URL was protected: {}", url);
        let out_query = raw_keys(query_of(&r.url));
        let out_fragment = raw_keys(fragment_of(&r.url));
        for removed in &r.removed {
            prop_assert!(!out_query.contains(&removed.name.as_str()),
                "{} still in query of {}", removed.name, r.url);
            if mode == Mode::Strict {
                prop_assert!(!out_fragment.contains(&removed.name.as_str()),
                    "{} still in fragment of {}", removed.name, r.url);
            }
        }
        for p in &query {
            if let Param::Tracking { key, .. } = p {
                prop_assert!(!out_query.contains(&key.as_str()), "{} survived in {}", key, r.url);
            }
        }
        if mode == Mode::Strict {
            for p in fragment.iter().flatten() {
                if let Param::Tracking { key, .. } = p {
                    prop_assert!(!out_fragment.contains(&key.as_str()),
                        "{} survived in fragment of {}", key, r.url);
                }
            }
        }
    }

    /// (d) Non-tracking segments survive, byte-for-byte and in order.
    #[test]
    fn neutral_segments_survive_in_order((url, query, fragment, mode) in url_strategy()) {
        let r = clean(&url, &CleanOptions::new(mode));
        let expected_query: Vec<String> = query
            .iter()
            .filter(|p| matches!(p, Param::Neutral { .. }))
            .map(Param::segment)
            .collect();
        let got_query: Vec<&str> = if query_of(&r.url).is_empty() {
            Vec::new()
        } else {
            query_of(&r.url).split('&').collect()
        };
        prop_assert_eq!(got_query, expected_query.iter().map(String::as_str).collect::<Vec<_>>());

        if let Some(f) = &fragment {
            let expected_fragment: Vec<String> = if mode == Mode::Strict {
                f.iter().filter(|p| matches!(p, Param::Neutral { .. })).map(Param::segment).collect()
            } else {
                f.iter().map(Param::segment).collect()
            };
            let got_fragment: Vec<&str> = if fragment_of(&r.url).is_empty() {
                Vec::new()
            } else {
                fragment_of(&r.url).split('&').collect()
            };
            prop_assert_eq!(
                got_fragment,
                expected_fragment.iter().map(String::as_str).collect::<Vec<_>>()
            );
        }
        // The part before the query is always preserved.
        prop_assert!(r.url.starts_with(url.split(['?', '#']).next().unwrap_or("")));
    }

    /// (e) Raw string surgery never changes scheme, host, port or path: for
    /// cleaned results, re-parsing the output yields the same components as
    /// parsing the trimmed input (catches trailing-whitespace / delimiter bugs).
    #[test]
    fn cleaning_preserves_scheme_authority_and_path(
        lead in "[ \u{0}\u{1f}]{0,2}",
        scheme in prop_oneof![Just("http"), Just("https"), Just("HTTPS")],
        authority in prop_oneof![
            Just("example.com"),
            Just("Example.COM:8080"),
            Just("user:pw@example.com"),
            Just("[::1]:3000"),
            Just("192.168.1.10"),
            Just("bücher.example"),
            Just("youtube.com.."),
        ],
        path in "(/([a-zA-Z0-9.]|%20|%2F|%2e| |ß|\\\\){0,6}){0,3}",
        path_tail in "[ \u{1}]{0,2}",
        pre in proptest::collection::vec("[a-z]{1,3}(=[a-z %]{0,3})?", 0..3),
        value_tail in "[ \u{1}]{0,2}",
        post in proptest::collection::vec("[a-z]{1,3}(=[a-z %]{0,3})?[ ]{0,1}", 0..3),
        tracking in proptest::sample::select(vec!["utm_source=x", "fbclid", "gclid=1 ", "UTM_X="]),
        fragment in proptest::option::of("[a-z=& ]{0,6}"),
        trail in "[ \u{0}]{0,2}",
        strict in any::<bool>(),
    ) {
        let mut segments: Vec<String> = pre;
        if let Some(last) = segments.last_mut() {
            last.push_str(&value_tail);
        }
        segments.push(tracking.to_owned());
        segments.extend(post);
        let mut input = format!("{lead}{scheme}://{authority}{path}{path_tail}?{}", segments.join("&"));
        if let Some(f) = &fragment {
            input.push('#');
            input.push_str(f);
        }
        input.push_str(&trail);

        let mode = if strict { Mode::Strict } else { Mode::Clean };
        let r = clean(&input, &CleanOptions::new(mode));
        if r.status == Status::Cleaned {
            let trimmed = input.trim_matches(|c: char| c <= '\u{20}');
            let a = url::Url::parse(trimmed).expect("input parsed by engine");
            let b = url::Url::parse(&r.url);
            prop_assert!(b.is_ok(), "output does not parse: {:?}", r.url);
            let b = b.expect("checked");
            prop_assert_eq!(a.scheme(), b.scheme(), "scheme changed for {:?}", input);
            prop_assert_eq!(a.host_str(), b.host_str(), "host changed for {:?}", input);
            prop_assert_eq!(a.port(), b.port(), "port changed for {:?}", input);
            prop_assert_eq!(a.username(), b.username(), "username changed for {:?}", input);
            prop_assert_eq!(a.password(), b.password(), "password changed for {:?}", input);
            prop_assert_eq!(a.path(), b.path(), "path changed for {:?} -> {:?}", input, r.url);
        }
    }
}
