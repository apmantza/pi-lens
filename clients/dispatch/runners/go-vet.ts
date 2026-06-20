/**
 * Go vet runner for dispatch system
 *
 * Runs `go vet` for Go files to catch common mistakes.
 */

import { relative, resolve, sep, posix } from "node:path";

import { GoClient } from "../../go-client.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { stripAnsi } from "../../sanitize.js";
import { parseGoVetOutput } from "./utils/diagnostic-parsers.js";
import type {
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";

const goClient = new GoClient();

const goVetRunner: RunnerDefinition = {
	id: "go-vet",
	appliesTo: ["go"],
	priority: PRIORITY.SPECIALIZED_ANALYSIS,
	enabledByDefault: true,
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
		const cwd = ctx.cwd || process.cwd();
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
