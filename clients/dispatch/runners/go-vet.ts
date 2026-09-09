/**
 * Go vet runner for dispatch system
 *
 * Runs `go vet` for Go files to catch common mistakes.
 */

import { relative, resolve, sep, posix } from "node:path";

import { goClient } from "../../go-client.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { stripAnsi } from "../../sanitize.js";
import { skipUnlessToolRan } from "./utils/tool-failure.js";
import { parseGoVetOutput } from "./utils/diagnostic-parsers.js";
import type {
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";

const goVetRunner: RunnerDefinition = {
	id: "go-vet",
	appliesTo: ["go"],
	priority: PRIORITY.SPECIALIZED_ANALYSIS,
	timeoutMs: 40_000,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Resolve go path using platform-aware lookup (handles system install paths on Windows)
		const goExe = await goClient.findGoPathAsync();
		if (!goExe) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Vet the package containing the file from the module root.
		//
		// `go vet <one-file.go>` compiles that file in isolation, so same-package
		// symbols defined in sibling files read as false `undefined: X`, and when
		// the spawn cwd is outside the module the run also reports
		// `go.mod file not found` (#263). ctx.cwd is the go.mod module root
		// (resolveLanguageRootForFile, markers ["go.mod"]), so vet the file's
		// package from there.
		const cwd = resolveRunnerCwd(ctx, "go-vet");
		const fileRel = relative(cwd, ctx.filePath).split(sep).join(posix.sep);
		const pkgPath = fileRel.startsWith("../")
			? // File isn't under ctx.cwd (unexpected — ctx.cwd is the go.mod root).
				// Vet the root package as a safe fallback rather than emit `./../x`;
				// the filename filter below still prevents mis-attribution.
				"."
			: fileRel.includes("/")
				? "./" + fileRel.slice(0, fileRel.lastIndexOf("/"))
				: ".";

		const result = await safeSpawnAsync(goExe, ["vet", pkgPath], {
			timeout: 30000,
			cwd,
		});

		const raw = stripAnsi(result.stdout + result.stderr);

		// #1816: `go vet` exits nonzero both for "found problems" and for a
		// toolchain failure it never got past — `go.mod file not found in
		// current directory or any parent directory` is the one that bit us
		// (#263). That prose carries no `file:line:col:` prefix, so it parsed to
		// zero diagnostics and the file was reported CLEAN by a vet that never
		// ran. The exit code cannot separate the two cases; the presence of a
		// parsable diagnostic line can, so that is what the gate is handed.
		const parsableLines = raw
			.split("\n")
			.filter((line) => /^.+?:\d+:\d+:/.test(line))
			.join("\n");
		const skipped = skipUnlessToolRan("go-vet", {
			result,
			output: parsableLines,
		});
		if (skipped) return skipped;

		if (result.status === 0 && !raw.trim()) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// createLineParser ignores the output filename and attributes every
		// diagnostic to ctx.filePath, so keep only this file's lines — package
		// vetting reports siblings too. Resolve each output path against the vet
		// cwd before comparing, so go's path FORM (a leading `./` for the
		// module-root package, an absolute path, `.` segments) can't cause the
		// edited file's OWN diagnostics to be silently dropped.
		const absTarget = resolve(ctx.filePath);
		const relevant = raw
			.split("\n")
			.filter((line) => {
				const m = line.match(/^(.+?):(\d+):(\d+):\s*(.+)/);
				return m != null && resolve(cwd, m[1].trim()) === absTarget;
			})
			.join("\n");

		const diagnostics = parseGoVetOutput(relevant, ctx.filePath);

		// Edited file clean → succeeded: a sibling-file error no longer flags
		// the edited file's turn (it surfaces when that file is itself edited).
		return diagnostics.length > 0
			? { status: "failed", diagnostics, semantic: "warning" }
			: { status: "succeeded", diagnostics: [], semantic: "none" };
	},
};

export default goVetRunner;
