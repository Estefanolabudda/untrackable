//! Shared conformance fixtures (`tests/fixtures/cases.json`), identical for the
//! TypeScript and Rust engines.

use std::path::PathBuf;

use serde::Deserialize;
use untrackable_core::{clean, CleanOptions, Mode, Status};

#[derive(Debug, Deserialize)]
struct FixtureFile {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    name: String,
    input: String,
    #[serde(default)]
    mode: Mode,
    #[serde(default)]
    exceptions: Vec<String>,
    expected: String,
    status: Status,
    removed: Option<Vec<String>>,
    reason: Option<String>,
}

fn load_cases() -> Vec<Case> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/cases.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    let file: FixtureFile = serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("cannot parse {}: {e}", path.display()));
    file.cases
}

#[test]
fn all_shared_fixtures_pass() {
    let cases = load_cases();
    assert!(!cases.is_empty(), "fixture file contains no cases");

    let mut failures = Vec::new();
    for case in &cases {
        let opts = CleanOptions {
            mode: case.mode,
            exceptions: case.exceptions.clone(),
        };
        let result = clean(&case.input, &opts);
        let mut problems = Vec::new();

        if result.url != case.expected {
            problems.push(format!(
                "url: expected {:?}, got {:?}",
                case.expected, result.url
            ));
        }
        if result.status != case.status {
            problems.push(format!(
                "status: expected {:?}, got {:?}",
                case.status, result.status
            ));
        }
        if result.changed != (result.url != case.input) {
            problems.push(format!(
                "changed flag {} inconsistent with url",
                result.changed
            ));
        }
        if let Some(expected_removed) = &case.removed {
            let got: Vec<&str> = result.removed.iter().map(|r| r.name.as_str()).collect();
            if got != *expected_removed {
                problems.push(format!(
                    "removed: expected {expected_removed:?}, got {got:?}"
                ));
            }
        }
        if let Some(expected_reason) = &case.reason {
            if result.reason.as_deref() != Some(expected_reason.as_str()) {
                problems.push(format!(
                    "reason: expected {expected_reason:?}, got {:?}",
                    result.reason
                ));
            }
        }
        if !problems.is_empty() {
            failures.push(format!("[{}]\n    {}", case.name, problems.join("\n    ")));
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {} fixture cases failed:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
    println!("{} fixture cases passed", cases.len());
}
