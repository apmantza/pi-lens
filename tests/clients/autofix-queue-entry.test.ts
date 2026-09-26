/**
 * #3506 review round 1 (F5): every fixer branch of `runAutofix` enters pi's
 * per-file mutation queue only once its tool is resolved, and before its
 * writer reads the file.
 *
 * - Above the resolver, an availability probe or an auto-install (120 s and
 *   more) would hold pi's own `edit`/`write` of the file back for its whole
 *   run (probe P-B).
 * - Below the writer's before-read, the fixer would read or write outside
 *   the hold, and could erase a queued agent edit (`FixerParallel`).
 *
 * One row per fixer branch. Each branch's resolver and writer are gated
 * doubles at the seams the branch calls; the branch code between them, the
 * hold and pi's queue are production. The policy and agreement lookups are
 * pinned to the row's tool, because this file is about where each branch
 * enters the queue, not which tool a project selects.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	holdFileMutationQueue,
	setHostFileMutationQueueLoader,
} from "../../clients/file-mutation-queue.js";
import { setupTestEnvironment } from "./test-utils.js";

function gate() {
	let open!: () => void;
	const p = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { p, open };
}

const fixer = vi.hoisted(() => ({
	tool: "",
	/** The resolver runs; opens `resolving`, waits for `resolved`. */
	async resolve(): Promise<void> {
		fixer.gates.resolving.open();
		await fixer.gates.resolved.p;
	},
	/** The writer runs; opens `writing`, waits for `written`. */
	async write(): Promise<void> {
		fixer.gates.writing.open();
		await fixer.gates.written.p;
	},
	gates: {} as Record<
		"resolving" | "resolved" | "writing" | "written",
		{ p: Promise<void>; open: () => void }
	>,
}));

vi.mock("../../clients/tool-policy.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/tool-policy.js")>();
	const policy = () => ({
		toolNames: [fixer.tool],
		preferredTools: [fixer.tool],
		defaultTool: fixer.tool,
		defaultWhenUnconfigured: true,
		gate: "smart-default",
		safe: true,
	});
	return {
		...actual,
		getAutofixPolicyForFile: policy,
		getPreferredAutofixTools: () => [fixer.tool],
		// tryEslintFix's own config gate.
		hasEslintConfig: () => true,
	};
});
vi.mock("../../clients/tool-agreement.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/tool-agreement.js")>()),
	establishToolAgreement: () => ({ decision: "established" }),
}));
vi.mock(
	"../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../clients/dispatch/runners/utils/runner-helpers.js")
			>();
		return {
			...actual,
			resolveToolCommandWithInstallFallback: async () => {
				await fixer.resolve();
				return "fixer-cmd";
			},
			resolveCommandArgsWithInstallFallback: async () => {
				await fixer.resolve();
				return { cmd: "fixer-cmd", args: [] };
			},
			resolveAvailableOrInstall: async () => {
				await fixer.resolve();
				return "fixer-cmd";
			},
			createAvailabilityChecker: (
				...args: Parameters<typeof actual.createAvailabilityChecker>
			) => {
				const real = actual.createAvailabilityChecker(...args);
				if (args[0] !== "detekt") return real;
				return {
					...real,
					isAvailableAsync: async () => {
						await fixer.resolve();
						return true;
					},
					getCommand: () => "detekt",
				};
			},
		};
	},
);
vi.mock("../../clients/dispatch/runners/detekt.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/dispatch/runners/detekt.js")
	>()),
	findDetektConfig: () => "detekt.yml",
}));
vi.mock("../../clients/file-utils.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/file-utils.js")>()),
	detectFileChangedAfterCommand: async () => {
		await fixer.write();
		return 0;
	},
}));
// eslint's `--version` probe is its resolver; cargo's and dart's fix runs are
// their writers.
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync: async (_cmd: string, args: readonly string[]) => {
		if (args[0] === "--version") await fixer.resolve();
		else await fixer.write();
		return { status: 0, stdout: "1.0.0", stderr: "", error: undefined };
	},
}));
vi.mock("../../clients/tool-probe.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/tool-probe.js")>()),
	probeToolAsync: async () => {
		await fixer.resolve();
		return { status: 0, stdout: "1.0.0", stderr: "", error: undefined };
	},
}));

import { runAutofix } from "../../clients/pipeline.js";

/** The biome and ruff branches resolve and write through their clients. */
const clients = {
	biomeClient: {
		isSupportedFile: () => true,
		ensureAvailable: async () => {
			await fixer.resolve();
			return true;
		},
		fixFileAsync: async () => {
			await fixer.write();
			return { success: true, changed: false, fixed: 0 };
		},
	},
	ruffClient: {
		isPythonFile: () => true,
		ensureAvailable: async () => {
			await fixer.resolve();
			return true;
		},
		fixFileAsync: async () => {
			await fixer.write();
			return { success: true, changed: false, fixed: 0 };
		},
	},
};

/** Every fixer branch of runAutofix (clients/pipeline.ts). */
const FIXER_BRANCHES = [
	"ruff",
	"biome",
	"eslint",
	"stylelint",
	"sqlfluff",
	"rubocop",
	"ktlint",
	"rust-clippy",
	"dart-analyze",
	"golangci-lint",
	"detekt",
	"ktfmt",
	"markdownlint",
	"oxlint",
];

describe("each autofix branch enters pi's queue between its resolver and its writer (#3506 r1 F5)", () => {
	beforeEach(() => {
		fixer.gates = {
			resolving: gate(),
			resolved: gate(),
			writing: gate(),
			written: gate(),
		};
		setHostFileMutationQueueLoader(async () => ({ withFileMutationQueue }));
	});
	afterEach(() => {
		setHostFileMutationQueueLoader(undefined);
	});

	it.each(FIXER_BRANCHES)(
		"%s: the agent's edit lands while the tool resolves, and waits while it writes",
		async (tool) => {
			fixer.tool = tool;
			const env = setupTestEnvironment("pi-lens-autofix-queue-entry-");
			try {
				// clippy and dart run at their package root.
				fs.writeFileSync(path.join(env.tmpDir, "Cargo.toml"), "");
				fs.writeFileSync(path.join(env.tmpDir, "pubspec.yaml"), "");
				const filePath = path.join(env.tmpDir, "a.src");
				fs.writeFileSync(filePath, "a\n");
				const agentAppend = (line: string) => {
					let wrote = false;
					const done = withFileMutationQueue(filePath, async () => {
						fs.appendFileSync(filePath, line);
						wrote = true;
					});
					return { done, wrote: () => wrote };
				};
				// Resolves once every queue call made before it has registered.
				const barrier = () =>
					withFileMutationQueue(
						path.join(env.tmpDir, "barrier"),
						async () => {},
					);

				const hold = holdFileMutationQueue(filePath);
				const run = runAutofix(
					filePath,
					env.tmpDir,
					() => false,
					() => {},
					{ ...clients, fixedThisTurn: new Set<string>() } as never,
					undefined,
					hold,
				);
				await fixer.gates.resolving.p;
				const whileResolving = agentAppend("resolving\n");
				await barrier();
				expect(whileResolving.wrote()).toBe(true);

				fixer.gates.resolved.open();
				await fixer.gates.writing.p;
				const whileWriting = agentAppend("writing\n");
				await barrier();
				expect(whileWriting.wrote()).toBe(false);

				fixer.gates.written.open();
				await run;
				hold?.release();
				await whileWriting.done;
				expect(fs.readFileSync(filePath, "utf8")).toBe(
					"a\nresolving\nwriting\n",
				);
			} finally {
				env.cleanup();
			}
		},
	);
});
