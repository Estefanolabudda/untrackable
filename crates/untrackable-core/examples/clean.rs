//! Tiny CLI around the engine.
//!
//! ```text
//! cargo run -p untrackable-core --example clean -- [--strict] [--json] [URL ...]
//! echo 'https://example.com/?utm_source=x' | cargo run -p untrackable-core --example clean
//! ```
//!
//! With URL arguments each one is cleaned; otherwise every stdin line is.
//! Prints one cleaned URL per line (or one JSON result per line with `--json`).
//!
//! `--jsonl` reads one JSON request per stdin line,
//! `{"input": "...", "mode": "clean|strict|bypass", "exceptions": [...]}`,
//! and prints one JSON result per line. Used by `scripts/differential.mjs`
//! to compare this engine with the TypeScript engine.

use std::io::{self, BufRead, Write};
use std::process::ExitCode;

use serde::Deserialize;
use untrackable_core::{default_engine, CleanOptions, Mode};

#[derive(Deserialize)]
struct Request {
    input: String,
    #[serde(default)]
    mode: Mode,
    #[serde(default)]
    exceptions: Vec<String>,
}

fn run_jsonl() -> ExitCode {
    let engine = default_engine();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else {
            return ExitCode::FAILURE;
        };
        let request: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("error: bad request line: {e}");
                return ExitCode::FAILURE;
            }
        };
        let opts = CleanOptions {
            mode: request.mode,
            exceptions: request.exceptions,
        };
        let result = engine.clean(&request.input, &opts);
        let Ok(text) = serde_json::to_string(&result) else {
            return ExitCode::FAILURE;
        };
        if writeln!(out, "{text}").is_err() {
            return ExitCode::FAILURE;
        }
    }
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let mut opts = CleanOptions::default();
    let mut json = false;
    let mut urls = Vec::new();
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--strict" => opts.mode = Mode::Strict,
            "--json" => json = true,
            "--jsonl" => return run_jsonl(),
            "-h" | "--help" => {
                println!(
                    "usage: clean [--strict] [--json] [URL ...]  (reads stdin lines if no URL)"
                );
                return ExitCode::SUCCESS;
            }
            _ => urls.push(arg),
        }
    }

    let engine = default_engine();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut emit = |line: &str| -> io::Result<()> {
        let result = engine.clean(line, &opts);
        if json {
            let text = serde_json::to_string(&result).map_err(io::Error::other)?;
            writeln!(out, "{text}")
        } else {
            writeln!(out, "{}", result.url)
        }
    };

    let outcome = if urls.is_empty() {
        io::stdin().lock().lines().try_for_each(|line| emit(&line?))
    } else {
        urls.iter().try_for_each(|u| emit(u))
    };

    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) if e.kind() == io::ErrorKind::BrokenPipe => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
