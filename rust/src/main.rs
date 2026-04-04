//! CLI entrypoint for pi-lens-core

use std::io::{self, Read};

use pi_lens_core::{AnalyzeRequest, analyze};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;

    let request: AnalyzeRequest = match serde_json::from_str(&input) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Failed to parse request: {}", e);
            std::process::exit(1);
        }
    };

    let response = analyze(&request);
    let json = serde_json::to_string_pretty(&response)?;

    println!("{}", json);
    Ok(())
}
