import * as path from "node:path";
import { ensureTool } from "../../installer/index.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";

const taplo = createAvailabilityChecker("taplo", ".exe");

interface TaploError {
	range?: { start: { line: number; col: number } };
	message: string;
	kind: string;
}

interface TaploResult {
	errors?: TaploError[];
}

function parseTaploOutput(raw: string, filePath: string): Diagnostic[] {
	try {
		const parsed = JSON.parse(raw) as TaploResult;
		const errors = parsed.errors ?? [];

		return errors.map((err, idx) => ({
			id: `taplo-${err.kind}-${err.range?.start.line ?? idx}`,
			message: `[${err.kind}] ${err.message}`,
			filePath,
			line: (err.range?.start.line ?? 0) + 1,
			column: (err.range?.start.col ?? 0) + 1,
			severity: "error" as const,
			semantic: "blocking" as const,
			tool: "taplo",
			rule: err.kind,
			fixable: false,
		}));
	} catch {
		return [];
	}
}

const taploRunner: RunnerDefinition = {
	id: "taplo",
	appliesTo: ["toml"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		let cmd: string | null = null;
		if (taplo.isAvailable(cwd)) {
			cmd = taplo.getCommand(cwd);
		} else {
			const managed = await ensureTool("taplo");
			if (managed) cmd = managed;
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(
			cmd,
			["check", "--output=json", absPath],
			{ cwd, timeout: 15000 },
		);

		if (result.error && !result.stdout) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parseTaploOutput(result.stdout || "", ctx.filePath);
		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return { status: "failed", diagnostics, semantic: "blocking" };
	},
};

export default taploRunner;
