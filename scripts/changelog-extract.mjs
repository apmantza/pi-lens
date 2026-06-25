#!/usr/bin/env node
// Print the curated CHANGELOG.md section body for a version to stdout.
//
//   node scripts/changelog-extract.mjs 3.8.60          # to stdout
//   node scripts/changelog-extract.mjs v3.8.60 -o out   # to a file
//
// Used by .github/workflows/release.yml to feed `gh release create
// --notes-file`, so the GitHub release body IS the curated section (single
// source of truth). Exits non-zero with a clear message if the section is
// missing or empty, which fails the release before it tags anything.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractSection, summarizeSection } from "./lib/changelog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGELOG_PATH = join(__dirname, "..", "CHANGELOG.md");

function parseArgs(argv) {
  const args = { version: undefined, out: undefined, summary: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") args.out = argv[++i];
    else if (a === "--summary") args.summary = true;
    else if (!args.version) args.version = a;
  }
  return args;
}

function main() {
  const { version, out, summary } = parseArgs(process.argv.slice(2));
  if (!version) {
    console.error("usage: changelog-extract.mjs <version> [--summary] [-o <file>]");
    process.exit(2);
  }
  const text = readFileSync(CHANGELOG_PATH, "utf8");
  const full = extractSection(text, version);
  if (full === null || full.trim().length === 0) {
    console.error(`No CHANGELOG section for version "${version}".`);
    process.exit(1);
  }
  // The release body is a scannable summary (bold titles, grouped) — the full
  // prose stays in CHANGELOG.md. `--summary` is what release.yml passes.
  const body = summary ? summarizeSection(full) : full;
  if (out) writeFileSync(out, body + "\n", "utf8");
  else process.stdout.write(body + "\n");
}

main();
