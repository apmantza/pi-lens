import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyConservativeActionableWarningFixes,
	buildActionableWarningsReport,
	type ActionableWarningsReport,
} from "../../clients/actionable-warnings.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { CacheManager } from "../../clients/cache-manager.js";
import { applyWorkspaceEdit } from "../../clients/lsp/edits.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";
import { normalizeMapKey } from "../../clients/path-utils.js";

const codeAction = vi.fn(async () => [
	{
		title: "Fix it",
		kind: "quickfix",
		isPreferred: true,
		edit: {
			changes: {},
		},
	},
]);
const getLastKnownDiagnostics = vi.fn(
	(): import("../../clients/lsp/client.js").LSPDiagnostic[] | undefined =>
		undefined,
);
const fakeService = makeLspServiceDouble({
	supportsLSP: () => true,
	openFile: async () => undefined,
	codeAction,
	getLastKnownDiagnostics,
});

vi.mock("../../clients/lsp/capabilities.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/lsp/capabilities.js")
	>()),
	getLSPService: () => fakeService,
}));

function report(filePath: string): ActionableWarningsReport {
	return {
		generatedAt: new Date().toISOString(),
		scope: "turn_delta",
		sessionId: "agreement-test",
		turnIndex: 1,
		projectSeqEnd: 1,
		deltaOnly: true,
		includeLspCodeActions: true,
		files: [
			{
				filePath,
				displayPath: path.basename(filePath),
				warnings: [
					{
						id: "eslint:fix",
						filePath,
						displayPath: path.basename(filePath),
						line: 1,
						column: 1,
						severity: "warning",
						tool: "eslint",
						message: "fixable warning",
						actions: [
							{
								title: "Fix it",
								hasEdit: true,
								hasCommand: false,
								autoFixEligible: true,
							},
						],
						suppressed: false,
						origin: "lsp",
					},
				],
			},
		],
		summary: {} as ActionableWarningsReport["summary"],
	};
}

describe("actionable warning quickfix agreement (#3005)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-actionable-agreement-");
		resetDegradationLedger();
		codeAction.mockClear();
		getLastKnownDiagnostics.mockReset();
		fs.writeFileSync(
			path.join(env.tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { eslint: "^9.0.0" } }),
		);
		fs.writeFileSync(
			path.join(env.tmpDir, "package-lock.json"),
			JSON.stringify({
				packages: { "node_modules/eslint": { version: "8.0.0" } },
			}),
		);
	});
	afterEach(() => env.cleanup());

	async function buildLspReport(
		filePath: string,
		source: string | undefined,
		serverId = "typescript",
	): Promise<ActionableWarningsReport> {
		getLastKnownDiagnostics.mockReturnValue([
			{
				severity: 2,
				message: "replace this value",
				code: "fix-value",
				source,
				serverId,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 5 },
				},
			},
		]);
		return buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "agreement-test",
			turnIndex: 1,
			files: [filePath],
			modifiedRangesByFile: new Map([
				[normalizeMapKey(filePath), [{ start: 1, end: 1 }]],
			]),
			dispatchWarnings: [],
			includeLspCodeActions: true,
		});
	}

	function workspaceEdit(filePath: string) {
		return {
			changes: {
				[pathToFileURL(filePath).href]: [
					{
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 5 },
						},
						newText: "const",
					},
				],
			},
		};
	}

	it("falls back to a known LSP serverId before applying its workspace edit", async () => {
		// #3005: removing the serverId fallback must make this production-path
		// quickfix decline instead of silently using generic `lsp`.
		const filePath = path.join(env.tmpDir, "server-id-app.ts");
		fs.writeFileSync(filePath, "value = 1;\n");
		fs.writeFileSync(
			path.join(env.tmpDir, "package-lock.json"),
			JSON.stringify({
				packages: { "node_modules/eslint": { version: "9.0.0" } },
			}),
		);
		codeAction.mockImplementation(async () => [
			{
				title: "Fix it",
				kind: "quickfix",
				isPreferred: true,
				autoFixEligible: true,
				hasEdit: true,
				hasCommand: false,
				edit: workspaceEdit(filePath),
			},
		]);

		const built = await buildLspReport(filePath, "lsp", "eslint");
		expect(built.files[0]?.warnings[0]?.tool).toBe("eslint");
		const result = await applyConservativeActionableWarningFixes({
			cwd: env.tmpDir,
			report: built,
		});

		expect(result.applied).toBe(1);
		expect(fs.readFileSync(filePath, "utf8")).toBe("const = 1;\n");
	});

	it("declines an unsupported serverId fallback with bounded degradation evidence", async () => {
		// #3005: unknown server identities remain fail-closed when source is the
		// generic LSP label and an otherwise valid edit is offered.
		const filePath = path.join(env.tmpDir, "unknown-server-app.ts");
		fs.writeFileSync(filePath, "value = 1;\n");
		codeAction.mockImplementation(async () => [
			{
				title: "Fix it",
				kind: "quickfix",
				isPreferred: true,
				autoFixEligible: true,
				hasEdit: true,
				hasCommand: false,
				edit: workspaceEdit(filePath),
			},
		]);

		const built = await buildLspReport(filePath, "lsp", "unknown-lsp-server");
		expect(built.files[0]?.warnings[0]?.tool).toBe("unknown-lsp-server");
		const result = await applyConservativeActionableWarningFixes({
			cwd: env.tmpDir,
			report: built,
		});

		expect(result.applied).toBe(0);
		expect(result.skipped[0]?.reason).toBe("tool_agreement_unavailable");
		expect(fs.readFileSync(filePath, "utf8")).toBe("value = 1;\n");
		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({
				kind: "autofix-agreement-unavailable",
				latestReasons: [
					expect.objectContaining({ subject: "tool:unknown-lsp-server" }),
				],
			}),
		]);
	});

	it("uses a real LSP producer identity before applying its workspace edit", async () => {
		const filePath = path.join(env.tmpDir, "app.ts");
		fs.writeFileSync(filePath, "value = 1;\n");
		fs.writeFileSync(
			path.join(env.tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { eslint: "^9.0.0" } }),
		);
		fs.writeFileSync(
			path.join(env.tmpDir, "package-lock.json"),
			JSON.stringify({
				packages: { "node_modules/eslint": { version: "9.0.0" } },
			}),
		);
		codeAction.mockImplementation(async () => [
			{
				title: "Fix it",
				kind: "quickfix",
				isPreferred: true,
				autoFixEligible: true,
				hasEdit: true,
				hasCommand: false,
				edit: workspaceEdit(filePath),
			},
		]);

		const built = await buildLspReport(filePath, "eslint");
		expect(built.files[0]?.warnings[0]?.tool).toBe("eslint");
		const result = await applyConservativeActionableWarningFixes({
			cwd: env.tmpDir,
			report: built,
		});

		expect(result.applied).toBe(1);
		expect(fs.readFileSync(filePath, "utf8")).toBe("const = 1;\n");
	});

	it("declines an unknown LSP producer before applying its workspace edit", async () => {
		const filePath = path.join(env.tmpDir, "app.ts");
		fs.writeFileSync(filePath, "value = 1;\n");
		codeAction.mockImplementation(async () => [
			{
				title: "Fix it",
				kind: "quickfix",
				isPreferred: true,
				autoFixEligible: true,
				hasEdit: true,
				hasCommand: false,
				edit: workspaceEdit(filePath),
			},
		]);

		const built = await buildLspReport(filePath, "unknown-lsp-producer");
		const result = await applyConservativeActionableWarningFixes({
			cwd: env.tmpDir,
			report: built,
		});

		expect(result.applied).toBe(0);
		expect(result.skipped[0]?.reason).toBe("tool_agreement_unavailable");
		expect(fs.readFileSync(filePath, "utf8")).toBe("value = 1;\n");
	});

	it("declines the autonomous quickfix before applying its workspace edit", async () => {
		const filePath = path.join(env.tmpDir, "app.ts");
		fs.writeFileSync(filePath, "const value = 1;\n");
		const result = await applyConservativeActionableWarningFixes({
			cwd: env.tmpDir,
			report: report(filePath),
		});

		expect(result.applied).toBe(0);
		expect(result.skipped).toEqual([
			{ id: "eslint:fix", reason: "tool_agreement_unavailable" },
		]);
		expect(codeAction).not.toHaveBeenCalled();
		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({
				kind: "autofix-agreement-unavailable",
				latestReasons: [expect.objectContaining({ subject: "node:eslint" })],
			}),
		]);
	});
});

describe("#3576: a quickfix pass whose session was replaced", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-3576-quickfix-");
		resetDegradationLedger();
		codeAction.mockReset();
		fs.writeFileSync(
			path.join(env.tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { eslint: "^9.0.0" } }),
		);
		fs.writeFileSync(
			path.join(env.tmpDir, "package-lock.json"),
			JSON.stringify({
				packages: { "node_modules/eslint": { version: "9.0.0" } },
			}),
		);
	});
	afterEach(() => env.cleanup());

	function quickfix(filePath: string) {
		return {
			title: "Fix it",
			kind: "quickfix",
			isPreferred: true,
			edit: {
				changes: {
					[pathToFileURL(filePath).href]: [
						{
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 5 },
							},
							newText: "const",
						},
					],
				},
			},
		};
	}

	/** One eligible eslint warning per file, in order. */
	function twoFileReport(files: string[]): ActionableWarningsReport {
		const base = report(files[0]!);
		return {
			...base,
			files: files.map((filePath, index) => ({
				filePath,
				displayPath: path.basename(filePath),
				warnings: [
					{
						...base.files[0]!.warnings[0]!,
						id: `eslint:fix:${index}`,
						filePath,
						displayPath: path.basename(filePath),
					},
				],
			})),
		};
	}

	/** The drain's mutation context over a real runtime and its session. */
	function drainContext(runtime: RuntimeCoordinator, cache: CacheManager) {
		return {
			cwd: env.tmpDir,
			correlationId: "3576-quickfix",
			tool: "lsp-quickfix",
			source: "autofix" as const,
			runtime,
			cacheManager: cache,
			readGuard: runtime.readGuard,
			session: runtime.captureSessionGeneration(),
		};
	}

	function files(): string[] {
		return ["a.ts", "b.ts"].map((name) => {
			const filePath = path.join(env.tmpDir, name);
			fs.writeFileSync(filePath, "value = 1;\n");
			return filePath;
		});
	}

	it("applies no edit it had not started when /new lands during its code-action request", async () => {
		const [a, b] = files();
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = env.tmpDir;
		let entered!: () => void;
		const parked = new Promise<void>((r) => (entered = r));
		let release!: () => void;
		const released = new Promise<void>((r) => (release = r));
		codeAction.mockImplementation((async (fp: string) => {
			if (fp === a) {
				entered();
				await released;
			}
			return [quickfix(fp)];
		}) as never);
		const pass = applyConservativeActionableWarningFixes({
			cwd: env.tmpDir,
			report: twoFileReport([a!, b!]),
			mutationContext: drainContext(runtime, new CacheManager(false)),
		});
		await parked;
		runtime.resetForSession();
		release();
		const result = await pass;
		expect(result.applied).toBe(0);
		expect(result.skipped).toEqual([
			{ id: "eslint:fix:0", reason: "session_replaced" },
			{ id: "eslint:fix:1", reason: "session_replaced" },
		]);
		expect(fs.readFileSync(a!, "utf8")).toBe("value = 1;\n");
		expect(fs.readFileSync(b!, "utf8")).toBe("value = 1;\n");
	});

	it("no-drop (shape 54): a pass that stays in its session applies every edit", async () => {
		const [a, b] = files();
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = env.tmpDir;
		codeAction.mockImplementation((async (fp: string) => [
			quickfix(fp),
		]) as never);
		const result = await applyConservativeActionableWarningFixes({
			cwd: env.tmpDir,
			report: twoFileReport([a!, b!]),
			mutationContext: drainContext(runtime, new CacheManager(false)),
		});
		expect(result.applied).toBe(2);
		expect(fs.readFileSync(a!, "utf8")).toBe("const = 1;\n");
		expect(runtime.getFileSeq(a!)).toBe(1);
		expect(runtime.getFileSeq(b!)).toBe(1);
	});

	it("an edit already writing when /new lands completes, keeps its disk facts, and its session bookkeeping stays out of the next session", async () => {
		const [a] = files();
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = env.tmpDir;
		const cache = new CacheManager(false);
		const addModifiedRange = vi.spyOn(cache, "addModifiedRange");
		const recordAutofix = vi.fn();
		const applying = applyWorkspaceEdit(quickfix(a!).edit, env.tmpDir, {
			mutationContext: { ...drainContext(runtime, cache), recordAutofix },
		});
		// The write is in flight (its first await); the next session starts.
		runtime.resetForSession();
		await applying;
		expect(fs.readFileSync(a!, "utf8")).toBe("const = 1;\n");
		// #3763 r2: the bytes changed, so the file's seq and the change log say
		// so (I5); only the session's own state (turn state) is dropped.
		expect(runtime.getFileSeq(a!)).toBe(1);
		expect(runtime.projectSeq).toBe(1);
		expect(addModifiedRange).not.toHaveBeenCalled();
		// The turn summary is the session's own state too.
		expect(recordAutofix).not.toHaveBeenCalled();
		expect(
			getDegradationSummary()
				.filter((group) => group.kind === "generation-guard-stale-write")
				.flatMap((group) => group.latestReasons.map((r) => r.subject)),
		).toEqual([`runtime-session:${a}`]);
	});

	it("no-drop (shape 54): an edit in its own session records its bookkeeping", async () => {
		const [a] = files();
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = env.tmpDir;
		const cache = new CacheManager(false);
		const addModifiedRange = vi.spyOn(cache, "addModifiedRange");
		await applyWorkspaceEdit(quickfix(a!).edit, env.tmpDir, {
			mutationContext: drainContext(runtime, cache),
		});
		expect(runtime.getFileSeq(a!)).toBe(1);
		expect(addModifiedRange).toHaveBeenCalledTimes(1);
	});
});
