#!/usr/bin/env node
/**
 * Layer A: pinned-contract verification (#476).
 *
 * pi-lens's subagent-compatibility features (#473/#474/#475) were built on
 * reverse-engineered facts about three third-party pi extensions and the pi
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
 * Each contract is resolved and checked INDEPENDENTLY (#2581) by
 * `scripts/lib/compat-contract-resolution.mjs`'s `resolveAndCheckContracts`,
 * which locates every contract's source file(s) via an ordered
 * candidate-path list (scripts/lib/compat-contract-locator.mjs, walked
 * NEWEST-observed-layout first, #2680 F1 — a stale leftover file at an old
 * path must never outrank the package's current layout) and runs its check
 * function once resolved. A contract whose file can't be found at ANY known
 * candidate gets its own "infra" outcome (we haven't actually re-checked its
 * content) — this no longer blinds verification of every OTHER contract the
 * way a single top-level ENOENT used to (pi-subagents@0.65.0 relocated
 * `pi-args.ts`; the previous version of this script threw on that one
 * `readSource()` call and exited 2 without ever reading the other four
 * files, all of which were fine).
 *
 * The CONTRACTS registry (scripts/lib/compat-contracts.mjs) is the single
 * source of truth for both "which files back this contract" (`parts`) and
 * "which npm package" (`package` — the exact install spec, not a lookup
 * key): this script's install list is DERIVED from that registry rather
 * than a hand-maintained parallel table, so the two can never desync
 * (#2680 F2 — a prior version kept a second `CONTRACT_SOURCE_LOCATIONS`
 * table joined to CONTRACTS by a bare string id with no parity guard).
 *
 * Overall exit code / GITHUB_OUTPUT `outcome`:
 *   0 / "verified" — every contract located AND its content matched.
 *   1 / "drift"    — every contract was located, but at least one's content
 *                    did not match (real upstream behavioral drift).
 *   2 / "infra"    — our own package install failed, OR at least one
 *                    contract's source file could not be located at any
 *                    known candidate path (nothing to conclude about drift
 *                    for that contract — distinct from a located file with
 *                    unexpected content, see docs/subagent-compat.md).
 * "drift" takes priority over "infra" in the summary/exit code when both are
 * present in the same run — an actionable regression should never be masked
 * by an unrelated relocation elsewhere.
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
import { CONTRACTS } from "./lib/compat-contracts.mjs";
import { resolveAndCheckContracts } from "./lib/compat-contract-resolution.mjs";

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
			JSON.stringify(
				{ name: "pi-lens-compat-contracts-scratch", private: true },
				null,
				2,
			),
		);
	}
	// Derived from CONTRACTS, not a hand-maintained parallel list (#2680 F2) —
	// three of the seven contracts share the SDK package, so dedupe.
	const specs = [...new Set(CONTRACTS.map((c) => c.package))];
	console.log(`installing ${specs.join(", ")} into ${dir} ...`);
	// Windows `npm` is a `.cmd` shim that only runs under shell mode (same
	// reasoning as safeSpawnAsync — see AGENTS.md "Runner process model").
	const isWindows = process.platform === "win32";
	execFileSync(
		"npm",
		["install", "--no-audit", "--no-fund", "--no-save", ...specs],
		{
			cwd: dir,
			stdio: "inherit",
			shell: isWindows,
		},
	);
}

function installedVersion(dir, pkgName) {
	try {
		const pkgJsonPath = path.join(dir, "node_modules", pkgName, "package.json");
		return JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")).version;
	} catch {
		return "(unknown)";
	}
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const dir =
		opts.dir ??
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-compat-contracts-"));

	let infraFailure = null;
	try {
		installPackages(dir);
	} catch (err) {
		// Our own install failing (network/registry down) is an infra error, not
		// a contract drift — the workflow should tell these apart in its summary.
		infraFailure = err instanceof Error ? err.message : String(err);
	}

	const packageNames = [...new Set(CONTRACTS.map((c) => c.package))];
	const versions = Object.fromEntries(
		packageNames.map((name) => [name, installedVersion(dir, name)]),
	);
	console.log("\nversions installed:");
	for (const [name, version] of Object.entries(versions)) {
		console.log(`  ${name}@${version}`);
	}
	// Surface the ACTUALLY-INSTALLED versions to the workflow (GITHUB_OUTPUT)
	// so the drift-alert issue states ground truth — the doc's "verified
	// against" versions go stale as nightlies silently pass on newer releases.
	if (process.env.GITHUB_OUTPUT) {
		const line = Object.entries(versions)
			.map(([name, version]) => `${name}@${version}`)
			.join(" ");
		try {
			fs.appendFileSync(process.env.GITHUB_OUTPUT, `versions=${line}\n`);
		} catch {
			// output plumbing is best-effort; stdout above already has the versions
		}
	}

	function writeOutcomeOutput(outcome) {
		if (!process.env.GITHUB_OUTPUT) return;
		try {
			fs.appendFileSync(process.env.GITHUB_OUTPUT, `outcome=${outcome}\n`);
		} catch {
			// best-effort; stdout still has the outcome
		}
	}

	if (infraFailure) {
		console.error(
			`\nINFRA FAILURE — could not install packages: ${infraFailure}`,
		);
		writeOutcomeOutput("infra");
		if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
		process.exit(2);
	}

	const results = resolveAndCheckContracts(dir);

	console.log("\ncontract checks:");
	for (const r of results) {
		const label = r.outcome === "infra" ? "INFRA" : r.pass ? "PASS" : "FAIL";
		console.log(`  [${label}] ${r.id} (${r.package}) — ${r.description}`);
		console.log(`         ${r.detail}`);
	}

	if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });

	const anyDrift = results.some((r) => r.outcome === "drift");
	const allVerified = results.every((r) => r.outcome === "verified");
	const outcome = allVerified ? "verified" : anyDrift ? "drift" : "infra";
	writeOutcomeOutput(outcome);

	const summary = allVerified
		? "ALL CONTRACT CHECKS VERIFIED"
		: anyDrift
			? "ONE OR MORE CONTRACT CHECKS FAILED (drift)"
			: "ONE OR MORE CONTRACTS COULD NOT BE LOCATED (infra)";
	console.log(`\n${summary}`);
	process.exit(allVerified ? 0 : anyDrift ? 1 : 2);
}

main().catch((err) => {
	console.error("compat-contracts.mjs crashed:", err);
	process.exit(2);
});
