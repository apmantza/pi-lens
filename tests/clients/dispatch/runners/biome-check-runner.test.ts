import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();
const existsSync = vi.fn();
const resolveToolCommandWithInstallFallback = vi.fn();

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		existsSync: (...args: unknown[]) => existsSync(...args),
	};
});

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")>()),
	resolveToolCommandWithInstallFallback,
}));

function createCtx(filePath: string, cwd: string) {
	return makeRunnerCtx(filePath, cwd);
}

describe("biome-check runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		existsSync.mockReset();
		resolveToolCommandWithInstallFallback.mockReset();
		resolveToolCommandWithInstallFallback.mockResolvedValue("biome");
		// Default: no biome config found
		existsSync.mockReturnValue(false);
	});

	it("runs diagnostics-only check without --write mutation", async () => {
		const env = setupTestEnvironment("pi-lens-biome-check-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const x = 1\n");

			// Mock that biome is available in local node_modules
			existsSync.mockImplementation((p: unknown) => {
				if (
					typeof p === "string" &&
					p.includes("node_modules") &&
					p.includes("biome")
				) {
					return true;
				}
				return false;
			});

			safeSpawnAsync
				.mockResolvedValueOnce({
					error: null,
					status: 0,
					stdout: "1.9.4",
					stderr: "",
				})
				.mockResolvedValueOnce({
					error: null,
					status: 1,
					stdout: JSON.stringify({ diagnostics: [] }),
					stderr: "",
				});

			const runner = (
				await import("../../../../clients/dispatch/runners/biome-check.js")
			).default;

			await runner.run(createCtx(filePath, env.tmpDir) as never);

			// Log all calls for debugging
			// biomeCalls = safeSpawnAsync.mock.calls.filter((call) => call[0].includes("biome"))

			expect(
				safeSpawnAsync.mock.calls.some(
					(call) =>
						(call[1] as string[])?.includes("lint") &&
						(call[1] as string[])?.includes("--reporter=json"),
				),
			).toBe(true);
			expect(
				safeSpawnAsync.mock.calls.some((call) =>
					(call[1] as string[])?.includes("--write"),
				),
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("routes a rule with a real 'Fix: safe' explain answer to fixable/autoFixAvailable (#1810)", async () => {
		const env = setupTestEnvironment("pi-lens-biome-check-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "let x = 1;\nconsole.log(x);\n");

			existsSync.mockImplementation((p: unknown) => {
				if (
					typeof p === "string" &&
					p.includes("node_modules") &&
					p.includes("biome")
				) {
					return true;
				}
				return false;
			});

			safeSpawnAsync.mockImplementation(
				async (_cmd: string, args: string[]) => {
					if (args[0] === "explain") {
						return {
							error: null,
							status: 0,
							stdout:
								"Summary\n\n- Name: useConst\n- Fix: safe\n- Default severity: warn\n",
							stderr: "",
						};
					}
					if (args.includes("lint")) {
						return {
							error: null,
							status: 1,
							stdout: JSON.stringify({
								diagnostics: [
									{
										severity: "warning",
										message:
											"This let declares a variable that is only assigned once.",
										category: "lint/style/useConst",
										location: {
											path: filePath,
											start: { line: 1, column: 1 },
											end: { line: 1, column: 4 },
										},
									},
								],
							}),
							stderr: "",
						};
					}
					return { error: null, status: 0, stdout: "", stderr: "" };
				},
			);

			const runner = (
				await import("../../../../clients/dispatch/runners/biome-check.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].fixable).toBe(true);
			expect(result.diagnostics[0].autoFixAvailable).toBe(true);

			expect(
				safeSpawnAsync.mock.calls.some(
					(call) =>
						(call[1] as string[])?.[0] === "explain" &&
						(call[1] as string[])?.[1] === "useConst",
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("stays not-fixable when a rule genuinely has no fix ('No fix available')", async () => {
		const env = setupTestEnvironment("pi-lens-biome-check-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "if (false) { console.log(1); }\n");

			existsSync.mockImplementation((p: unknown) => {
				if (
					typeof p === "string" &&
					p.includes("node_modules") &&
					p.includes("biome")
				) {
					return true;
				}
				return false;
			});

			safeSpawnAsync.mockImplementation(
				async (_cmd: string, args: string[]) => {
					if (args[0] === "explain") {
						return {
							error: null,
							status: 0,
							stdout:
								"Summary\n\n- Name: noConstantCondition\n- No fix available.\n",
							stderr: "",
						};
					}
					if (args.includes("lint")) {
						return {
							error: null,
							status: 1,
							stdout: JSON.stringify({
								diagnostics: [
									{
										severity: "error",
										message:
											"This condition always evaluates to the same value.",
										category: "lint/correctness/noConstantCondition",
										location: {
											path: filePath,
											start: { line: 1, column: 5 },
											end: { line: 1, column: 10 },
										},
									},
								],
							}),
							stderr: "",
						};
					}
					return { error: null, status: 0, stdout: "", stderr: "" };
				},
			);

			const runner = (
				await import("../../../../clients/dispatch/runners/biome-check.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].fixable).toBe(false);
			expect(result.diagnostics[0].autoFixAvailable).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});

describe("resolveBiomeFixKinds (#1810)", () => {
	beforeEach(() => {
		safeSpawnAsync.mockReset();
	});

	it("caches a resolved rule and does not re-spawn 'explain' for it", async () => {
		const { resolveBiomeFixKinds } =
			await import("../../../../clients/dispatch/runners/biome-check.js");
		const cmd = `biome-cache-test-${Math.random()}`;

		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: "- Name: useConst\n- Fix: safe\n",
			stderr: "",
		});

		const first = await resolveBiomeFixKinds(cmd, "/cwd", [
			"lint/style/useConst",
		]);
		expect(first.get("useConst")).toBe("safe");
		const callsAfterFirst = safeSpawnAsync.mock.calls.length;
		expect(callsAfterFirst).toBeGreaterThan(0);

		const second = await resolveBiomeFixKinds(cmd, "/cwd", [
			"lint/style/useConst",
		]);
		expect(second.get("useConst")).toBe("safe");
		// Mutation-proofing: deleting the cache check would spawn again here.
		expect(safeSpawnAsync.mock.calls.length).toBe(callsAfterFirst);
	});

	it("never caches a transient explain-spawn failure (must retry, not poison as unfixable)", async () => {
		const { resolveBiomeFixKinds } =
			await import("../../../../clients/dispatch/runners/biome-check.js");
		const cmd = `biome-transient-test-${Math.random()}`;

		safeSpawnAsync.mockResolvedValueOnce({
			error: "spawn ENOENT",
			status: null,
			stdout: "",
			stderr: "",
		});
		const failed = await resolveBiomeFixKinds(cmd, "/cwd", [
			"lint/style/useConst",
		]);
		expect(failed.get("useConst")).toBe("none");

		safeSpawnAsync.mockResolvedValueOnce({
			error: null,
			status: 0,
			stdout: "- Name: useConst\n- Fix: safe\n",
			stderr: "",
		});
		const recovered = await resolveBiomeFixKinds(cmd, "/cwd", [
			"lint/style/useConst",
		]);
		// If the transient failure had been cached, this would still read
		// "none" — the recovery here proves the cache write is gated on a
		// successful spawn.
		expect(recovered.get("useConst")).toBe("safe");
	});

	it("caches a genuine 'No fix available.' verdict and does not re-spawn (#1810 review F2)", async () => {
		const { resolveBiomeFixKinds } =
			await import("../../../../clients/dispatch/runners/biome-check.js");
		const cmd = `biome-nofix-cache-test-${Math.random()}`;

		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout:
				"Summary\n\n- Name: noConstantCondition\n- No fix available.\n- Default severity: error\n",
			stderr: "",
		});

		const first = await resolveBiomeFixKinds(cmd, "/cwd", [
			"lint/correctness/noConstantCondition",
		]);
		expect(first.get("noConstantCondition")).toBe("none");
		const callsAfterFirst = safeSpawnAsync.mock.calls.length;
		expect(callsAfterFirst).toBeGreaterThan(0);

		const second = await resolveBiomeFixKinds(cmd, "/cwd", [
			"lint/correctness/noConstantCondition",
		]);
		expect(second.get("noConstantCondition")).toBe("none");
		// Mutation-proofing: if the genuine "No fix available." verdict were
		// not cached (F2's finding), this second call would re-spawn.
		expect(safeSpawnAsync.mock.calls.length).toBe(callsAfterFirst);
	});

	it("never caches an unparseable explain output — fails closed without poisoning (#1810 review F1)", async () => {
		const { resolveBiomeFixKinds } =
			await import("../../../../clients/dispatch/runners/biome-check.js");
		const cmd = `biome-unparseable-test-${Math.random()}`;

		// Shaped like a biome 1.x `explain` answer might be: no "- Fix:" or
		// "- No fix available." line at all, since that structured text is a
		// 2.x-era addition.
		safeSpawnAsync.mockResolvedValueOnce({
			error: null,
			status: 0,
			stdout: "useConst: require const declarations\n",
			stderr: "",
		});
		const first = await resolveBiomeFixKinds(cmd, "/cwd", [
			"lint/style/useConst",
		]);
		expect(first.get("useConst")).toBe("none");

		// A later call against the SAME (cmd, rule) with real 2.x-shaped output
		// must still get the real answer — proving the unparseable read above
		// was never written to the cache.
		safeSpawnAsync.mockResolvedValueOnce({
			error: null,
			status: 0,
			stdout: "- Name: useConst\n- Fix: safe\n",
			stderr: "",
		});
		const second = await resolveBiomeFixKinds(cmd, "/cwd", [
			"lint/style/useConst",
		]);
		expect(second.get("useConst")).toBe("safe");
	});

	it("records a bounded degradation on explain spawn failure (#1810 review F4)", async () => {
		const { resolveBiomeFixKinds } =
			await import("../../../../clients/dispatch/runners/biome-check.js");
		const { getDegradationSummary, resetDegradationLedger } =
			await import("../../../../clients/degradation-ledger.js");
		resetDegradationLedger();
		const cmd = `biome-degradation-test-${Math.random()}`;

		safeSpawnAsync.mockResolvedValueOnce({
			error: "spawn ENOENT",
			status: null,
			stdout: "",
			stderr: "",
		});
		await resolveBiomeFixKinds(cmd, "/cwd", ["lint/style/useConst"]);

		const summary = getDegradationSummary();
		const group = summary.find((g) => g.kind === "biome-explain-unavailable");
		expect(group).toBeDefined();
		expect(group?.count).toBeGreaterThanOrEqual(1);
		expect(group?.latestReasons.some((r) => r.subject === "useConst")).toBe(
			true,
		);
	});

	it("records a bounded degradation on unparseable explain output too (#1810 review F1/F4)", async () => {
		const { resolveBiomeFixKinds } =
			await import("../../../../clients/dispatch/runners/biome-check.js");
		const { getDegradationSummary, resetDegradationLedger } =
			await import("../../../../clients/degradation-ledger.js");
		resetDegradationLedger();
		const cmd = `biome-degradation-unparseable-test-${Math.random()}`;

		safeSpawnAsync.mockResolvedValueOnce({
			error: null,
			status: 0,
			stdout: "garbled, not the real shape at all",
			stderr: "",
		});
		await resolveBiomeFixKinds(cmd, "/cwd", ["lint/style/useTemplate"]);

		const summary = getDegradationSummary();
		const group = summary.find((g) => g.kind === "biome-explain-unavailable");
		expect(group).toBeDefined();
		expect(group?.latestReasons.some((r) => r.subject === "useTemplate")).toBe(
			true,
		);
	});

	it("caps concurrent 'explain' spawns rather than firing them all at once (#1810 review F6)", async () => {
		const { resolveBiomeFixKinds } =
			await import("../../../../clients/dispatch/runners/biome-check.js");
		const cmd = `biome-concurrency-test-${Math.random()}`;
		const ruleCount = 12;
		let inFlight = 0;
		let maxInFlight = 0;

		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			// Yield so overlapping calls actually overlap instead of resolving
			// synchronously one at a time.
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight--;
			const ruleName = args[1];
			return {
				error: null,
				status: 0,
				stdout: `- Name: ${ruleName}\n- Fix: safe\n`,
				stderr: "",
			};
		});

		const categories = Array.from(
			{ length: ruleCount },
			(_, i) => `lint/style/rule${i}`,
		);
		const resolved = await resolveBiomeFixKinds(cmd, "/cwd", categories);

		expect(resolved.size).toBe(ruleCount);
		expect(maxInFlight).toBeLessThanOrEqual(4);
		// Mutation-proofing: an unbounded `Promise.all` fan-out would drive
		// maxInFlight to ruleCount (12) here — the cap is what keeps it low.
		expect(maxInFlight).toBeGreaterThan(1);
	});

	it("no-ops without spawning when there are no categories at all (#1810 review F7)", async () => {
		const { resolveBiomeFixKinds } =
			await import("../../../../clients/dispatch/runners/biome-check.js");
		const cmd = `biome-empty-test-${Math.random()}`;

		const resolved = await resolveBiomeFixKinds(cmd, "/cwd", []);

		expect(resolved.size).toBe(0);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});

	it("_resetBiomeFixKindCacheForTests clears cached verdicts (#1810 review F5)", async () => {
		const { resolveBiomeFixKinds, _resetBiomeFixKindCacheForTests } =
			await import("../../../../clients/dispatch/runners/biome-check.js");
		const cmd = `biome-reset-seam-test-${Math.random()}`;

		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: "- Name: useConst\n- Fix: safe\n",
			stderr: "",
		});

		await resolveBiomeFixKinds(cmd, "/cwd", ["lint/style/useConst"]);
		const callsAfterFirst = safeSpawnAsync.mock.calls.length;
		expect(callsAfterFirst).toBeGreaterThan(0);

		_resetBiomeFixKindCacheForTests();

		await resolveBiomeFixKinds(cmd, "/cwd", ["lint/style/useConst"]);
		// Mutation-proofing: if the reset didn't actually clear the map, this
		// second call would hit the cache and spawn nothing more.
		expect(safeSpawnAsync.mock.calls.length).toBeGreaterThan(callsAfterFirst);
	});
});
