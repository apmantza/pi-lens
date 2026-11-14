import { toolAbsentSkip } from "./utils/runner-helpers.js";
import { skipped } from "../types.js";
import { findToolConfig, hasToolConfig } from "../../tool-config-presence.js";
import * as path from "node:path";
import {
	isLocalBinTrustRefusal,
	type LocalBinLookup,
	localBinPath,
} from "../../package-manager.js";
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
	resolveVendorToolCommand,
} from "./utils/runner-helpers.js";
import type { ToolExitCodes } from "./utils/spawn-outcome.js";
import {
	type AnchoredConfig,
	anchorIgnorePattern,
	markUnanchored,
	readConfigText,
	withOverlayFile,
} from "./utils/ignore-anchor.js";
import { parseToolRun } from "./utils/tool-failure.js";
import { finishParsedRun } from "./utils/tool-failure.js";

// EXIT TABLE (PHPStan 1.12 docs https://phpstan.org/user-guide/command-line-usage): 0 = no errors, 1 = errors found, 2 = a
// fatal/internal error that stopped the analysis. Only 1 is a run that carries
// findings.
const PHPSTAN_EXIT_CODES: ToolExitCodes = { ran: [1] };

const phpstan = createAvailabilityChecker("phpstan", ".phar");

interface PhpstanError {
	message: string;
	line: number | null;
	ignorable?: boolean;
	/** phpstan 1.10+ error identifier, e.g. "return.type". */
	identifier?: string;
}

/**
 * Real `phpstan analyse --error-format=json` output, verified against phpstan
 * 2.2.8 — see tests/fixtures/runner-output/phpstan/real.captured.json.
 *
 * `errors` is the error COUNT, a number; the findings live in `messages`. This
 * parser read `errors` as the array (#1937), so `for...of` threw on a number,
 * the catch swallowed it, and a configured phpstan project reported zero
 * findings while the CLI exited 1 — the #1933 vale shape.
 */
interface PhpstanFileErrors {
	errors: number;
	messages: PhpstanError[];
}

interface PhpstanOutput {
	files: Record<string, PhpstanFileErrors>;
	errors: string[];
}

// phpstan analyses the target file PLUS its dependency closure and keys errors
// by the real file in `output.files`. Attribute each diagnostic to that key
// (resolved against cwd) rather than blanket-stamping ctx.filePath — otherwise a
// cross-file regression is mis-located onto the edited file (#265 A3). We do NOT
// filter to the edited file: surfacing the cross-file impact is the point.
export function parsePhpstanJson(
	raw: string,
	fallbackPath: string,
	cwd: string,
): Diagnostic[] {
	try {
		const output: PhpstanOutput = JSON.parse(raw);
		const diagnostics: Diagnostic[] = [];

		for (const [file, fileErrors] of Object.entries(output.files ?? {})) {
			const filePath =
				file && file.trim()
					? path.isAbsolute(file)
						? file
						: path.resolve(cwd, file)
					: fallbackPath;
			for (const err of fileErrors?.messages ?? []) {
				diagnostics.push({
					id: `phpstan:${err.line ?? 1}:${err.message.slice(0, 40)}`,
					message: err.message,
					filePath,
					line: err.line ?? 1,
					column: 1,
					severity: "error",
					semantic: "blocking",
					tool: "phpstan",
					rule: err.identifier || "phpstan",
					fixable: false,
				});
			}
		}

		// #1937 round 2: the top-level `errors[]` array carries phpstan's
		// FILE-INDEPENDENT findings — internal errors, and ignore patterns that
		// matched nothing. A run can report `totals.errors: 1` with `files: {}`
		// and exit 1, and reading only `files` turned that into zero
		// diagnostics: the same defect class as the `errors`-vs-`messages` bug
		// above, one level up. Pinned by
		// tests/fixtures/runner-output/phpstan/top-level-errors.captured.json.
		//
		// These have no file or line, so they attach to the edited file at line
		// 1. That is the honest placement: the reader needs to see them, and
		// there is nowhere truer to put them.
		for (const message of output.errors ?? []) {
			if (typeof message !== "string" || !message.trim()) continue;
			diagnostics.push({
				id: `phpstan:global:${message.slice(0, 40)}`,
				message,
				filePath: fallbackPath,
				line: 1,
				column: 1,
				severity: "error",
				semantic: "blocking",
				tool: "phpstan",
				rule: "phpstan/analysis",
				fixable: false,
			});
		}

		return diagnostics;
	} catch {
		return [];
	}
}

async function resolvePhpstan(cwd: string): Promise<LocalBinLookup | null> {
	if (await phpstan.isAvailableAsync(cwd)) return phpstan.getCommand(cwd);
	return resolveVendorToolCommand(cwd, "phpstan", ".bat");
}

const PHPSTAN_DUMP_TIMEOUT_MS = 15_000;

/**
 * Whether a phpstan config can set `excludePaths` at all: it names the key (or
 * its 1.x spelling `excludes_analyse`) or includes another file that might. A
 * config that does neither has no ignore glob to anchor, so the dump spawn is
 * skipped. A false positive costs one spawn; a false negative would need a
 * config that sets the parameter without writing its name or an include.
 */
export function phpstanConfigMayExclude(text: string): boolean {
	return /exclude|includes/i.test(text);
}

/** A neon string: JSON's double-quoted form, with `%` doubled so DI keeps it literal. */
function neonString(value: string): string {
	return JSON.stringify(value).replace(/%/g, "%%");
}

/**
 * phpstan matches an `excludePaths` entry that holds a wildcard against the
 * file's absolute path with `fnmatch`, so `**\/.claude/**` reaches the
 * ancestors of the project root too (#5594). `phpstan dump-parameters --json`
 * prints what phpstan resolved from the config and everything it includes: a
 * path entry already absolute, a wildcard entry as written, in the two lists
 * `analyse` and `analyseAndScan`. This anchors each wildcard entry at the root
 * and returns a neon config that includes the project's own and replaces the
 * lists (`excludePaths!`), so every other parameter is the project's.
 *
 * `(?)` is appended to each kept path entry: the dump drops the marker that
 * lets an entry name a path that does not exist yet, and phpstan refuses a
 * missing one without it.
 *
 * Refused (`unapplied`): a dump that exited nonzero or is not the object this
 * reads, a list entry that is not a string, and a wildcard form
 * `anchorIgnorePattern` does not recognise.
 */
export function anchorPhpstanConfig(
	dump: { status: number | null; stdout?: string },
	userConfig: string,
	root: string,
): AnchoredConfig {
	if (dump.status !== 0) {
		return {
			kind: "unapplied",
			reason: `phpstan dump-parameters exited ${dump.status ?? "without a status"}`,
		};
	}
	let excludePaths: unknown;
	try {
		excludePaths = (
			JSON.parse(dump.stdout ?? "") as { excludePaths?: unknown } | null
		)?.excludePaths;
	} catch {
		// none: the failure is returned as `unapplied`, and the runner's `markUnanchored` records it and withholds the clean verdict.
		return {
			kind: "unapplied",
			reason: "phpstan dump-parameters printed no JSON",
		};
	}
	if (
		typeof excludePaths !== "object" ||
		excludePaths === null ||
		Array.isArray(excludePaths)
	) {
		return {
			kind: "unapplied",
			reason: "phpstan dump-parameters printed no excludePaths object",
		};
	}
	const lists: Record<"analyse" | "analyseAndScan", string[]> = {
		analyse: [],
		analyseAndScan: [],
	};
	let touched = false;
	for (const [name, entries] of Object.entries(excludePaths)) {
		if (name !== "analyse" && name !== "analyseAndScan") {
			return {
				kind: "unapplied",
				reason: `phpstan excludePaths has an unknown list ${JSON.stringify(name)}`,
			};
		}
		if (
			!Array.isArray(entries) ||
			!entries.every((entry) => typeof entry === "string")
		) {
			return {
				kind: "unapplied",
				reason: `phpstan excludePaths.${name} is not a list of strings`,
			};
		}
		for (const entry of entries as string[]) {
			const anchored = anchorIgnorePattern(entry, root, "fnmatch");
			if (anchored === null) {
				return {
					kind: "unapplied",
					reason: `excludePaths entry ${JSON.stringify(entry)} is not a form it can anchor`,
				};
			}
			if (anchored.length === 1 && anchored[0] === entry) {
				lists[name].push(/[*?[]/.test(entry) ? entry : `${entry} (?)`);
				continue;
			}
			touched = true;
			lists[name].push(...anchored);
		}
	}
	if (!touched) return { kind: "unchanged" };
	const block = (name: "analyse" | "analyseAndScan"): string =>
		lists[name].length === 0
			? `\t\t${name}: []\n`
			: `\t\t${name}:\n${lists[name].map((entry) => `\t\t\t- ${neonString(entry)}\n`).join("")}`;
	return {
		kind: "rewritten",
		text: `includes:\n\t- ${neonString(userConfig)}\nparameters:\n\texcludePaths!:\n${block("analyse")}${block("analyseAndScan")}`,
	};
}

const phpstanRunner: RunnerDefinition = {
	id: "phpstan",
	appliesTo: ["php"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	skipTestFiles: false,
	requiresConfig: (cwd) => hasToolConfig("phpstan", cwd),

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "phpstan");
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("phpstan")) {
			return skipped("not-preferred");
		}

		// Only run if phpstan config present — avoids noisy defaults on unconfigured projects
		if (!phpstanRunner.requiresConfig?.(cwd)) {
			return skipped("not-configured");
		}

		const lookup = (await resolvePhpstan(cwd)) ?? undefined;
		const cmd = localBinPath(lookup);
		// #5258: the vendor walk can refuse a `vendor/bin/phpstan` the checker
		// never looks up.
		if (!cmd)
			return toolAbsentSkip(cwd, {
				checker: phpstan,
				trustRefused: isLocalBinTrustRefusal(lookup),
			});

		const absPath = path.resolve(cwd, ctx.filePath);
		// #5594: phpstan matches a wildcard `excludePaths` entry against the
		// file's absolute path, so it reads a config with every such entry
		// anchored at the project root. phpstan reads a config from its working
		// directory only, never an ancestor.
		let anchored: AnchoredConfig = { kind: "unchanged" };
		const ownConfig = findToolConfig("phpstan", cwd, { ceiling: cwd })?.file;
		const read = ownConfig ? readConfigText("phpstan", ownConfig) : undefined;
		if (read?.kind === "unapplied") anchored = read;
		if (
			ownConfig &&
			read?.kind === "read" &&
			phpstanConfigMayExclude(read.text)
		) {
			const dump = await safeSpawnAsync(cmd, ["dump-parameters", "--json"], {
				cwd,
				timeout: PHPSTAN_DUMP_TIMEOUT_MS,
			});
			anchored = anchorPhpstanConfig(dump, path.resolve(cwd, ownConfig), cwd);
		}
		const analyse = (config: readonly string[]) =>
			safeSpawnAsync(
				cmd,
				["analyse", "--error-format=json", "--no-progress", ...config, absPath],
				{ timeout: 30000, cwd },
			);
		const result =
			anchored.kind === "rewritten"
				? await withOverlayFile(
						"phpstan",
						"phpstan.neon",
						anchored.text,
						(file) => analyse(["-c", file]),
					)
				: await analyse([]);

		// phpstan exits 0 = no errors, 1 = errors found, 2 = fatal. The fatal
		// case used to return `skipped` silently; routing it through the shared
		// seam keeps that verdict and adds the bounded `runner-empty-result` row
		// (#1816), and the exit-1 case now also records when the JSON report
		// parses to nothing (#1948) — the shape the error-count-as-array bug had.
		const run = parseToolRun(
			"phpstan",
			{ result, exitCodes: PHPSTAN_EXIT_CODES },
			(out) => parsePhpstanJson(out, ctx.filePath, cwd),
			{ parseOutput: result.stdout ?? "" },
		);
		if (run.skipped) return run.skipped;

		const diagnostics = run.diagnostics;
		const verdict = finishParsedRun({
			tool: "phpstan",
			ctx,
			result,
			diagnostics,
			classify: () => ({ status: "failed", semantic: "blocking" }),
		});
		return anchored.kind === "unapplied"
			? markUnanchored("phpstan", anchored.reason, verdict)
			: verdict;
	},
};

export default phpstanRunner;
