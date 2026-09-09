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
const WORKSPACE_TOKEN = "__WORKSPACE__";

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
	workspace: string;
	platform: string;
	capturedAt: string;
	note?: string;
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
			});
		}
	}
	return out;
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
	const posixWorkspace = workspace.replace(/\\/g, "/");
	const substitute = (text: string) =>
		text.split(WORKSPACE_TOKEN).join(posixWorkspace);
	return {
		stdout: substitute(fixture.stdout),
		stderr: substitute(fixture.stderr),
		status: fixture.exitCode,
	};
}
