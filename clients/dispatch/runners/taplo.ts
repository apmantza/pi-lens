import * as path from "node:path";
import { findLocalBinUpwards } from "../../package-manager.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { getLinterPolicyForCwd } from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createAvailabilityChecker,
	lspPrimaryCoversFile,
	resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.js";
import type { ToolExitCodes } from "./utils/spawn-outcome.js";
import { parseToolRun } from "./utils/tool-failure.js";

const taplo = createAvailabilityChecker("taplo", ".exe");

// Verified against taplo 0.10.0: 0 = clean, 1 = the file is invalid (lint
// findings, or a schema it could not load), 2 = clap rejected the invocation.
//
// #1937 round 2: the parser fix alone turned the old silent-clean into a false
// BLOCKING diagnostic. clap prints `error: unexpected argument '--output'
// found`, which starts with the same lowercase `error:` a real taplo
// diagnostic does, so a mistyped flag would have reddened every valid TOML
// file. Both readings are wrong; the exit code is what separates them.
const TAPLO_EXIT_CODES: ToolExitCodes = { ran: [1] };

/** `error: <summary>` or `warning: <summary>` at the head of a codespan block. */
const HEADER_PATTERN = /^\s*(error|warning):(.*)$/;

/** The box-drawing lead taplo puts on a codespan location line. */
const LOCATION_LEAD = "┌─";

/** The `:line:column` tail of a codespan location line. */
const LOCATION_PATTERN = /:(\d+):(\d+)$/;

/**
 * Parse `taplo lint` output (#1937).
 *
 * This parser used to `JSON.parse` a `{ errors: [{ range, message, kind }] }`
 * envelope that taplo has never emitted, fed by a `--output=json` flag taplo
 * has never accepted. Real taplo rejected the flag with exit 2 and a usage
 * error, the JSON parse threw, the catch returned [], and malformed TOML was
 * reported clean. Same shape as the vale parser in #1933.
 *
 * Real taplo 0.10.0 writes codespan diagnostics to STDERR, interleaved with
 * uppercase tracing lines:
 *
 *     error: invalid TOML
 *       ┌─ /path/to/bad.toml:2:9
 *       │
 *     2 │   [package
 *
 * Verified against tests/fixtures/runner-output/taplo/real.captured.json.
 *
 * A header alone is NOT enough to emit a diagnostic. The codespan location
 * line must follow it. clap's own failures start with the same lowercase
 * `error:` and carry no location, so without that requirement a rejected
 * invocation becomes a blocking finding on line 1 of a perfectly valid file
 * (#1937 round 2). The exit-code table in the runner is the primary guard;
 * this is the structural one, and each covers a case the other does not.
 */
export function parseTaploOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const lines = (raw ?? "").split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		// Lowercase `error:`/`warning:` starts a diagnostic. taplo's tracing
		// lines are uppercase (`ERROR taplo:lint_files: ...`), so a
		// case-sensitive match keeps them out.
		//
		// Both patterns below trim in code rather than with a trailing `\s*`,
		// and the location one tests for its box-drawing lead separately
		// instead of skipping to it with `.*`. Either shape backtracks
		// super-linearly on a long line, and this parser reads bytes a third
		// party wrote.
		const header = HEADER_PATTERN.exec(lines[i].trimEnd());
		if (!header) continue;
		const severityWord = header[1];
		const summary = header[2].trim();
		if (!summary) continue;

		// The location arrives on a following `┌─ file:line:col` line. Scan a
		// short window rather than assuming adjacency: taplo puts a gutter line
		// between them in some layouts.
		let line: number | null = null;
		let column = 1;
		for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
			if (!lines[j].includes(LOCATION_LEAD)) continue;
			const location = LOCATION_PATTERN.exec(lines[j].trimEnd());
			if (!location) continue;
			line = Number.parseInt(location[1], 10) || 1;
			column = Number.parseInt(location[2], 10) || 1;
			break;
		}
		if (line === null) continue;

		const severity = severityWord === "warning" ? "warning" : "error";
		diagnostics.push({
			id: `taplo-${severity}-${line}-${column}`,
			message: summary,
			filePath,
			line,
			column,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "taplo",
			rule: `taplo/${severity}`,
			fixable: false,
		});
	}

	return diagnostics;
}

const taploRunner: RunnerDefinition = {
	id: "taplo",
	appliesTo: ["toml"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "taplo");
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("taplo")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// #233: the `toml` LSP server IS `taplo lsp` (same binary). When that LSP
		// covers this file, the warm server already produces these diagnostics —
		// skip the redundant CLI scan to avoid double-reporting. Stays active when
		// the LSP is disabled/unavailable so TOML coverage never regresses.
		if (lspPrimaryCoversFile(ctx, "toml") && (await ctx.hasTool("taplo"))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Project binary first (#1731, discipline B): `taplo.isAvailableAsync`
		// resolves through `findManagedNodeToolBinary`, pi-lens's own managed
		// shim — checked BEFORE any project-local candidate, so a project's own
		// `node_modules/.bin/taplo` (npm `@taplo/cli`) never won once the managed
		// copy answered. `findLocalBinUpwards` defaults to `.cmd` on Windows,
		// matching that npm shim; the availability checker's `.exe` extension is
		// correct for pi-lens's OWN managed install (a GitHub-release binary,
		// `clients/installer/index.ts` taplo entry), a different artifact with a
		// different extension, so it stays as the checker's fallback only.
		let cmd: string | null = findLocalBinUpwards("taplo", cwd) ?? null;
		if (!cmd) {
			if (await taplo.isAvailableAsync(cwd)) {
				cmd = taplo.getCommand(cwd);
			} else {
				cmd = await resolveToolCommandWithInstallFallback(cwd, "taplo");
			}
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const absPath = path.resolve(cwd, ctx.filePath);
		// #1937: `--output=json` is not a taplo flag. taplo rejected it with a
		// usage error, so this runner never linted anything. `--colors never`
		// keeps ANSI escapes out of the bytes the parser reads.
		const result = await safeSpawnAsync(
			cmd,
			["check", "--colors", "never", absPath],
			{ cwd, timeout: 15000 },
		);

		// taplo reports on stderr and leaves stdout empty, so the
		// "nothing to parse" test must read the same string the parser gets —
		// otherwise every real run looks like a failed spawn.
		const raw = result.stderr?.trim() ? result.stderr : (result.stdout ?? "");
		//
		// taplo exits 1 only when a file is INVALID, and it does not always draw
		// a codespan block when it does: a schema it could not load is reported
		// through its tracing output alone. Claiming that file clean would be an
		// outright lie, so taplo opts into `skipWhenParsedNothing` (#1948). This
		// replaces a hand-rolled per-runner copy of the same rule, which wrote
		// its own `runner-empty-result` row with its own wording.
		const run = parseToolRun(
			"taplo",
			{ result, output: raw, exitCodes: TAPLO_EXIT_CODES },
			(out) => parseTaploOutput(out, ctx.filePath),
			{ skipWhenParsedNothing: true },
		);
		if (run.skipped) return run.skipped;

		const diagnostics = run.diagnostics;
		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return { status: "failed", diagnostics, semantic: "blocking" };
	},
};

export default taploRunner;
