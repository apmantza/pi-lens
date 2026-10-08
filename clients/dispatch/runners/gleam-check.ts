import * as path from "node:path";
import { pathsEqual } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { stripAnsi } from "../../sanitize.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { findingsResult } from "../types.js";
import { PRIORITY } from "../priorities.js";

const gleam = createAvailabilityChecker("gleam", ".exe");

/**
 * gleam renders every located diagnostic through
 * `codespan_reporting::term::emit` (v1.18.1
 * `compiler-core/src/diagnostic.rs:92-133`, unchanged since v1.6.3), so its
 * location line is codespan's LOCUS line, not a bare `path:line:col`:
 *
 * ```text
 * error: Type mismatch
 *   ┌─ /abs/proj/src/app.gleam:1:8
 * ```
 *
 * `<outer gutter spaces> ┌─ <name>:<line>:<column>` —
 * codespan-reporting 0.13.1 `src/term/renderer.rs:379-396` (the gutter, then
 * `chars().snippet_start`, then one space, then the locus) and `:869-878`
 * (`{name}:{line_number}:{column_number}`), with `snippet_start` = `┌─` in the
 * default box-drawing set (`src/term/config.rs:419-429`, reached because gleam
 * passes `Config::default()`, whose display style is Rich).
 *
 * `name` is `location.path` verbatim (`diagnostic.rs:92-94`,
 * `files.add(main_location_path, …)`), and the CLI builds that path by walking
 * UP from the absolute `std::env::current_dir()` to the nearest `gleam.toml`
 * (`compiler-cli/src/fs.rs:32-62`) and joining `src`/`test`
 * (`compiler-core/src/paths.rs:42-48`) before enumerating the directory — so it
 * is ABSOLUTE, with host-native separators. Resolving it against the cwd the
 * tool ran in is therefore a no-op today and the ADR 0009 shape for the
 * hypothetical relative spelling.
 *
 * Capturing the path REQUIRES matching the gutter: the pre-#3285 regex
 * `/^(.+?):(\d+):(\d+)$/` captured `  ┌─ /abs/proj/src/app.gleam`, gutter
 * included, and only an `endsWith` compare tolerated that. An equality
 * predicate (the seam every other runner now uses) drops every gleam diagnostic
 * unless the gutter is out of the capture — which is why PR #3284 reverted its
 * own fold here and filed #3285.
 */
const GLEAM_LOCUS = /^\s*┌─\s+(.+?):(\d+):(\d+)$/;
const GLEAM_HEADER = /^\s*(error|warning):\s*(.+?)\s*$/;
const GLEAM_LABEL = /^\s*│\s*\^+\s*(.*?)\s*$/;

/** One codespan diagnostic: its title line, and every line up to the next title. */
type GleamBlock = { header: RegExpMatchArray; body: string[] };

/**
 * codespan writes ONE title line per diagnostic and then everything that
 * belongs to it — locus, borders, snippet, labels, notes — before the next
 * title (`codespan-reporting` 0.13.1 `src/term/renderer.rs:141-210`). Splitting
 * on the title is therefore the diagnostic boundary, and it is what keeps an
 * adjacent diagnostic's label out of its predecessor's message. Lines before
 * the first title are gleam's own progress output (`Compiling demo`), which
 * belongs to no diagnostic.
 */
function gleamBlocks(lines: string[]): GleamBlock[] {
	const blocks: GleamBlock[] = [];
	for (const line of lines) {
		const header = line.match(GLEAM_HEADER);
		if (header) blocks.push({ header, body: [] });
		else blocks.at(-1)?.body.push(line);
	}
	return blocks;
}

function gleamMessage(title: string, body: string[]): string {
	const labels = body.flatMap(
		(line) => line.match(GLEAM_LABEL)?.[1]?.trim() || [],
	);
	return labels.length > 0 ? `${title} — ${labels.join(" ")}` : title;
}

function parseGleamOutput(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const absTarget = path.resolve(cwd, filePath);
	// `stripAnsi` (the seam `ruff.ts`, `go-vet.ts` and `rust-clippy.ts` already
	// use): gleam colours the gutter whenever `FORCE_COLOR` is set non-empty,
	// whatever stderr is (`compiler-cli/src/cli.rs:194-207` — `ColorChoice::Never`
	// only when it is neither forced nor a terminal), and the SGR bytes sit
	// between the line start and `┌─`. The old suffix compare never saw the
	// prefix; an anchored capture would drop every diagnostic in that
	// environment.
	const lines = stripAnsi(raw).split(/\r?\n/);
	for (const { header, body } of gleamBlocks(lines)) {
		const severity = header[1] === "warning" ? "warning" : "error";
		const title = `${header[1]}: ${header[2]}`;
		// A Gleam diagnostic with NO locus describes the whole project: `check`
		// receives no file argument (`Diagnostic::write_title`, no codespan emit).
		// Leave it for the nonzero-without-diagnostics fallback instead of
		// charging it to whichever file happened to trigger dispatch — ADR 0009:
		// without a reported path there is no evidence it is about this file.
		const location = body
			.find((line) => GLEAM_LOCUS.test(line))
			?.match(GLEAM_LOCUS);
		if (!location) continue;
		const [, sourcePath, lineStr, colStr] = location;
		// #3278: one seam for reported-path attribution — see javac.ts.
		if (!pathsEqual(path.resolve(cwd, sourcePath.trim()), absTarget)) continue;
		diagnostics.push({
			id: `gleam-check-${lineStr}-${colStr}`,
			message: gleamMessage(title, body),
			filePath,
			line: Number.parseInt(lineStr, 10) || 1,
			column: Number.parseInt(colStr, 10) || 1,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "gleam",
			rule: "gleam-check",
			fixable: false,
		});
	}
	return diagnostics;
}

function firstOutputLine(result: { stdout?: string; stderr?: string }): string {
	return `${result.stderr || ""}\n${result.stdout || ""}`
		.trim()
		.split(/\r?\n/, 1)[0]
		.slice(0, 200);
}

const gleamCheckRunner: RunnerDefinition = {
	id: "gleam-check",
	appliesTo: ["gleam"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "gleam-check");
		if (!(await gleam.isAvailableAsync(cwd))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = gleam.getCommand(cwd)!;
		const result = await safeSpawnAsync(cmd, ["check"], {
			cwd,
			timeout: 30000,
		});

		if (result.error && !result.stdout && !result.stderr) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parseGleamOutput(
			`${result.stderr || ""}\n${result.stdout || ""}`,
			ctx.filePath,
			cwd,
		);
		if (diagnostics.length === 0) {
			if (result.status && result.status !== 0) {
				const message =
					firstOutputLine(result) ||
					"gleam check exited non-zero without structured diagnostics";
				return {
					status: "failed",
					diagnostics: [
						{
							id: "gleam-check-nonzero-no-diagnostics",
							message,
							filePath: ctx.filePath,
							severity: "error",
							semantic: "blocking",
							tool: "gleam",
							rule: "gleam-check",
							fixable: false,
						},
					],
					semantic: "blocking",
					failureKind: "unconfirmed_output",
					failureMessage: message.slice(0, 200),
				};
			}
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return findingsResult(diagnostics, {
			status: "failed",
			semantic: "blocking",
		});
	},
};

export default gleamCheckRunner;
