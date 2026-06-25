#!/usr/bin/env node
// Retroactively set every GitHub release body to its curated CHANGELOG section.
//
// The release history was created with `gh release create --generate-notes`, so
// each body is a thin auto-generated PR-title list (and misses everything that
// landed as a direct commit). The curated prose already lives in CHANGELOG.md;
// this pushes it into the release bodies so the whole history reads meaningfully.
//
//   node scripts/backfill-github-releases.mjs            # DRY RUN (default): show plan
//   node scripts/backfill-github-releases.mjs --apply    # actually edit releases
//   node scripts/backfill-github-releases.mjs --apply --only v3.8.60,v3.8.53
//   node scripts/backfill-github-releases.mjs --apply --full   # full prose, not summary
//   node scripts/backfill-github-releases.mjs --repo owner/name --apply
//
// By default the release body is the scannable summary (bold titles, grouped) —
// the same form `release.yml` posts for new releases; `--full` writes the whole
// CHANGELOG section instead. Requires the `gh` CLI authenticated. Releases
// without a CHANGELOG section are skipped (reported), never blanked.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractSection,
  summarizeSection,
  normalizeVersion,
} from "./lib/changelog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGELOG_PATH = join(__dirname, "..", "CHANGELOG.md");

function parseArgs(argv) {
  const args = { apply: false, full: false, repo: undefined, only: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--full") args.full = true;
    else if (a === "--repo") args.repo = argv[++i];
    else if (a === "--only")
      args.only = new Set(
        argv[++i].split(",").map((s) => normalizeVersion(s.trim())),
      );
  }
  return args;
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

function listReleases(repo) {
  const args = ["release", "list", "--limit", "200", "--json", "tagName"];
  if (repo) args.push("--repo", repo);
  return JSON.parse(gh(args)).map((r) => r.tagName);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const changelog = readFileSync(CHANGELOG_PATH, "utf8");

  let tags;
  try {
    tags = listReleases(args.repo);
  } catch (err) {
    console.error("Failed to list releases via `gh`. Is it installed/authed?");
    console.error(String(err.message || err));
    process.exit(1);
  }

  const tmp = mkdtempSync(join(tmpdir(), "pilens-relnotes-"));
  const plan = [];
  for (const tag of tags) {
    if (args.only && !args.only.has(normalizeVersion(tag))) continue;
    const full = extractSection(changelog, tag);
    if (full === null || full.trim().length === 0) {
      plan.push({ tag, action: "skip", reason: "no CHANGELOG section" });
      continue;
    }
    const body = args.full ? full : summarizeSection(full);
    plan.push({ tag, action: "update", body });
  }

  const updates = plan.filter((p) => p.action === "update");
  const skips = plan.filter((p) => p.action === "skip");

  console.log(
    `${args.apply ? "APPLYING" : "DRY RUN"} — ${updates.length} release(s) to update, ${skips.length} skipped.\n`,
  );
  for (const p of skips) console.log(`  skip   ${p.tag}  (${p.reason})`);
  for (const p of updates) {
    const firstLine = p.body.split("\n").find((l) => l.trim()) ?? "";
    console.log(`  update ${p.tag}  ${firstLine.slice(0, 70)}`);
  }

  if (!args.apply) {
    console.log("\nRe-run with --apply to write these release bodies.");
    return;
  }

  let ok = 0;
  for (const p of updates) {
    const notesFile = join(tmp, `${normalizeVersion(p.tag)}.md`);
    writeFileSync(notesFile, p.body + "\n", "utf8");
    const editArgs = ["release", "edit", p.tag, "--notes-file", notesFile];
    if (args.repo) editArgs.push("--repo", args.repo);
    try {
      gh(editArgs);
      ok++;
      console.log(`  ok     ${p.tag}`);
    } catch (err) {
      console.error(`  FAIL   ${p.tag}: ${String(err.message || err)}`);
    }
  }
  console.log(`\nUpdated ${ok}/${updates.length} release bodies.`);
}

main();
