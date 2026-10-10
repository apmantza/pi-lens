import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { formatDiagnostics } from "../../../../clients/dispatch/utils/format-utils.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();
let available = true;

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	safeSpawnAsync,
}));
vi.mock("../../../../clients/tool-probe.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	probeToolAsync: vi.fn(async () => ({
		error: new Error("unavailable"),
		status: null,
	})),
}));
vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<Record<string, unknown>>()),
		createAvailabilityChecker: (command: string) => ({
			isAvailable: () => available,
			isAvailableAsync: async () => available,
			getCommand: () => command,
		}),
	}),
);

type Tool = "javac" | "dotnet-build";
type SpawnResult = {
	error?: Error | null;
	status: number | null;
	signal?: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

async function dispatchOutcome(
	tool: Tool,
	name: string,
	result: SpawnResult | ((filePath: string) => SpawnResult),
) {
	vi.resetModules();
	const env = setupTestEnvironment(`pi-lens-${tool}-${name}-`);
	try {
		const extension = tool === "javac" ? "Main.java" : "Main.cs";
		const filePath = path.join(env.tmpDir, extension);
		fs.writeFileSync(filePath, "class Main { static void main() {} }\n");
		if (tool === "dotnet-build")
			fs.writeFileSync(path.join(env.tmpDir, "Main.csproj"), "<Project />\n");
		safeSpawnAsync.mockResolvedValue(
			available
				? typeof result === "function"
					? result(filePath)
					: result
				: {
						error: new Error("unavailable"),
						status: null,
						stdout: "",
						stderr: "",
					},
		);
		const { createDispatchContext, dispatchForFile, RunnerRegistry } =
			await import("../../../../clients/dispatch/dispatcher.js");
		const runner = (
			await import(`../../../../clients/dispatch/runners/${tool}.js`)
		).default;
		const { getDegradationSummary, resetDegradationLedger } =
			await import("../../../../clients/degradation-ledger.js");
		resetDegradationLedger();
		const registry = new RunnerRegistry();
		registry.register(runner);
		let observed: {
			status?: string;
			semantic?: string;
			diagnostics: unknown[];
		} = {
			diagnostics: [],
		};
		const output = await dispatchForFile(
			createDispatchContext(
				filePath,
				env.tmpDir,
				{ getFlag: () => false },
				new FactStore(),
			),
			[{ mode: "all", runnerIds: [tool] }],
			registry,
			(_id, result) => {
				observed = {
					status: result.status,
					semantic: result.semantic,
					diagnostics: result.diagnostics,
				};
			},
		);
		return {
			...observed,
			output: output.output,
			ledger: getDegradationSummary(),
		};
	} finally {
		env.cleanup();
	}
}

async function dispatchTwoEmptyFiles(tool: Tool): Promise<unknown[]> {
	vi.resetModules();
	const env = setupTestEnvironment(`pi-lens-${tool}-ledger-`);
	try {
		const extension = tool === "javac" ? "java" : "cs";
		const files = ["First", "Second"].map((name) =>
			path.join(env.tmpDir, `${name}.${extension}`),
		);
		for (const filePath of files) fs.writeFileSync(filePath, "class Main {}\n");
		if (tool === "dotnet-build")
			fs.writeFileSync(path.join(env.tmpDir, "Main.csproj"), "<Project />\n");
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 1,
			stdout: "",
			stderr: "",
		});
		const { createDispatchContext, dispatchForFile, RunnerRegistry } =
			await import("../../../../clients/dispatch/dispatcher.js");
		const runner = (
			await import(`../../../../clients/dispatch/runners/${tool}.js`)
		).default;
		const { getDegradationSummary, resetDegradationLedger } =
			await import("../../../../clients/degradation-ledger.js");
		resetDegradationLedger();
		const registry = new RunnerRegistry();
		registry.register(runner);
		for (const filePath of files)
			await dispatchForFile(
				createDispatchContext(
					filePath,
					env.tmpDir,
					{ getFlag: () => false },
					new FactStore(),
				),
				[{ mode: "all", runnerIds: [tool] }],
				registry,
			);
		return getDegradationSummary();
	} finally {
		env.cleanup();
	}
}

function findings(tool: Tool, filePath: string): string {
	return tool === "javac"
		? `${filePath}:4: error: broken expression`
		: `${filePath}(4,2): error CS1002: broken expression`;
}

describe("compiler runner outcome seam (#1816)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		available = true;
	});

	for (const tool of ["javac", "dotnet-build"] as const) {
		it.each([
			["status 0 clean", { status: 0, stdout: "", stderr: "" }],
			[
				"status 0 stderr noise",
				{ status: 0, stdout: "", stderr: "compiler banner" },
			],
		])(`${tool}: %s stays clean through dispatch`, async (_name, result) => {
			const observed = await dispatchOutcome(tool, "clean", {
				error: null,
				...result,
			});
			expect(observed.status).toBe("succeeded");
			expect(observed.diagnostics).toEqual([]);
			expect(observed.ledger).toEqual([]);
		});

		it(`${tool}: preserves nonzero valid findings through dispatch`, async () => {
			const observed = await dispatchOutcome(tool, "findings", (filePath) => ({
				error: null,
				status: 1,
				stdout: "",
				stderr: findings(tool, filePath),
			}));
			expect(observed.status).toBe("failed");
			expect(observed.diagnostics).toHaveLength(1);
		});

		it(`${tool}: nonzero empty output is skipped and ledgered`, async () => {
			const observed = await dispatchOutcome(tool, "empty", {
				error: null,
				status: 1,
				stdout: "",
				stderr: "",
			});
			expect(observed.status).toBe("skipped");
			expect(observed.output).toContain("not a clean result");
			expect(observed.ledger[0]?.kind).toBe("runner-empty-result");
		});

		it.each([
			["unparseable stdout", { stdout: "compiler exploded", stderr: "" }],
			["stderr-only", { stdout: "", stderr: "compiler exploded" }],
		])(`${tool}: %s is a parse error`, async (_name, streams) => {
			const observed = await dispatchOutcome(tool, "parse-error", {
				error: null,
				status: 1,
				...streams,
			});
			expect(observed.status).toBe("failed");
			expect(observed.diagnostics[0]).toMatchObject({
				id: `${tool}:parse-error:1`,
			});
			expect(observed.ledger[0]?.kind).toBe("runner-parsed-nothing");
		});

		it(`${tool}: signal termination is not succeeded`, async () => {
			const observed = await dispatchOutcome(tool, "signal", {
				error: null,
				status: null,
				signal: "SIGTERM",
				stdout: "",
				stderr: "",
			});
			expect(observed.status).toBe("skipped");
			expect(observed.ledger[0]?.latestReasons[0]?.reason).toContain("SIGTERM");
		});

		it(`${tool}: unavailable is skipped without spawning`, async () => {
			available = false;
			const observed = await dispatchOutcome(tool, "unavailable", {
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});
			expect(observed.status).toBe("skipped");
			expect(observed.ledger).toEqual([]);
		});

		it(`${tool}: rejected invocation is a parse error`, async () => {
			const observed = await dispatchOutcome(tool, "rejected", {
				error: null,
				status: 2,
				stdout: "",
				stderr: "unknown option",
			});
			expect(observed.status).toBe("failed");
			expect(observed.diagnostics[0]).toMatchObject({
				id: `${tool}:parse-error:1`,
			});
		});

		it(`${tool}: renders the shared witness text`, async () => {
			const observed = await dispatchOutcome(tool, "witness", (filePath) => ({
				error: null,
				status: 1,
				stdout: "",
				stderr: findings(tool, filePath),
			}));
			const golden = fs.readFileSync(
				path.resolve(
					"tests/fixtures/witness/runner-outcome-javac-dotnet-build",
					`${tool}-rendered.txt`,
				),
				"utf8",
			);
			expect(
				formatDiagnostics(observed.diagnostics as never[], "blocking"),
			).toBe(golden);
		});

		it(`${tool}: bounds empty-result to one ledger row across two files`, async () => {
			const ledger = await dispatchTwoEmptyFiles(tool);
			expect(ledger).toHaveLength(1);
			expect(ledger[0]).toMatchObject({
				kind: "runner-empty-result",
				count: 2,
			});
		});
	}
});
