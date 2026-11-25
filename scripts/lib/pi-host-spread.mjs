/**
 * Pure core of the certified-host tier spread (#4632 acceptance 9): WHICH
 * hosts to probe, WHERE each one is installed, what one per-host line says,
 * and what the run's exit code is.
 *
 * This module spawns nothing. `scripts/probe-pi-host-tiers.mjs` supplies the
 * one child process (a Vitest run of the tier contract suites against one
 * host), exactly as `scripts/release-qa.mjs` keeps its pure core out of the
 * spawning path so `tests/scripts/release-qa.test.ts` can hold it.
 *
 * THE CERTIFIED LIST HAS ONE OWNER: the `### Verified hosts` table in
 * `docs/release-qa-baseline.md`. `tests/packaging.test.ts` ties that table to
 * the floor `PI_HOST_FLOOR_VERSION`, so the table is already the set a host
 * claim may name. The parser lives here and both readers import it, because a second
 * copy of "which rows count as verified" is how the spread and the packaging
 * ratchet would drift apart.
 *
 * TWO FAIL-CLOSED RULES, both learned from enumerated detectors (AGENTS.md
 * shape 69):
 *
 * 1. A row the reader cannot parse is a host the spread would silently skip,
 *    so it is returned as `unparseable` and the caller refuses the run rather
 *    than probing the hosts it happened to understand.
 * 2. An argument the parser does not recognize refuses the run. A probe that
 *    ignores a flag it was never taught prints a partial spread in the shape of
 *    a full one, which is the failure a hand-typed flag makes once.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The one host package the tiers load. */
export const HOST_PACKAGE = "@earendil-works/pi-coding-agent";

/** The baseline doc's section whose table is the certified set. */
const CERTIFIED_SECTION = "### Verified hosts";

/** A table row that names a three-part host version in its first column. */
const VERSION_ROW = /^\|\s*(\d+\.\d+\.\d+)\s*\|/;

/** The markdown separator row under a table's header (`| --- | --- |`). */
const SEPARATOR_ROW = /^\|\s*[-:]+\s*\|/;

/**
 * The certified host suites: tier 1 loads the built extension into pi's real
 * `ExtensionRunner` and reports what pi registered; tier 2 runs a real
 * `AgentSession` with a scripted provider. Both files are the tiers' own
 * contract suites (`tests/support/pi-runner.test.ts`,
 * `tests/support/pi-session.test.ts`), so a host claim names the same checks
 * the per-PR tiers run — never a second, coarser copy of them.
 */
export const TIER_SUITES = [
	{ tier: "tier1", file: "tests/support/pi-runner.test.ts" },
	{ tier: "tier2", file: "tests/support/pi-session.test.ts" },
];

/** Numeric three-part version order; no pre-release host is certified. */
export function compareVersions(a, b) {
	const left = a.split(".").map((part) => Number.parseInt(part, 10));
	const right = b.split(".").map((part) => Number.parseInt(part, 10));
	for (let index = 0; index < 3; index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/**
 * Rows of the baseline doc's `### Verified hosts` table, in table order, with
 * the first column's version or `null` when the row does not spell one.
 * Returning an unparsed row instead of dropping it is what lets each caller
 * refuse it (#4688 R2 F2: a row spelled `| 1.4 |` was a host the ratchet did
 * not carry and the window excluded, and dropping it silently let it ship).
 */
export function parseVerifiedHostRows(markdown) {
	const section = (markdown.split(CERTIFIED_SECTION)[1] ?? "").split(
		/\n## /,
	)[0];
	const pipeRows = (section ?? "")
		.split("\n")
		.filter((line) => line.trimStart().startsWith("|"));
	const separator = pipeRows.findIndex((line) => SEPARATOR_ROW.test(line));
	// A markdown table's separator sits BETWEEN its header and its body, so the
	// header is the row above it and every row below it is a host. Dropping the
	// first pipe row instead loses a HOST whenever the header is absent, and
	// the table then shrinks with both readers reporting it clean (#4719 F4:
	// a table without its header returned only its last host).
	//
	// The row above the separator is a header only while it names COLUMNS: a
	// row spelling a version is a HOST, and taking it for the header drops that
	// host while both readers call the shorter set clean (#4719 F9, the
	// spelling F4 left behind). Such a row is kept as a host and the table is
	// refused, because the header it needs is not there either way.
	const headerRow = separator > 0 ? pipeRows[separator - 1] : undefined;
	const headerNamesHost =
		headerRow !== undefined && VERSION_ROW.test(headerRow);
	const body = separator < 0 ? pipeRows : pipeRows.slice(separator + 1);
	const rows = (headerNamesHost ? [headerRow, ...body] : body).map((line) => ({
		line,
		version: line.match(VERSION_ROW)?.[1] ?? null,
	}));
	// `hasHeader` is part of the parse because a section whose pipes have no
	// separator row above them is not a table: markdown renders those pipes as
	// literal text, so a reader that took them for hosts would invent a
	// certified set out of prose. `problem` is the one structural refusal both
	// readers share, so neither can read a table the other refuses.
	const hasHeader = separator > 0 && !headerNamesHost;
	return {
		rows,
		hasHeader,
		problem: !hasHeader
			? headerNamesHost
				? `the row above the separator under \`${CERTIFIED_SECTION}\` names a host, not a header: ${headerRow.trim()}`
				: pipeRows.length > 0
					? `the piped rows under \`${CERTIFIED_SECTION}\` have no header row above their separator`
					: undefined
			: undefined,
	};
}

/** The certified host versions the doc's table names, plus any row it could not read. */
export function certifiedHosts(markdown) {
	const { rows, problem } = parseVerifiedHostRows(markdown);
	const versions = rows
		.map((row) => row.version)
		.filter((version) => typeof version === "string");
	return {
		versions: [...new Set(versions)].sort(compareVersions),
		unparseable: rows
			.filter((row) => row.version === null)
			.map((row) => row.line.trim()),
		// A section whose pipes are not under a header has no certified set to
		// read, so the caller refuses rather than reading the text as hosts. A
		// section with no pipes at all is a different refusal (no certified host
		// is named), which the caller already has.
		problem,
	};
}

/**
 * Every layout one `--host-root` may name, in probe order: a package dir, a
 * `node_modules` root or other prefix holding the scoped package, a versioned
 * install prefix (the orchestrator keeps hosts at `<dir>/pi-<version>`), and
 * an npm global prefix.
 */
export function hostPackageCandidates(candidate) {
	const resolved = path.resolve(candidate);
	return [
		resolved,
		path.join(resolved, "node_modules", HOST_PACKAGE),
		path.join(resolved, HOST_PACKAGE),
		path.join(resolved, "lib", "node_modules", HOST_PACKAGE),
	];
}

/**
 * The host package a root resolves to, or `undefined` when no layout holds
 * one. The manifest's `name` must be the host package: a directory named
 * `pi-coding-agent` that holds some other package's manifest is not a host.
 */
export function resolveHostPackage(candidate) {
	for (const dir of hostPackageCandidates(candidate)) {
		let manifest;
		try {
			manifest = JSON.parse(
				fs.readFileSync(path.join(dir, "package.json"), "utf8"),
			);
		} catch {
			// Not a package directory: the next layout may be.
			continue;
		}
		if (manifest?.name === HOST_PACKAGE && typeof manifest.version === "string")
			return { dir, version: manifest.version };
	}
	return undefined;
}

/**
 * Installed hosts by version, first root winning, plus the roots that hold no
 * host at all (reported, never silently ignored: a mistyped `--host-root`
 * otherwise reads as "not installed" for every host).
 */
export function discoverInstalledHosts(roots) {
	const byVersion = new Map();
	const unreadable = [];
	for (const root of roots) {
		const resolved = resolveHostPackage(root);
		if (!resolved) {
			unreadable.push(path.resolve(root));
			continue;
		}
		if (!byVersion.has(resolved.version)) {
			byVersion.set(resolved.version, resolved.dir);
		}
	}
	return {
		hosts: [...byVersion]
			.map(([version, dir]) => ({ version, dir }))
			.sort((a, b) => compareVersions(a.version, b.version)),
		unreadable,
	};
}

/**
 * Probe every certified host that is installed. `runTierSuite` is the one
 * injected child-process seam: the CLI passes the Vitest runner, and a test
 * passes a recorder. A host the machine does not carry is a `not installed`
 * row, never a failure — unless the caller demanded all of them.
 */
export async function runSpread({ certified, hosts, runTierSuite }) {
	const rows = [];
	for (const version of certified) {
		const host = hosts.find((entry) => entry.version === version);
		if (!host) {
			rows.push({ version, installed: false, tiers: [], failed: false });
			continue;
		}
		const tiers = [];
		for (const suite of TIER_SUITES) {
			const result = await runTierSuite({ host, suite });
			tiers.push({ ...suite, ...result });
		}
		rows.push({
			version,
			installed: true,
			dir: host.dir,
			tiers,
			failed: tiers.some((tier) => !tier.ok),
		});
	}
	const installed = rows.filter((row) => row.installed);
	const failed = rows.filter((row) => row.failed);
	const missing = rows.filter((row) => !row.installed);
	return {
		rows,
		installed: installed.length,
		missing: missing.map((row) => row.version),
		failed: failed.map((row) => row.version),
	};
}

/**
 * The verdict one tier run earns, from its child's exit status and the
 * transcript's parsed summary. A run that reported no passing test is NOT a
 * pass: an empty tier would otherwise come out green on every host, which is
 * the exact shape a mis-set `PI_LENS_PI_HOST_PACKAGE` or a file filter that
 * matches nothing produces. The parser reports an absent count as `null`, so
 * "no counts in the transcript" and "zero collected" are the same refusal.
 */
export function tierVerdict({ status, timedOut, summary }) {
	const passed = summary.testsPassed ?? 0;
	const failed = summary.testsFailed ?? 0;
	const skipped = summary.testsSkipped ?? 0;
	const ok = status === 0 && passed > 0 && failed === 0;
	return {
		ok,
		passed: summary.testsPassed,
		// Vitest prints no `failed` count on a green run, so an absent one is
		// zero, not unknown.
		total: summary.testsPassed === null ? null : passed + failed + skipped,
		timedOut: timedOut === true,
	};
}

/** One line per host: what ran, where, and on which version. */
export function renderHostLine(row) {
	if (!row.installed) return `${HOST_PACKAGE} ${row.version}: not installed`;
	const tiers = row.tiers
		.map(
			(tier) =>
				`${tier.tier} ${tier.ok ? "pass" : "FAIL"} ${tier.passed ?? "?"}/${tier.total ?? "?"}`,
		)
		.join(" · ");
	return `${HOST_PACKAGE} ${row.version} (${row.dir}): ${tiers}`;
}

/** The run's one-line arithmetic, so a partial spread cannot read as a full one. */
export function renderSpreadSummary(spread) {
	const parts = [
		`${spread.installed} installed`,
		`${spread.missing.length} not installed`,
		`${spread.failed.length} failed`,
	];
	return `certified hosts: ${parts.join(", ")}`;
}

/**
 * Exit codes. `hostMissing` is reserved for a run that demanded every
 * certified host (`--require-all`); without the flag a host the machine does
 * not carry is reported and ignored, which is what makes the spread runnable
 * on a maintainer's box that holds one or two of them.
 */
export const EXIT = {
	ok: 0,
	tiersFailed: 1,
	usage: 2,
	hostMissing: 3,
};

/** The exit code a finished spread earns under the caller's demand. */
export function exitCodeForSpread(spread, { requireAll = false } = {}) {
	if (spread.failed.length > 0) return EXIT.tiersFailed;
	if (requireAll && spread.missing.length > 0) return EXIT.hostMissing;
	return EXIT.ok;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const FLAGS_WITH_VALUE = new Set(["--host-root", "--timeout-ms"]);

/**
 * Parse the CLI's argv. An unknown flag or a flag without its value throws:
 * the run is refused before anything is spawned.
 */
export function parseCliArgs(argv) {
	const hostRoots = [];
	let requireAll = false;
	let timeoutMs = DEFAULT_TIMEOUT_MS;
	let help = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") {
			help = true;
			continue;
		}
		if (argument === "--require-all") {
			requireAll = true;
			continue;
		}
		if (FLAGS_WITH_VALUE.has(argument)) {
			const value = argv[index + 1];
			// A leading dash is another flag, never a value: `--host-root -h`
			// used to become a directory named `-h`, and the run exited 0 with a
			// green spread over a path that cannot be an install (#4719 F5). A
			// value that really starts with a dash is spelled `./-name`.
			if (value === undefined || value.startsWith("-"))
				throw new Error(`${argument} needs a value`);
			index += 1;
			if (argument === "--host-root") hostRoots.push(path.resolve(value));
			else {
				const parsed = Number.parseInt(value, 10);
				if (!Number.isFinite(parsed) || parsed <= 0 || `${parsed}` !== value)
					throw new Error(
						`--timeout-ms needs a whole number of milliseconds, got ${JSON.stringify(value)}`,
					);
				timeoutMs = parsed;
			}
			continue;
		}
		throw new Error(`unknown argument ${JSON.stringify(argument)}`);
	}
	return { hostRoots, requireAll, timeoutMs, help };
}
