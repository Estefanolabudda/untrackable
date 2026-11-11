//! Tiny CLI around the engine.
//!
//! ```text
//! cargo run -p untrackable-core --example clean -- [--strict|--experimental] [--json] [--rules FILE] [URL ...]
//! echo 'https://example.com/?utm_source=x' | cargo run -p untrackable-core --example clean
//! ```
//!
//! With URL arguments each one is cleaned; otherwise every stdin line is.
//! Prints one cleaned URL per line (or one JSON result per line with `--json`).
//!
//! `--jsonl` reads one JSON request per stdin line,
//! `{"input": "...", "mode": "clean|strict|experimental|bypass", "exceptions": [...]}`,
//! and prints one JSON result per line. Used by `scripts/differential.mjs`
//! to compare this engine with the TypeScript engine.
//!
//! `--rules FILE` uses a custom rule set (same schema as `rules/rules.json`)
//! instead of the embedded one; it works with every other mode. If the file
//! cannot be read or is invalid, `{"error":"..."}` is printed and the exit
//! code is 2. `--validate` only checks the rule set (the custom one with
//! `--rules`, otherwise the embedded one), prints `{"ok":true}` or
//! `{"ok":false}` and exits 0.

use std::io::{self, BufRead, Write};
use std::process::ExitCode;

use serde::Deserialize;
use untrackable_core::{default_engine, CleanOptions, Engine, Mode};

#[derive(Deserialize)]
struct Request {
    input: String,
    #[serde(default)]
    mode: Mode,
    #[serde(default)]
    exceptions: Vec<String>,
}

const USAGE: &str = "usage: clean [--strict|--experimental] [--json] [--rules FILE] [URL ...]  (reads stdin lines if no URL)\n       clean [--rules FILE] --jsonl\n       clean [--rules FILE] --validate";

fn run_jsonl(engine: &Engine) -> ExitCode {
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

fn load_rules(path: &str) -> Result<Engine, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    Engine::from_json(&text).map_err(|e| e.to_string())
}

fn main() -> ExitCode {
    let mut opts = CleanOptions::default();
    let mut json = false;
    let mut jsonl = false;
    let mut validate = false;
    let mut rules_path: Option<String> = None;
    let mut urls = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--strict" => opts.mode = Mode::Strict,
            "--experimental" => opts.mode = Mode::Experimental,
            "--json" => json = true,
            "--jsonl" => jsonl = true,
            "--validate" => validate = true,
            "--rules" => match args.next() {
                Some(path) => rules_path = Some(path),
                None => {
                    eprintln!("error: --rules needs a file argument\n{USAGE}");
                    return ExitCode::from(2);
                }
            },
            "-h" | "--help" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            _ => urls.push(arg),
        }
    }

    let custom = rules_path.as_deref().map(load_rules);

    if validate {
        let ok = !matches!(custom, Some(Err(_)));
        println!("{}", serde_json::json!({ "ok": ok }));
        return ExitCode::SUCCESS;
    }

    let engine: &Engine = match &custom {
        None => default_engine(),
        Some(Ok(engine)) => engine,
        Some(Err(message)) => {
            println!("{}", serde_json::json!({ "error": message }));
            return ExitCode::from(2);
        }
    };

    if jsonl {
        return run_jsonl(engine);
    }

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
