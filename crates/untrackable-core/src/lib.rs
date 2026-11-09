//! # untrackable-core
//!
//! Rust implementation of the Untrackable URL cleaning engine. It removes
//! tracking parameters (e.g. `utm_*`, `fbclid`) from URLs while preserving the
//! rest of the URL byte-for-byte, and refuses to touch URLs that look like
//! logins, payments or signed downloads.
//!
//! The behaviour is specified normatively in
//! `docs/architecture/engine-spec.md` and must match the TypeScript engine
//! (`packages/core`); both are verified against `tests/fixtures/cases.json`.
//!
//! ```
//! use untrackable_core::{clean, CleanOptions, Status};
//!
//! let r = clean("https://example.com/a?utm_source=x&id=1", &CleanOptions::default());
//! assert_eq!(r.url, "https://example.com/a?id=1");
//! assert_eq!(r.status, Status::Cleaned);
//! assert_eq!(r.removed[0].rule_id, "utm");
//! ```
//!
//! The engine never panics on any input and never logs.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

mod engine;
mod rules;
mod util;

pub use engine::Engine;
pub use rules::{Protection, Rule, RuleMode, RuleSet, RuleSetError, SUPPORTED_SCHEMA_VERSION};

/// The bundled rule file (`rules/rules.json`), embedded at compile time.
pub const EMBEDDED_RULES_JSON: &str = include_str!("../../../rules/rules.json");

/// Cleaning mode.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Apply `clean` rules only (default).
    #[default]
    Clean,
    /// Apply `clean` and `strict` rules and clean param-shaped fragments.
    Strict,
    /// Never modify anything.
    Bypass,
}

/// Outcome of a cleaning call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// At least one parameter was removed.
    Cleaned,
    /// Nothing to remove; `url` is the original input.
    Unchanged,
    /// A protection signal matched; see `reason`.
    Protected,
    /// Mode was `bypass`.
    Bypassed,
    /// The host matched a user exception.
    Excepted,
    /// Not an `http`/`https` URL.
    Unsupported,
    /// Not a parseable URL (or contained TAB/LF/CR).
    Invalid,
}

/// Where a removed parameter was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Location {
    /// The query string.
    Query,
    /// A param-shaped fragment (strict mode only).
    Fragment,
}

/// A removed parameter. Values are never reported.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedParam {
    /// Raw (still percent-encoded) key exactly as it appeared in the input.
    pub name: String,
    /// Where it was found.
    pub location: Location,
    /// Id of the first applicable rule (file order) that matched.
    pub rule_id: String,
}

/// Result of [`Engine::clean`] / [`clean`].
///
/// Serialises to the same JSON shape as the TypeScript engine
/// (`{url, changed, status, removed: [{name, location, ruleId}], reason?}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanResult {
    /// Resulting URL (the untouched, untrimmed input unless `status == Cleaned`).
    pub url: String,
    /// `url != input`.
    pub changed: bool,
    /// Outcome.
    pub status: Status,
    /// Removed parameters, in order of appearance (query first).
    pub removed: Vec<RemovedParam>,
    /// Machine-readable reason for `Protected`, e.g. `path:login`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Options for a cleaning call.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanOptions {
    /// Cleaning mode.
    pub mode: Mode,
    /// User exception domains (normalised per spec before matching).
    pub exceptions: Vec<String>,
}

impl CleanOptions {
    /// Options with the given mode and no exceptions.
    pub fn new(mode: Mode) -> Self {
        CleanOptions {
            mode,
            exceptions: Vec::new(),
        }
    }

    /// Replaces the exception list.
    pub fn with_exceptions<I, S>(mut self, exceptions: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.exceptions = exceptions.into_iter().map(Into::into).collect();
        self
    }
}

/// Returns the shared engine built from the embedded rules (parsed once).
pub fn default_engine() -> &'static Engine {
    static ENGINE: OnceLock<Engine> = OnceLock::new();
    ENGINE.get_or_init(|| {
        // The embedded rule file is a compile-time constant validated by the test
        // suite; failure here is a packaging bug, not a user-input error.
        Engine::from_json(EMBEDDED_RULES_JSON).expect("embedded rules/rules.json must be valid")
    })
}

/// Cleans `input` with the embedded rules. See [`Engine::clean`].
pub fn clean(input: &str, opts: &CleanOptions) -> CleanResult {
    default_engine().clean(input, opts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_rules_parse() {
        assert!(Engine::from_json(EMBEDDED_RULES_JSON).is_ok());
    }

    #[test]
    fn bad_rule_json_is_an_error() {
        assert!(matches!(Engine::from_json(""), Err(RuleSetError::Json(_))));
        assert!(matches!(Engine::from_json("{"), Err(RuleSetError::Json(_))));
        assert!(matches!(
            Engine::from_json(r#"{"schemaVersion":1,"rules":[{"id":"x","mode":"weird"}]}"#),
            Err(RuleSetError::Json(_))
        ));
        assert!(matches!(
            Engine::from_json(r#"{"schemaVersion":2,"rules":[]}"#),
            Err(RuleSetError::UnsupportedSchemaVersion(2))
        ));
    }

    #[test]
    fn rule_set_validation_rejects_bad_entries() {
        let with_rule =
            |rule: &str| Engine::from_json(&format!(r#"{{"schemaVersion":1,"rules":[{rule}]}}"#));
        // Adds the required (empty) `pathSubstrings` unless the test sets it.
        let with_protection = |prot: &str| {
            let prot = if prot.contains("pathSubstrings") {
                prot.to_owned()
            } else {
                prot.replacen('{', r#"{"pathSubstrings":[],"#, 1)
            };
            Engine::from_json(&format!(
                r#"{{"schemaVersion":1,"rules":[],"protection":{prot}}}"#
            ))
        };
        let invalid =
            |r: Result<Engine, RuleSetError>, want_field: &str, want_problem: &str| match r {
                Err(RuleSetError::InvalidEntry { field, problem, .. }) => {
                    assert_eq!(field, want_field);
                    assert_eq!(problem, want_problem);
                }
                other => panic!("expected InvalidEntry, got {other:?}"),
            };
        invalid(
            with_rule(r#"{"id":"a","mode":"clean","params":["ok",""]}"#),
            "rules[a].params",
            "empty string",
        );
        invalid(
            with_rule(r#"{"id":"a","mode":"clean","prefixes":["Utm_"]}"#),
            "rules[a].prefixes",
            "not lower-case",
        );
        invalid(
            with_rule(r#"{"id":"a","mode":"clean","domains":["Example.com"],"params":["x"]}"#),
            "rules[a].domains",
            "not lower-case",
        );
        invalid(
            with_protection(r#"{"paramCombinations":[["code","state"],[]]}"#),
            "protection.paramCombinations[1]",
            "empty combination",
        );
        invalid(
            with_protection(r#"{"paramCombinations":[["code",""]]}"#),
            "protection.paramCombinations[0]",
            "empty string",
        );
        invalid(
            with_protection(r#"{"pathKeywords":["Login"]}"#),
            "protection.pathKeywords",
            "not lower-case",
        );
        invalid(
            with_protection(r#"{"domains":[""]}"#),
            "protection.domains",
            "empty string",
        );
        invalid(
            with_protection(r#"{"params":["SIG"]}"#),
            "protection.params",
            "not lower-case",
        );
        invalid(
            with_protection(r#"{"paramPrefixes":[""]}"#),
            "protection.paramPrefixes",
            "empty string",
        );
        invalid(
            with_protection(r#"{"paramSuffixes":["Token"]}"#),
            "protection.paramSuffixes",
            "not lower-case",
        );
        invalid(
            with_protection(r#"{"pathSubstrings":["resetPw"]}"#),
            "protection.pathSubstrings",
            "not lower-case",
        );
        invalid(
            with_protection(r#"{"pathSubstrings":[""]}"#),
            "protection.pathSubstrings",
            "empty string",
        );
        // `pathSubstrings` is a required field.
        assert!(matches!(
            Engine::from_json(r#"{"schemaVersion":1,"rules":[],"protection":{"params":[]}}"#),
            Err(RuleSetError::Json(_))
        ));
        // Empty `domains` array (absent is fine).
        invalid(
            with_rule(r#"{"id":"a","mode":"clean","domains":[],"params":["x"]}"#),
            "rules[a].domains",
            "empty domains array",
        );
        // Empty and duplicate rule ids.
        invalid(
            with_rule(r#"{"id":"","mode":"clean","params":["x"]}"#),
            "rules[].id",
            "empty rule id",
        );
        invalid(
            with_rule(
                r#"{"id":"a","mode":"clean","params":["x"]},{"id":"a","mode":"strict","params":["y"]}"#,
            ),
            "rules[].id",
            "duplicate rule id",
        );
        // "Lower-case" means no ASCII A-Z; non-ASCII (even upper-case) is allowed.
        assert!(with_rule(r#"{"id":"a","mode":"clean","params":["__cft__[0]","ß","Ä"]}"#).is_ok());
        assert!(
            with_rule(r#"{"id":"A","mode":"clean","domains":["x.com"],"params":["x"]}"#).is_ok()
        );
        assert!(with_protection(r#"{"pathSubstrings":["abmelden","é"]}"#).is_ok());
        assert!(RuleSet::from_json(EMBEDDED_RULES_JSON).is_ok());
    }

    #[test]
    fn path_substrings_after_keywords() {
        let engine = Engine::from_json(
            r#"{"schemaVersion":1,"rules":[{"id":"u","mode":"clean","prefixes":["utm_"]}],
               "protection":{"pathKeywords":["login"],"pathSubstrings":["verif","login","pass"]}}"#,
        )
        .expect("valid");
        let reason = |u: &str| engine.clean(u, &CleanOptions::default()).reason;
        // Keyword wins over substring when both match.
        assert_eq!(
            reason("https://e.com/login?utm_a=1").as_deref(),
            Some("path:login")
        );
        // Substring: first entry in file order wins.
        assert_eq!(
            reason("https://e.com/PassVerify?utm_a=1").as_deref(),
            Some("path:verif")
        );
        // Decoded + lower-cased path.
        assert_eq!(
            reason("https://e.com/my%4Cogin?utm_a=1").as_deref(),
            Some("path:login")
        );
        assert_eq!(reason("https://e.com/other?utm_a=1"), None);
    }

    #[test]
    fn trailing_whitespace_guard() {
        let r = clean(
            "https://example.com/download%20 ?utm_source=x",
            &CleanOptions::default(),
        );
        assert_eq!(r.url, "https://example.com/download%20%20");
        let r = clean(
            "https://example.com/?b=1 \u{1}&utm_source=x",
            &CleanOptions::default(),
        );
        assert_eq!(r.url, "https://example.com/?b=1%20%01");
        // Unchanged results are returned verbatim, untrimmed.
        let r = clean("https://example.com/?b=1 ", &CleanOptions::default());
        assert_eq!(r.url, "https://example.com/?b=1 ");
        assert_eq!(r.status, Status::Unchanged);
    }

    #[test]
    fn custom_rules() {
        let engine = Engine::from_json(
            r#"{"schemaVersion":1,"rules":[{"id":"x","mode":"clean","params":["foo"]}]}"#,
        )
        .expect("valid");
        let r = engine.clean("https://e.com/?foo=1&bar=2", &CleanOptions::default());
        assert_eq!(r.url, "https://e.com/?bar=2");
        assert_eq!(r.removed[0].rule_id, "x");
    }

    #[test]
    fn json_shape_matches_ts_engine() {
        let r = clean(
            "https://example.com/?utm_source=x&a=1",
            &CleanOptions::default(),
        );
        let v = serde_json::to_value(&r).expect("serialise");
        assert_eq!(
            v,
            serde_json::json!({
                "url": "https://example.com/?a=1",
                "changed": true,
                "status": "cleaned",
                "removed": [{"name": "utm_source", "location": "query", "ruleId": "utm"}]
            })
        );
        let p = clean("https://example.com/login?a=1", &CleanOptions::default());
        let v = serde_json::to_value(&p).expect("serialise");
        assert_eq!(v["status"], "protected");
        assert_eq!(v["reason"], "path:login");
        assert_eq!(v["changed"], false);
    }

    #[test]
    fn strict_fragment_location_and_rule_ids() {
        let r = clean(
            "https://www.amazon.de/dp/X?ref=a&tag=b#utm_source=1&k=2",
            &CleanOptions::new(Mode::Strict),
        );
        assert_eq!(r.url, "https://www.amazon.de/dp/X#k=2");
        let got: Vec<_> = r
            .removed
            .iter()
            .map(|p| (p.name.as_str(), p.location, p.rule_id.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("ref", Location::Query, "strict-generic"),
                ("tag", Location::Query, "strict-amazon"),
                ("utm_source", Location::Fragment, "utm"),
            ]
        );
    }
}
