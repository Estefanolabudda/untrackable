//! Regression corpus of sensitive URL shapes (`tests/corpus/sensitive-urls.json`).
//! The Rust engine must leave every entry marked `preserved` unchanged. (The
//! `changed` expectations also involve the browser's navigation rules and are
//! checked by the TypeScript corpus test; the differential test keeps both
//! engines identical on every corpus URL.)

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Deserialize;
use untrackable_core::{clean, CleanOptions, Mode};

#[derive(Deserialize)]
struct CorpusFile {
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    category: String,
    url: String,
    expect: BTreeMap<String, String>,
}

#[test]
fn preserved_corpus_entries_stay_unchanged() {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/corpus/sensitive-urls.json");
    let text = std::fs::read_to_string(&path).expect("read corpus");
    let corpus: CorpusFile = serde_json::from_str(&text).expect("parse corpus");
    assert!(corpus.entries.len() > 200);
    let mut failures = Vec::new();
    for entry in &corpus.entries {
        for (mode_name, mode) in [
            ("clean", Mode::Clean),
            ("strict", Mode::Strict),
            ("experimental", Mode::Experimental),
        ] {
            if entry.expect.get(mode_name).map(String::as_str) != Some("preserved") {
                continue;
            }
            let result = clean(&entry.url, &CleanOptions::new(mode));
            if result.url != entry.url {
                failures.push(format!(
                    "{mode_name}: [{}] {} -> {}",
                    entry.category, entry.url, result.url
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} corpus entries changed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
