#!/usr/bin/env node
/**
 * Layer A: pinned-contract verification (#476).
 *
 * pi-lens's subagent-compatibility features (#473/#474/#475) were built on
 * reverse-engineered facts about two third-party pi extensions and the pi
 * SDK itself — nobody has promised us these stay true across their releases.
 * This script npm-installs the real packages into a scratch directory and
 * mechanically re-verifies each pinned contract with RESILIENT pattern
 * checks (scripts/lib/compat-contracts.mjs) against the installed code —
 * never a line number, a semantic shape — so a wording/formatting change
 * that preserves the behavior we depend on still passes.
 *
 * Requires NO LLM API key and spawns no `pi` process — CI has no model
 * credentials, so this is the layer that runs even when Layer B
 * (compat-smoke-behavioral.mjs) can't.
 *
 * Exit code: non-zero iff any contract check FAILs OR the installs
 * themselves fail (network/registry issues) — the workflow step wraps this
 * in `continue-on-error: true` so a failure ALERTS rather than reds the
 * nightly; see docs/subagent-compat.md.
 *
 * Usage: node scripts/compat-contracts.mjs [--keep] [--dir <path>]
 *   --keep       don't delete the scratch install directory on exit
 *   --dir <path> use this directory instead of a fresh temp dir (skips
 *                install if package.json already exists there — useful for
 *                iterating locally without re-installing every run)
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAllContractChecks } from "./lib/compat-contracts.mjs";

const PACKAGES = {
  sdk: "@earendil-works/pi-coding-agent",
  nicobailon: "pi-subagents",
  tintinweb: "@tintinweb/pi-subagents",
};

function parseArgs(argv) {
  const opts = { keep: false, dir: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--keep") opts.keep = true;
    else if (argv[i] === "--dir") opts.dir = argv[++i];
  }
  return opts;
}

function installPackages(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const pkgJsonPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(
      pkgJsonPath,
      JSON.stringify({ name: "pi-lens-compat-contracts-scratch", private: true }, null, 2),
    );
  }
  const specs = Object.values(PACKAGES);
  console.log(`installing ${specs.join(", ")} into ${dir} ...`);
  // Windows `npm` is a `.cmd` shim that only runs under shell mode (same
  // reasoning as safeSpawnAsync — see AGENTS.md "Runner process model").
  const isWindows = process.platform === "win32";
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--no-save", ...specs], {
    cwd: dir,
    stdio: "inherit",
    shell: isWindows,
  });
}

function installedVersion(dir, pkgName) {
  try {
    const pkgJsonPath = path.join(dir, "node_modules", pkgName, "package.json");
    return JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")).version;
  } catch {
    return "(unknown)";
  }
}

function readSource(dir, ...segments) {
  return fs.readFileSync(path.join(dir, "node_modules", ...segments), "utf8");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-compat-contracts-"));

  let infraFailure = null;
  try {
    installPackages(dir);
  } catch (err) {
    // Our own install failing (network/registry down) is an infra error, not
    // a contract drift — the workflow should tell these apart in its summary.
    infraFailure = err instanceof Error ? err.message : String(err);
  }

  const versions = {
    "@earendil-works/pi-coding-agent": installedVersion(dir, "@earendil-works/pi-coding-agent"),
    "pi-subagents": installedVersion(dir, "pi-subagents"),
    "@tintinweb/pi-subagents": installedVersion(dir, "@tintinweb/pi-subagents"),
  };
  console.log("\nversions installed:");
  for (const [name, version] of Object.entries(versions)) {
    console.log(`  ${name}@${version}`);
  }

  if (infraFailure) {
    console.error(`\nINFRA FAILURE — could not install packages: ${infraFailure}`);
    if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
    process.exit(2);
  }

  let inputs;
  try {
    inputs = {
      nicobailonPiArgsSource: readSource(dir, "pi-subagents", "src/runs/shared/pi-args.ts"),
      sdkLoaderSource: readSource(
        dir,
        "@earendil-works/pi-coding-agent",
        "dist/core/extensions/loader.js",
      ),
      sdkAgentSessionSource: readSource(
        dir,
        "@earendil-works/pi-coding-agent",
        "dist/core/agent-session.js",
      ),
      tintinwebAgentRunnerSource: readSource(
        dir,
        "@tintinweb/pi-subagents",
        "src/agent-runner.ts",
      ),
    };
  } catch (err) {
    // A source file moved/renamed entirely — itself a drift signal worth
    // surfacing distinctly from an individual contract regex not matching.
    console.error(
      `\nINFRA FAILURE — expected source file not found (package layout changed?): ${err instanceof Error ? err.message : err}`,
    );
    if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
    process.exit(2);
  }

  const { results, allPass } = runAllContractChecks(inputs);

  console.log("\ncontract checks:");
  for (const r of results) {
    console.log(`  [${r.pass ? "PASS" : "FAIL"}] ${r.id} (${r.package}) — ${r.description}`);
    console.log(`         ${r.detail}`);
  }

  if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${allPass ? "ALL CONTRACT CHECKS PASSED" : "ONE OR MORE CONTRACT CHECKS FAILED"}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("compat-contracts.mjs crashed:", err);
  process.exit(2);
});
