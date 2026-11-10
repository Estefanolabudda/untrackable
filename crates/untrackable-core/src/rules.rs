//! Rule file (`rules/rules.json`) data model and loading.

use std::fmt;

use serde::Deserialize;

/// Rule file schema version understood by this implementation.
pub const SUPPORTED_SCHEMA_VERSION: u64 = 1;

/// Whether a rule applies in `clean` (and `strict`) mode, or in `strict` mode only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleMode {
    /// Applies in clean and strict mode.
    Clean,
    /// Applies in strict mode only.
    Strict,
}

/// A single parameter-removal rule.
///
/// Unknown keys are rejected. `domains`, `params` and `prefixes` may be omitted,
/// but `null` is rejected (it is not treated as absent).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    /// Stable identifier reported as `ruleId` (non-empty, unique).
    pub id: String,
    /// Human-readable description (required).
    pub description: String,
    /// Mode in which the rule applies.
    pub mode: RuleMode,
    /// Optional host restriction; `None` means "all hosts". Must be non-empty when present.
    #[serde(default, deserialize_with = "present_vec")]
    pub domains: Option<Vec<String>>,
    /// Exact (normalised) keys removed by this rule.
    #[serde(default)]
    pub params: Vec<String>,
    /// Key prefixes removed by this rule.
    #[serde(default)]
    pub prefixes: Vec<String>,
}

/// Deserialises a present field as `Some(vec)`; a JSON `null` is an error
/// (an absent field falls back to `None` via `#[serde(default)]`).
fn present_vec<'de, D>(deserializer: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Vec::<String>::deserialize(deserializer).map(Some)
}

/// Protection signals: URLs matching any of these are never modified.
///
/// The whole `protection` object may be omitted from the rule file (meaning
/// "no protection", see [`Protection::default`]). When it is present, all
/// seven lists are required and `description` is optional; unknown keys are
/// rejected.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Protection {
    /// Human-readable description (optional).
    #[serde(default)]
    pub description: String,
    /// Protected hosts (domain-matched).
    pub domains: Vec<String>,
    /// Path keywords (see the spec for the matching regex).
    pub path_keywords: Vec<String>,
    /// Plain substrings of the decoded, lower-cased path.
    pub path_substrings: Vec<String>,
    /// Exact protected keys.
    pub params: Vec<String>,
    /// Protected key prefixes.
    pub param_prefixes: Vec<String>,
    /// Protected key suffixes.
    pub param_suffixes: Vec<String>,
    /// Key combinations that are protected when all keys are present.
    pub param_combinations: Vec<Vec<String>>,
}

/// The complete rule set. Top-level keys are exactly `schemaVersion`, `rules`
/// and the optional `protection`; unknown keys are rejected.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleSet {
    /// Schema version; must be the integer [`SUPPORTED_SCHEMA_VERSION`].
    pub schema_version: u64,
    /// Removal rules in file order (order is significant for `ruleId`).
    pub rules: Vec<Rule>,
    /// Protection signals. Omitting the whole object means "no protection";
    /// when present, every list is required (`null` is rejected).
    #[serde(default)]
    pub protection: Protection,
}

impl RuleSet {
    /// Parses and validates a rule set from JSON text.
    pub fn from_json(json: &str) -> Result<Self, RuleSetError> {
        let set: RuleSet = serde_json::from_str(json).map_err(RuleSetError::Json)?;
        if set.schema_version != SUPPORTED_SCHEMA_VERSION {
            return Err(RuleSetError::UnsupportedSchemaVersion(set.schema_version));
        }
        set.validate()?;
        Ok(set)
    }

    /// Validates the rule set: no empty strings and no ASCII upper-case `A-Z`
    /// in any list (non-ASCII is allowed), no empty `paramCombinations` entry,
    /// no empty `domains` array (omit the key instead), no empty or duplicate rule ids.
    pub fn validate(&self) -> Result<(), RuleSetError> {
        fn check(field: String, values: &[String]) -> Result<(), RuleSetError> {
            for v in values {
                let problem = if v.is_empty() {
                    "empty string"
                } else if v.bytes().any(|b| b.is_ascii_uppercase()) {
                    "not lower-case"
                } else {
                    continue;
                };
                return Err(RuleSetError::InvalidEntry {
                    field,
                    value: v.clone(),
                    problem,
                });
            }
            Ok(())
        }

        let mut seen_ids = std::collections::HashSet::new();
        for r in &self.rules {
            if r.id.is_empty() {
                return Err(RuleSetError::InvalidEntry {
                    field: "rules[].id".into(),
                    value: String::new(),
                    problem: "empty rule id",
                });
            }
            if !seen_ids.insert(r.id.as_str()) {
                return Err(RuleSetError::InvalidEntry {
                    field: "rules[].id".into(),
                    value: r.id.clone(),
                    problem: "duplicate rule id",
                });
            }
            if let Some(domains) = &r.domains {
                if domains.is_empty() {
                    return Err(RuleSetError::InvalidEntry {
                        field: format!("rules[{}].domains", r.id),
                        value: String::new(),
                        problem: "empty domains array",
                    });
                }
                check(format!("rules[{}].domains", r.id), domains)?;
            }
            check(format!("rules[{}].params", r.id), &r.params)?;
            check(format!("rules[{}].prefixes", r.id), &r.prefixes)?;
        }
        let p = &self.protection;
        check("protection.domains".into(), &p.domains)?;
        check("protection.pathKeywords".into(), &p.path_keywords)?;
        check("protection.pathSubstrings".into(), &p.path_substrings)?;
        check("protection.params".into(), &p.params)?;
        check("protection.paramPrefixes".into(), &p.param_prefixes)?;
        check("protection.paramSuffixes".into(), &p.param_suffixes)?;
        for (i, combo) in p.param_combinations.iter().enumerate() {
            if combo.is_empty() {
                return Err(RuleSetError::InvalidEntry {
                    field: format!("protection.paramCombinations[{i}]"),
                    value: String::new(),
                    problem: "empty combination",
                });
            }
            check(format!("protection.paramCombinations[{i}]"), combo)?;
        }
        Ok(())
    }
}

/// Error returned when a rule set cannot be loaded.
#[derive(Debug)]
pub enum RuleSetError {
    /// The JSON is malformed or does not match the schema.
    Json(serde_json::Error),
    /// `schemaVersion` is not supported by this engine.
    UnsupportedSchemaVersion(u64),
    /// A list entry is invalid (empty, not lower-case, or an empty combination).
    InvalidEntry {
        /// Where the entry is, e.g. `protection.params`.
        field: String,
        /// The offending value.
        value: String,
        /// What is wrong with it.
        problem: &'static str,
    },
    /// A path keyword could not be compiled into a regular expression.
    PathKeyword {
        /// The offending keyword.
        keyword: String,
        /// The underlying regex error.
        source: regex::Error,
    },
}

impl fmt::Display for RuleSetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RuleSetError::Json(e) => write!(f, "invalid rule set JSON: {e}"),
            RuleSetError::UnsupportedSchemaVersion(v) => {
                write!(
                    f,
                    "unsupported rule set schemaVersion {v} (expected {SUPPORTED_SCHEMA_VERSION})"
                )
            }
            RuleSetError::InvalidEntry {
                field,
                value,
                problem,
            } => write!(f, "invalid entry {value:?} in {field}: {problem}"),
            RuleSetError::PathKeyword { keyword, source } => {
                write!(f, "invalid path keyword {keyword:?}: {source}")
            }
        }
    }
}

impl std::error::Error for RuleSetError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            RuleSetError::Json(e) => Some(e),
            RuleSetError::UnsupportedSchemaVersion(_) | RuleSetError::InvalidEntry { .. } => None,
            RuleSetError::PathKeyword { source, .. } => Some(source),
        }
    }
}
