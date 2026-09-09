import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerGroup } from "../../../../clients/dispatch/types.js";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	safeSpawnAsync,
}));

// The eslint runner resolves its binary and probes availability through
// runner-helpers; both are environment, not behavior under test (#448). The
// probe stub answers available so every case reaches the spawn seam.
vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")>()),
	resolveToolCommand: vi.fn(() => "eslint"),
	createCwdCachedProbe: vi.fn(() => {
		const probe = async () => true;
		(probe as unknown as Record<string, unknown>).getVerdict = () => ({
			outcome: "available",
			classification: "probe-success",
		});
		(probe as unknown as Record<string, unknown>).reset = () => {};
		return probe;
	}),
}));

// hasEslintConfig walks the real filesystem for config files; the tests plant
// their own workspaces without one. Force the gate open — config discovery is
// not what this suite tests.
vi.mock("../../../../clients/tool-policy.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	hasEslintConfig: vi.fn(() => true),
}));

function createCtx(filePath: string, cwd: string) {
	return makeRunnerCtx(filePath, cwd);
}

describe("eslint runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	it("reports exit-0 warning findings instead of discarding them (#1954)", async () => {
		const env = setupTestEnvironment("pi-lens-eslint-warning-exit-zero-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const unused = 1;\n");

			// ESLint exits 0 whenever no rule reaches ERROR severity
			// (--max-warnings unset), so a warnings-only report arrives at
			// exit 0 with a full JSON payload on stdout.
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: JSON.stringify([
					{
						filePath,
						messages: [
							{
								ruleId: "no-unused-vars",
								severity: 1,
								message: "'unused' is assigned a value but never used.",
								line: 1,
								column: 7,
								fix: { range: [0, 17], text: "" },
							},
						],
						errorCount: 0,
						warningCount: 1,
					},
				]),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/eslint.js")
			).default;
			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.diagnostics).toHaveLength(1);
			expect(result.semantic).toBe("warning");
			expect(result.status).toBe("succeeded");
			expect(result.diagnostics[0]).toMatchObject({
				tool: "eslint",
				rule: "no-unused-vars",
				severity: "warning",
				semantic: "warning",
			});
		} finally {
			env.cleanup();
		}
	});

	it("a warning-only exit-0 run still stops plan.ts's jsts fallback group at eslint (#1954)", async () => {
		const env = setupTestEnvironment("pi-lens-eslint-fallback-stop-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const unused = 1;\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: JSON.stringify([
					{
						filePath,
						messages: [
							{
								ruleId: "no-unused-vars",
								severity: 1,
								message: "'unused' is assigned a value but never used.",
								line: 1,
								column: 7,
							},
						],
						errorCount: 0,
						warningCount: 1,
					},
				]),
				stderr: "",
			});

			const eslintRunner = (
				await import("../../../../clients/dispatch/runners/eslint.js")
			).default;
			const { dispatchForFile, RunnerRegistry } =
				await import("../../../../clients/dispatch/dispatcher.js");

			// plan.ts's real jsts lint group is a fallback chain:
			// ["eslint", "oxlint", "biome-check-json"]. A warning-only exit-0
			// result must keep status "succeeded" (keyed off blocking severity +
			// exit code, the sibling convention from #1947's review) so the chain
			// still stops at eslint — otherwise oxlint and biome-check-json would
			// re-run on the same file: extra spawns, a possible install,
			// duplicate findings.
			let downstreamRuns = 0;
			const registry = new RunnerRegistry();
			registry.register({ ...eslintRunner, priority: 1 });
			for (const id of ["oxlint", "biome-check-json"]) {
				registry.register({
					id,
					appliesTo: ["jsts"],
					priority: id === "oxlint" ? 2 : 3,
					async run() {
						downstreamRuns++;
						return { status: "succeeded", diagnostics: [], semantic: "none" };
					},
				});
			}

			const groups: RunnerGroup[] = [
				{
					mode: "fallback",
					runnerIds: ["eslint", "oxlint", "biome-check-json"],
				},
			];
			const result = await dispatchForFile(
				createCtx(filePath, env.tmpDir) as never,
				groups,
				registry,
			);

			expect(downstreamRuns).toBe(0);
			expect(result.warnings.some((w) => w.tool === "eslint")).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("keeps reporting exit-1 error findings as blocking", async () => {
		const env = setupTestEnvironment("pi-lens-eslint-error-exit-one-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "debugger;\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: JSON.stringify([
					{
						filePath,
						messages: [
							{
								ruleId: "no-debugger",
								severity: 2,
								message: "Unexpected 'debugger' statement.",
								line: 1,
								column: 1,
							},
						],
						errorCount: 1,
						warningCount: 0,
					},
				]),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/eslint.js")
			).default;
			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]).toMatchObject({
				tool: "eslint",
				rule: "no-debugger",
				severity: "error",
				semantic: "blocking",
			});
		} finally {
			env.cleanup();
		}
	});

	it("does not parse stderr noise on a healthy exit-0 run (#1954 review P3)", async () => {
		const env = setupTestEnvironment("pi-lens-eslint-stderr-gating-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "export const ok = 1;\n");

			// Exit 0 with empty stdout and deprecation-style chatter on stderr.
			// The old `stdout || stderr` fallback would feed that prose to the
			// JSON parser and fabricate a parse-error finding on a clean save;
			// stderr only feeds the parser when a FAILING run's stdout went
			// missing. Pins clients/dispatch/runners/eslint.ts:157-160.
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: "",
				stderr: "Warning: You are using an unsupported version of Node.js\n",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/eslint.js")
			).default;
			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("succeeded");
			expect(result.semantic).toBe("none");
			expect(result.diagnostics).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("reports a clean exit-0 run as succeeded with no findings", async () => {
		const env = setupTestEnvironment("pi-lens-eslint-clean-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "export const ok = 1;\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: JSON.stringify([
					{ filePath, messages: [], errorCount: 0, warningCount: 0 },
				]),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/eslint.js")
			).default;
			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("succeeded");
			expect(result.semantic).toBe("none");
			expect(result.diagnostics).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("skips on exit 2 (fatal/config error) rather than misreporting findings", async () => {
		const env = setupTestEnvironment("pi-lens-eslint-fatal-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 2,
				stdout: "",
				stderr: "ESLint configuration error.",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/eslint.js")
			).default;
			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});
});
