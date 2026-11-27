/**
 * Loader for captured real-binary runner output (#1937).
 *
 * Each fixture under `tests/fixtures/runner-output/<runnerId>/<case>.captured.json`
 * holds the stdout, stderr, and exit code a REAL tool produced, plus a
 * provenance header written by `scripts/capture-runner-output.mjs`. Tests replay
 * those bytes through the runner instead of through a shape the test author
 * imagined, which is the failure #1933 found in the vale parser.
 *
 * Machine-specific paths in the captured bytes are stored as the literal token
 * `__WORKSPACE__`. `materialize` substitutes the temp workspace the test built,
 * so a fixture captured on Windows replays on Linux.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Fixture root. Exported so the coverage guard can report a real path. */
export const CAPTURED_OUTPUT_DIR = path.resolve(
	here,
	"../fixtures/runner-output",
);

/** Placeholder the capture script substitutes for its workspace path. */
export const WORKSPACE_TOKEN = "__WORKSPACE__";

/** Fields every provenance header must carry, all non-empty strings. */
const REQUIRED_PROVENANCE_FIELDS = [
	"runner",
	"tool",
	"version",
	"command",
	"workspace",
	"platform",
	"capturedAt",
] as const;

interface CapturedProvenance {
	runner: string;
	tool: string;
	version: string;
	command: string;
	/** The exact argv, lossless where `command` is not (quoted tokens). */
	argv: string[];
	/** The argv the version banner came from (`--version` unless recorded). */
	versionArgv?: string[];
	workspace: string;
	platform: string;
	capturedAt: string;
	note?: string;
}

/**
 * One availability probe the runner's checker sends, run against the real tool
 * by the capture (#4473). The replay answers that exact spawn with these bytes
 * instead of mocking `createAvailabilityChecker`, so a tool that REJECTS its
 * probe — helm 4 rejects `--version` — is visible to the replay layer.
 */
export interface CapturedAvailability {
	/** The command as the checker spawns it (its argv[0]). */
	command: string;
	/** Arguments after the command, in order. */
	argv: string[];
	/**
	 * The binary that answered, from its own version banner. It can differ from
	 * `provenance.version` (the binary whose WORK output this fixture holds) when
	 * a build that answers identically is all a host has; both are disclosed here
	 * rather than assumed equal.
	 */
	version: string;
	/** The real exit status. A non-zero answer is the point: see helm 4. */
	exitCode: number | null;
	stdout: string;
	stderr: string;
	/**
	 * Set when the probe's own binary could not be spawned at all on the capture
	 * host. It records an absence, never a claim that something answered.
	 */
	error?: string;
}

/**
 * A real clean run of the runner's own invocation (#4522): the same argv in a
 * workspace whose analysed input is clean. The matrix's clean cell replays these
 * bytes; `""` invented by a test is not evidence that the tool prints nothing.
 */
export interface CapturedClean {
	/** Repo-relative workspace the clean run happened in. */
	workspace: string;
	/** The analysed path, relative to that workspace. */
	file: string;
	/** The invocation, unchanged from the fixture's own. */
	argv: string[];
	/** The binary that answered, from its own version banner. */
	version: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export interface CapturedOutput {
	/** Repo-relative path, for assertion messages. */
	relPath: string;
	/** Fixture basename without `.captured.json`. */
	caseName: string;
	provenance: CapturedProvenance;
	/** Workspace-relative path the tool was pointed at. */
	file: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	/** Every probe answer the capture recorded; missing means the fixture is stale. */
	availability: CapturedAvailability[];
	/** The captured clean run. Every fixture has one: there is no prose escape. */
	clean?: CapturedClean;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Everything wrong with one fixture's provenance header, as human-readable
 * strings. Empty means the header is complete and self-consistent.
 *
 * The checks are deliberately about TRACEABILITY, not taste: a header exists so
 * a reader can re-run the exact command against the named version and compare.
 * A header that merely exists, with a blank version or a command that never
 * mentions the tool, buys nothing.
 */
export function provenanceProblems(fixture: CapturedOutput): string[] {
	const problems: string[] = [];
	const p = fixture.provenance as unknown as
		| Record<string, unknown>
		| undefined;
	if (!p || typeof p !== "object") {
		return [`${fixture.relPath}: missing provenance header`];
	}
	for (const field of REQUIRED_PROVENANCE_FIELDS) {
		if (!isNonEmptyString(p[field])) {
			problems.push(
				`${fixture.relPath}: provenance.${field} is missing or empty`,
			);
		}
	}
	if (isNonEmptyString(p.version) && !/\d+\.\d+/.test(p.version)) {
		problems.push(
			`${fixture.relPath}: provenance.version "${p.version}" has no major.minor — a capture must name the binary's real version`,
		);
	}
	if (
		isNonEmptyString(p.command) &&
		isNonEmptyString(p.tool) &&
		!p.command.includes(p.tool)
	) {
		problems.push(
			`${fixture.relPath}: provenance.command "${p.command}" does not mention tool "${p.tool}"`,
		);
	}
	if (
		isNonEmptyString(p.capturedAt) &&
		!/^\d{4}-\d{2}-\d{2}$/.test(p.capturedAt)
	) {
		problems.push(
			`${fixture.relPath}: provenance.capturedAt "${p.capturedAt}" is not an ISO date (YYYY-MM-DD)`,
		);
	}
	if (
		isNonEmptyString(p.platform) &&
		!/^(win32|linux|darwin)-/.test(p.platform)
	) {
		problems.push(
			`${fixture.relPath}: provenance.platform "${p.platform}" is not <node-platform>-<arch>`,
		);
	}
	// `argv` is what the argv-tie assertion compares against. Splitting
	// `command` back on whitespace loses a quoted token like `{{json .}}`, so
	// the array is the authoritative record and must be present.
	const argv = p.argv;
	if (
		!Array.isArray(argv) ||
		argv.length === 0 ||
		argv.some((token) => typeof token !== "string")
	) {
		problems.push(
			`${fixture.relPath}: provenance.argv must be a non-empty array of strings — it is what ties the fixture to the runner's invocation`,
		);
	}
	if (fixture.exitCode === undefined) {
		problems.push(`${fixture.relPath}: exitCode is missing`);
	}
	if (
		typeof fixture.stdout !== "string" ||
		typeof fixture.stderr !== "string"
	) {
		problems.push(`${fixture.relPath}: stdout/stderr must both be strings`);
	}
	if (!isNonEmptyString(fixture.file)) {
		problems.push(`${fixture.relPath}: file (the analysed path) is missing`);
	}
	return problems;
}

/** Runner ids that have at least one captured fixture. */
function capturedRunnerIds(): string[] {
	if (!fs.existsSync(CAPTURED_OUTPUT_DIR)) return [];
	return fs
		.readdirSync(CAPTURED_OUTPUT_DIR, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();
}

/**
 * Every captured fixture on disk.
 *
 * Reads the directory rather than a hand-maintained index: a list that mirrors
 * the filesystem drifts, and a fixture nobody indexed is a fixture nothing
 * asserts.
 */
export function listCapturedOutputs(): CapturedOutput[] {
	const out: CapturedOutput[] = [];
	for (const runnerId of capturedRunnerIds()) {
		const dir = path.join(CAPTURED_OUTPUT_DIR, runnerId);
		for (const entry of fs.readdirSync(dir).sort()) {
			if (!entry.endsWith(".captured.json")) continue;
			const full = path.join(dir, entry);
			const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
			out.push({
				relPath: `tests/fixtures/runner-output/${runnerId}/${entry}`,
				caseName: entry.replace(/\.captured\.json$/, ""),
				provenance: parsed.provenance,
				file: parsed.file,
				exitCode: parsed.exitCode,
				stdout: parsed.stdout,
				stderr: parsed.stderr,
				availability: Array.isArray(parsed.availability)
					? parsed.availability
					: [],
				...(parsed.clean ? { clean: parsed.clean } : {}),
			});
		}
	}
	return out;
}

/**
 * Everything wrong with a fixture's availability records, as human-readable
 * strings. Empty means every recorded probe answer is complete.
 *
 * The record replaced the replay's mocked `createAvailabilityChecker` (#4473),
 * so a fixture without one cannot be replayed honestly: the replay would have
 * to invent the verdict that decides whether the run happens at all.
 */
export function availabilityProblems(fixture: CapturedOutput): string[] {
	const records = fixture.availability;
	if (!Array.isArray(records) || records.length === 0) {
		return [
			`${fixture.relPath}: no availability record — re-capture with scripts/capture-runner-output.mjs --probe '["--version"]', which records the real tool's answer to the probe its runner sends (#4473)`,
		];
	}
	const problems: string[] = [];
	for (const record of records as unknown as Array<Record<string, unknown>>) {
		const where = `${fixture.relPath}: availability for ${String(record?.command)} ${JSON.stringify(record?.argv)}`;
		if (!isNonEmptyString(record?.command)) {
			problems.push(`${where}: command is missing`);
		}
		if (
			!Array.isArray(record?.argv) ||
			record.argv.some((token) => typeof token !== "string")
		) {
			problems.push(`${where}: argv must be an array of strings`);
		}
		// The version tie is `recordProblems` in scripts/capture-runner-output.mjs:
		// one rule, shared by the capture gate and this census. A record with no
		// version is only complete when it says its spawn failed, which that rule
		// also decides.
		if (typeof record?.exitCode !== "number" && !record?.error) {
			problems.push(
				`${where}: exitCode must be the real exit status — a record that drops it cannot tell a rejected probe from an accepted one`,
			);
		}
		if (
			typeof record?.stdout !== "string" ||
			typeof record?.stderr !== "string"
		) {
			problems.push(`${where}: stdout/stderr must both be strings`);
		}
	}
	return problems;
}

/**
 * Why a fixture's captured clean run does not count as one, if it records any.
 * A fixture with no clean record returns its own problem here, because the
 * matrix's clean cell and this census both refuse to model one.
 *
 * The version, invocation and workspace ties live in `recordProblems`
 * (`scripts/capture-runner-output.mjs`), which the capture refuses to write
 * past; these are the shape checks a hand-edited fixture can still break.
 */
export function cleanProblems(fixture: CapturedOutput): string[] {
	const clean = fixture.clean as unknown as Record<string, unknown> | undefined;
	if (!clean) {
		return [
			`${fixture.relPath}: no clean run — capture one with scripts/capture-runner-fixtures.mjs --records-only. A prose reason is not a substitute: it let any runner silence its clean cell (#4522 F8)`,
		];
	}
	const problems: string[] = [];
	const where = `${fixture.relPath}: clean run`;
	if (!isNonEmptyString(clean.workspace)) {
		problems.push(
			`${where}: workspace is missing — the clean input every replay copies`,
		);
	}
	if (!isNonEmptyString(clean.file)) {
		problems.push(`${where}: file (the analysed path) is missing`);
	}
	if (
		!Array.isArray(clean.argv) ||
		clean.argv.length === 0 ||
		clean.argv.some((token) => typeof token !== "string")
	) {
		problems.push(`${where}: argv must be a non-empty array of strings`);
	}
	if (!isNonEmptyString(clean.version)) {
		problems.push(`${where}: version is missing`);
	}
	if (clean.exitCode !== 0) {
		problems.push(
			`${where}: exitCode is ${String(clean.exitCode)} — a clean run that exits non-zero is not a clean run`,
		);
	}
	if (typeof clean.stdout !== "string" || typeof clean.stderr !== "string") {
		problems.push(`${where}: stdout/stderr must both be strings`);
	}
	return problems;
}

/**
 * The recorded answer to the probe `command argv` sent, or undefined when the
 * capture recorded none. Matched on the command and the arguments in order: a
 * probe the runner spells differently is a drift this replay must not paper
 * over with another probe's answer.
 */
export function probeAnswer(
	fixture: CapturedOutput,
	command: string,
	argv: readonly string[],
): CapturedAvailability | undefined {
	// The runner may spawn an absolute path it resolved
	// (`/…/.cargo/bin/cargo`, `C:\Users\…\.cargo\bin\cargo.exe`) where the
	// capture recorded the bare tool name; the identity is the binary, so the
	// basename decides. Windows executable suffixes are part of the platform's
	// naming, not the binary's: rust-clippy resolves `cargo.exe` there and the
	// fixture records `cargo`, which failed every Rust cell on that lane (#4522
	// review). The suffix set is Windows' own executable family, the same one
	// `clients/safe-spawn.ts` resolves; the ARGUMENTS stay exact.
	const identity = probeBinaryIdentity(command);
	return fixture.availability.find(
		(record) =>
			(record.command === command ||
				probeBinaryIdentity(record.command) === identity) &&
			record.argv.length === argv.length &&
			record.argv.every((token, index) => token === argv[index]),
	);
}

/** A command's binary identity: its basename, case-folded, without a Windows
 * executable suffix (`.exe`/`.com`/`.cmd`/`.bat`). */
function probeBinaryIdentity(command: string): string {
	const base = command.split(/[\\/]/).pop() ?? command;
	return base.replace(/\.(?:exe|com|cmd|bat)$/i, "").toLowerCase();
}

/**
 * The captured bytes with `__WORKSPACE__` replaced by `workspace`, shaped like
 * a `safeSpawnAsync` result so a test can hand it straight to the mock.
 *
 * The substitution uses forward slashes even on Windows. Captured bytes are
 * frequently JSON, where a Windows path appears with doubled backslashes;
 * splicing a raw `C:\Users\...` back in would produce invalid escapes and the
 * parser under test would fail for a reason that has nothing to do with the
 * tool. Forward slashes are valid in both JSON strings and Windows paths.
 */
export function materialize(
	fixture: CapturedOutput,
	workspace: string,
): { stdout: string; stderr: string; status: number | null } {
	return substituteWorkspace(fixture, workspace);
}

/**
 * One captured spawn's bytes, with `__WORKSPACE__` replaced by `workspace`.
 *
 * The work half and the clean half differ only in WHICH record they read, so
 * the substitution lives here once: a path fix copied into one replay and not
 * the other would let the two drift (#4522 NEW review, "Clean paths repeat
 * shared code").
 */
function substituteWorkspace(
	record: Pick<CapturedOutput, "stdout" | "stderr" | "exitCode">,
	workspace: string,
): { stdout: string; stderr: string; status: number | null } {
	const posixWorkspace = workspace.replace(/\\/g, "/");
	const substitute = (text: string) =>
		text.split(WORKSPACE_TOKEN).join(posixWorkspace);
	return {
		stdout: substitute(record.stdout),
		stderr: substitute(record.stderr),
		status: record.exitCode,
	};
}

/**
 * The captured CLEAN run's bytes, with `__WORKSPACE__` replaced by `workspace`.
 *
 * The clean half is only evidence once its paths name the workspace it replays
 * in. An unresolvable `__WORKSPACE__/bad.js` names no file on the replay host,
 * so a parser that drops a finding for a path outside the cwd drops every
 * finding, and the clean cell passes whatever the bytes say (#4522 F4).
 */
export function materializeClean(
	fixture: CapturedOutput,
	workspace: string,
): { stdout: string; stderr: string; status: number | null } {
	const clean = fixture.clean;
	if (!clean) {
		throw new Error(
			`${fixture.relPath}: no clean run to materialize — the census requires one`,
		);
	}
	return substituteWorkspace(clean, workspace);
}

/**
 * Every command the fixtures name as a probe answer, plus the work binary of
 * each. Both replay suites stub these on a PATH of their own, because
 * the registry ladder (`resolveToolCommandWithInstallFallback`) reads filesystem
 * presence, in its project and managed rungs and in the `isSpawnableCommand`
 * re-check of a cached positive, and a host that has one of them must not change
 * which spawns reach the mocked seam.
 *
 * Derived from the fixtures, never listed: a hand-written list (`oxlint` was the
 * one observed spelling) models presence for exactly the tools that already
 * broke, and passes every tool added later (#4522 F12).
 */
export function probeCommandNames(
	fixtures: readonly CapturedOutput[],
): string[] {
	const names = new Set<string>();
	for (const fixture of fixtures) {
		names.add(fixture.provenance.tool);
		for (const record of fixture.availability) {
			names.add(record.command.split(/[\\/]/).pop() ?? record.command);
		}
	}
	return [...names].sort();
}
