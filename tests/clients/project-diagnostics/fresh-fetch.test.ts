import { getEventListeners } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapClients } from "../../../clients/bootstrap.js";
import { snapshotAdvisoryProvenance } from "../../../clients/advisory-provenance.js";
import { fetchFreshProjectDiagnostics } from "../../../clients/project-diagnostics/fresh-fetch.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import {
	clearWidgetState,
	reconcileCorrelatedScanDiagnostics,
	reconcileStaleWidgetFiles,
} from "../../../clients/widget-state.js";
import { OpengrepClient } from "../../../clients/opengrep-client.js";
import { KnipClient } from "../../../clients/knip-client.js";
import { realpathOrResolve } from "../../../clients/path-utils.js";
import * as safeSpawn from "../../../clients/safe-spawn.js";
// #2962: the retirement consumer is imported so the coverage this fetch
// produces is judged by the REAL decision function, not by a restatement of it.
import { runnerRetirementDecision } from "../../../tools/lens-diagnostics.js";
import type { WidgetDiagnostic } from "../../../clients/widget-state.js";
import { removeTempDirSync } from "../test-utils.js";
import {
	_resetStateCacheForTests,
	markDisposition,
} from "../../../clients/diagnostic-dispositions.js";

// fetchFreshProjectDiagnostics calls each client through the plain
// `BootstrapClients` interface, so a hand-rolled stub (not a real client
// instance) is enough to exercise the orchestration — only the module-level
// static gates (GitleaksClient.hasGitRepo — #608's mode=full smart-default,
// GovulncheckClient.hasGoModule, TrivyClient.shouldScan) run for real, against
// a real tmp-dir fixture.

let tmp: string;
let previousPiLensHome: string | undefined;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-fresh-fetch-"));
	previousPiLensHome = process.env.PI_LENS_HOME;
	process.env.PI_LENS_HOME = path.join(tmp, "pi-lens-home");
	_resetStateCacheForTests();
	resetDegradationLedger();
});

afterEach(() => {
	if (previousPiLensHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousPiLensHome;
	_resetStateCacheForTests();
	removeTempDirSync(tmp);
});

function makeCacheManager() {
	return {
		writeCache: vi.fn(),
		readCache: vi.fn(),
	} as unknown as import("../../../clients/cache-manager.js").CacheManager & {
		writeCache: ReturnType<typeof vi.fn>;
	};
}

function makeClients(
	overrides: Partial<{
		knipIssues: unknown[];
		knipResult: unknown;
		jscpdAvailable: boolean;
		jscpdResult: unknown;
		madgeAvailable: boolean;
		madgeResult: unknown;
		opengrepResult: unknown;
	}> = {},
): BootstrapClients {
	return {
		knipClient: {
			analyze: vi.fn().mockResolvedValue(
				overrides.knipResult ?? {
					success: true,
					// A stub that stands for a knip run that actually happened
					// carries the same opt-in signal the real client sets at its
					// parse site (#2154) — without it fresh-fetch reports the
					// runner cold, exactly as it would for a knip that no-oped.
					analyzed: true,
					issues: overrides.knipIssues ?? [],
					unusedExports: [],
					unusedFiles: [],
					unusedDeps: [],
					unlistedDeps: [],
					summary: "ok",
				},
			),
		},
		jscpdClient: {
			ensureAvailable: vi
				.fn()
				.mockResolvedValue(overrides.jscpdAvailable ?? false),
			scan: vi.fn().mockResolvedValue(
				overrides.jscpdResult ?? {
					success: true,
					analyzed: true,
					duplicatedLines: 0,
					totalLines: 0,
					percentage: 0,
					clones: [],
				},
			),
		},
		depChecker: {
			ensureAvailable: vi
				.fn()
				.mockResolvedValue(overrides.madgeAvailable ?? false),
			scanProject: vi
				.fn()
				.mockResolvedValue(
					overrides.madgeResult ?? { circular: [], count: 0, analyzed: true },
				),
		},
		govulncheckClient: {
			ensureAvailable: vi.fn().mockResolvedValue(true),
			analyze: vi.fn().mockResolvedValue({
				success: true,
				analyzed: true,
				findings: [],
				scannedAt: "now",
			}),
		},
		gitleaksClient: {
			ensureAvailable: vi.fn().mockResolvedValue(true),
			scan: vi.fn().mockResolvedValue({
				success: true,
				analyzed: true,
				findings: [],
				scannedAt: "now",
			}),
		},
		trivyClient: {
			ensureAvailable: vi.fn().mockResolvedValue(true),
			scan: vi.fn().mockResolvedValue({
				success: true,
				analyzed: true,
				findings: [],
				scannedAt: "now",
			}),
		},
		// opengrep is structurally always-on (no static project gate) — the stub
		// defaults to available + a clean scan; individual tests override `scan`.
		opengrepClient: {
			ensureAvailable: vi.fn().mockResolvedValue(true),
			scan: vi.fn().mockResolvedValue(
				overrides.opengrepResult ?? {
					success: true,
					analyzed: true,
					findings: [],
					scannedAt: "now",
				},
			),
		},
		deadCodeClients: [],
		// The remaining BootstrapClients fields are unused by fetchFreshProjectDiagnostics.
	} as unknown as BootstrapClients;
}

/**
 * #3600 F2/F3: one parameter set per heavyweight lane. Date is frozen to
 * `RECORD_NOW`, but every lane's result carries a DISTINCT source stamp taken
 * 5 s earlier, so a lane that stamps `Date.now()` at the record site instead of
 * reading its result's own stamp reds. A per-lane copy with `now == source`
 * (the round-1 shape) cannot tell those apart.
 */
const LANE_SOURCE_AT = 1_700_000_000_000;
const LANE_RECORD_NOW = LANE_SOURCE_AT + 5_000;
const LANE_SOURCE_ISO = new Date(LANE_SOURCE_AT).toISOString();

function arrangeHeavyweightLane(lane: string): {
	clients: BootstrapClients;
	cacheManager: ReturnType<typeof makeCacheManager>;
	match: (diagnostic: { runner?: string; tool?: string }) => boolean;
} {
	const cacheManager = makeCacheManager();
	switch (lane) {
		case "knip": {
			const clients = makeClients({
				knipResult: {
					success: true,
					analyzed: true,
					scannedAt: LANE_SOURCE_ISO,
					issues: [{ type: "file", name: "dead.ts", file: "dead.ts" }],
					unusedExports: [],
					unusedFiles: [],
					unusedDeps: [],
					unlistedDeps: [],
					summary: "ok",
				},
			});
			return { clients, cacheManager, match: (d) => d.runner === "knip" };
		}
		case "jscpd": {
			const clients = makeClients({
				jscpdAvailable: true,
				jscpdResult: {
					success: true,
					analyzed: true,
					scannedAt: LANE_SOURCE_ISO,
					clones: [
						{
							fileA: "a.ts",
							startA: 1,
							fileB: "b.ts",
							startB: 2,
							lines: 10,
							tokens: 40,
						},
					],
					duplicatedLines: 10,
					totalLines: 100,
					percentage: 10,
				},
			});
			return { clients, cacheManager, match: (d) => d.runner === "jscpd" };
		}
		case "madge": {
			const clients = makeClients({
				madgeAvailable: true,
				madgeResult: {
					circular: [{ path: ["a.ts", "b.ts"], file: "a.ts" }],
					count: 1,
					analyzed: true,
					scannedAt: LANE_SOURCE_ISO,
				},
			});
			return { clients, cacheManager, match: (d) => d.runner === "madge" };
		}
		case "gitleaks": {
			fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
			const clients = makeClients();
			(
				clients.gitleaksClient.scan as ReturnType<typeof vi.fn>
			).mockResolvedValue({
				success: true,
				analyzed: true,
				scannedAt: LANE_SOURCE_ISO,
				findings: [{ ruleId: "aws-key", file: "a.ts", startLine: 1 }],
			});
			return { clients, cacheManager, match: (d) => d.runner === "gitleaks" };
		}
		case "govulncheck": {
			fs.writeFileSync(path.join(tmp, "go.mod"), "module demo\n\ngo 1.21\n");
			const clients = makeClients();
			(
				clients.govulncheckClient.analyze as ReturnType<typeof vi.fn>
			).mockResolvedValue({
				success: true,
				analyzed: true,
				scannedAt: LANE_SOURCE_ISO,
				findings: [
					{
						osv: "GO-2024-0001",
						module: "example.com/vuln",
						trace: [{ filename: "main.go", line: 1 }],
					},
				],
			});
			return {
				clients,
				cacheManager,
				match: (d) => d.runner === "govulncheck",
			};
		}
		case "opengrep": {
			const clients = makeClients({
				opengrepResult: {
					success: true,
					analyzed: true,
					scannedAt: LANE_SOURCE_ISO,
					findings: [
						{
							checkId: "rule",
							path: path.join(tmp, "a.py"),
							startLine: 1,
							startCol: 1,
							endLine: 1,
							endCol: 2,
							message: "OPENGREP ROW",
							severity: "ERROR",
						},
					],
				},
			});
			return { clients, cacheManager, match: (d) => d.runner === "opengrep" };
		}
		case "trivy": {
			fs.writeFileSync(
				path.join(tmp, ".pi-lens.json"),
				JSON.stringify({ trivy: { enabled: true } }),
			);
			fs.writeFileSync(path.join(tmp, "package.json"), "{}");
			const clients = makeClients();
			(clients.trivyClient.scan as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true,
				analyzed: true,
				scannedAt: LANE_SOURCE_ISO,
				findings: [],
				licenses: [],
				secrets: [{ ruleId: "generic-api-key", file: "a.ts", line: 1 }],
			});
			return { clients, cacheManager, match: (d) => d.runner === "trivy" };
		}
		case "dead-code": {
			const clients = makeClients();
			(clients as unknown as { deadCodeClients: unknown[] }).deadCodeClients = [
				{
					id: "python",
					language: "Python",
					detect: vi.fn().mockReturnValue(true),
					analyze: vi.fn().mockResolvedValue({
						success: true,
						analyzed: true,
						language: "Python",
						scannedAt: LANE_SOURCE_ISO,
						summary: "",
						unusedExports: [
							{
								category: "export",
								kind: "func",
								name: "x",
								file: "z.py",
								line: 9,
							},
						],
						unusedFiles: [],
						unusedDeps: [],
						unlistedDeps: [],
					}),
				},
			];
			return {
				clients,
				cacheManager,
				match: (d) => d.tool === "dead-code",
			};
		}
		case "test-runner": {
			const testResult = {
				file: path.join(path.resolve(tmp), "src/foo.test.ts"),
				runner: "vitest",
				passed: 1,
				failed: 1,
				duration: 42,
				failures: [
					{ name: "foo", message: "boom", location: "src/foo.test.ts:3" },
				],
			};
			const launchedFrom = snapshotAdvisoryProvenance({
				cwd: tmp,
				runtime: { telemetrySessionId: "s", projectSeq: 0, turnIndex: 0 },
				generation: 1,
				files: [{ path: testResult.file, role: "test" }],
				capturedAt: LANE_SOURCE_AT,
			});
			(cacheManager.readCache as ReturnType<typeof vi.fn>).mockImplementation(
				(scanner: string) =>
					scanner === "test-runner-findings"
						? {
								data: {
									content: "FAIL",
									stale: false,
									results: [testResult],
									launchedFrom,
								},
								// The cache WRITE time is the record clock, 5 s after the batch's
								// launch stamp; the row must carry the launch, not the write.
								meta: { timestamp: new Date(LANE_RECORD_NOW).toISOString() },
							}
						: null,
			);
			return {
				clients: makeClients(),
				cacheManager,
				match: (d) => d.tool === "test-runner",
			};
		}
		default:
			throw new Error(`unknown heavyweight lane ${lane}`);
	}
}

describe("fetchFreshProjectDiagnostics (#585)", () => {
	it("runs knip fresh and writes its result to cache", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients({
			knipIssues: [{ type: "file", name: "dead.ts", file: "dead.ts" }],
		});

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		expect(clients.knipClient.analyze).toHaveBeenCalledTimes(1);
		expect(cacheManager.writeCache).toHaveBeenCalledWith(
			"knip",
			expect.objectContaining({ success: true }),
			path.resolve(tmp),
			expect.objectContaining({ scanDurationMs: expect.any(Number) }),
		);
		expect(result.runners).toContain("knip");
		expect(result.diagnostics.length).toBeGreaterThan(0);
		expect(result.timings.knip).toBeGreaterThanOrEqual(0);
	});

	// #3600: the widget's stale gate judges a folded row against the time the
	// analyzer READ its bytes. A lane whose result carries no `scannedAt` is
	// stamped at the moment its run began.
	it("stamps a heavyweight row with its lane's start when the result has no scannedAt (#3600)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const fetchStart = 1_900_000_000_000;
		vi.setSystemTime(fetchStart);
		try {
			const result = await fetchFreshProjectDiagnostics(
				makeCacheManager(),
				tmp,
				makeClients({
					knipIssues: [{ type: "file", name: "dead.ts", file: "dead.ts" }],
				}),
			);
			expect(result.diagnostics.length).toBeGreaterThan(0);
			expect(result.diagnostics.every((d) => d.observedAt === fetchStart)).toBe(
				true,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("prefers the analyzer's own scannedAt over the fetch clock (#3600)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const fetchStart = 1_900_000_000_000;
		const scannerRead = fetchStart - 5_000;
		vi.setSystemTime(fetchStart);
		try {
			const result = await fetchFreshProjectDiagnostics(
				makeCacheManager(),
				tmp,
				makeClients({
					opengrepResult: {
						success: true,
						analyzed: true,
						scannedAt: new Date(scannerRead).toISOString(),
						findings: [
							{
								checkId: "rule",
								path: path.join(tmp, "a.ts"),
								startLine: 1,
								startCol: 1,
								endLine: 1,
								endCol: 1,
								message: "OPENGREP ROW",
								severity: "ERROR",
							},
						],
					},
				}),
			);
			const row = result.diagnostics.find((d) => d.runner === "opengrep");
			expect(row?.observedAt).toBe(scannerRead);
		} finally {
			vi.useRealTimers();
		}
	});

	// #3600 F2/F3: one parametrised test over all nine heavyweight lanes. Date
	// is frozen to LANE_RECORD_NOW while every lane's result carries its own
	// source stamp 5 s EARLIER, so a lane that stamps the record-site clock
	// instead of its source time reds here — the round-1 knip test froze both to
	// the same value and let that mutation survive.
	it.each([
		"knip",
		"jscpd",
		"madge",
		"gitleaks",
		"govulncheck",
		"opengrep",
		"trivy",
		"dead-code",
		"test-runner",
	])(
		"the %s lane carries its source observation time, not the record clock (#3600)",
		async (lane) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(LANE_RECORD_NOW);
			try {
				const { clients, cacheManager, match } = arrangeHeavyweightLane(lane);
				const result = await fetchFreshProjectDiagnostics(
					cacheManager,
					tmp,
					clients,
				);
				const rows = result.diagnostics.filter(match);
				expect(rows.length).toBeGreaterThan(0);
				expect(rows.map((row) => row.observedAt)).toEqual(
					rows.map(() => LANE_SOURCE_AT),
				);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	// #3600 F1: the reviewer's joined-run probe as a real test. A real KnipClient
	// run is started first; the fetch lane later JOINS that in-flight run, so its
	// own start is AFTER the analyzer's read. An edit landing in that gap must
	// demote the row, which is only possible if the row carries the initiator's
	// read stamp rather than the joiner's lane start. Only the subprocess body is
	// replaced (`safeSpawnAsync`); the join, the read stamp, the fold, and the
	// widget gate are all production code.
	it("a joined in-flight analyzer run carries the run's read time, so a mid-run edit drops the row (#3600)", async () => {
		fs.writeFileSync(path.join(tmp, "package.json"), '{"name":"demo"}');
		const dead = path.join(tmp, "dead.ts");
		fs.writeFileSync(dead, "export const dead = 1;\n");

		let releaseAnalysis!: () => void;
		const analysisHeld = new Promise<void>((resolve) => {
			releaseAnalysis = resolve;
		});
		let analysisSpawned!: () => void;
		const analysisStarted = new Promise<void>((resolve) => {
			analysisSpawned = resolve;
		});
		vi.spyOn(safeSpawn, "safeSpawnAsync").mockImplementation(
			async (_command, args) => {
				if (args.includes("--reporter=json")) {
					analysisSpawned();
					await analysisHeld;
					return {
						status: 0,
						stdout: JSON.stringify({
							issues: [{ file: "dead.ts", files: [{ name: "dead.ts" }] }],
						}),
						stderr: "",
					};
				}
				// The `--version` availability probe.
				return { status: 0, stdout: "6.0.0", stderr: "" };
			},
		);

		const knipClient = new KnipClient();
		const clients = {
			...makeClients(),
			knipClient,
		} as unknown as BootstrapClients;

		vi.useFakeTimers({ toFake: ["Date"] });
		const readAt = 1_700_000_000_000;
		const editAt = readAt + 101;
		const laneStartAt = readAt + 704;
		try {
			clearWidgetState();
			vi.setSystemTime(readAt);
			// The initiator's run starts at `readAt` and reaches the held spawn.
			const initiator = knipClient.analyze(tmp);
			await analysisStarted;
			// The edit lands after the read, before the lane even starts.
			vi.setSystemTime(editAt);
			fs.writeFileSync(dead, "export const dead = 2;\n");
			fs.utimesSync(dead, editAt / 1000, editAt / 1000);

			vi.setSystemTime(laneStartAt);
			const fetch = fetchFreshProjectDiagnostics(
				makeCacheManager(),
				tmp,
				clients,
			);
			// Release the held analysis so the initiator and the joined lane settle.
			releaseAnalysis();
			const result = await fetch;
			await initiator;

			const row = result.diagnostics.find((d) => d.runner === "knip");
			expect(row?.observedAt).toBe(readAt);

			// Edit after the read (> 50 ms tolerance) → the widget demotes the row.
			reconcileCorrelatedScanDiagnostics(dead, [
				{
					tool: "knip",
					severity: "warning",
					message: "ANALYZER ROW",
					uri: "",
					observedAt: row?.observedAt,
				},
			]);
			expect(await reconcileStaleWidgetFiles()).toBe(1);
		} finally {
			clearWidgetState();
			vi.useRealTimers();
		}
	});

	it("reports a failed knip run and does not cache it (#925)", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients({
			knipResult: {
				success: false,
				issues: [],
				summary: "knip process failed",
			},
		});

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		expect(result.failed).toEqual([
			{ id: "knip", summary: "knip process failed" },
		]);
		expect(result.runners).not.toContain("knip");
		expect(cacheManager.writeCache).not.toHaveBeenCalledWith(
			"knip",
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
	});

	// #747: cwd at — or above — $HOME must never spawn a single analyzer; the
	// observed failure was a jscpd walk of an entire WSL home (44 GB RSS, OOM
	// kill of the whole instance).
	it("refuses to run anything when cwd IS the home directory (#747)", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients({ jscpdAvailable: true, madgeAvailable: true });

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
			undefined,
			{ homeDir: tmp },
		);

		expect(result.unsafeRoot).toBe(true);
		expect(result.diagnostics).toEqual([]);
		expect(result.runners).toEqual([]);
		expect(result.cold).toEqual([
			"knip",
			"jscpd",
			"madge",
			"gitleaks",
			"govulncheck",
			"opengrep",
			"trivy",
			"dead-code",
			"test-runner",
		]);
		expect(clients.knipClient.analyze).not.toHaveBeenCalled();
		expect(clients.jscpdClient.ensureAvailable).not.toHaveBeenCalled();
		expect(clients.jscpdClient.scan).not.toHaveBeenCalled();
		expect(clients.depChecker.scanProject).not.toHaveBeenCalled();
		expect(clients.gitleaksClient.scan).not.toHaveBeenCalled();
		expect(cacheManager.writeCache).not.toHaveBeenCalled();
	});

	it("refuses to run anything when cwd is an ANCESTOR of the home directory (#747)", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients({ jscpdAvailable: true });
		const fakeHome = path.join(tmp, "home", "user");
		fs.mkdirSync(fakeHome, { recursive: true });

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
			undefined,
			{ homeDir: fakeHome },
		);

		expect(result.unsafeRoot).toBe(true);
		expect(clients.knipClient.analyze).not.toHaveBeenCalled();
		expect(cacheManager.writeCache).not.toHaveBeenCalled();
	});

	// RECURRENCE GUARDED: #4911. The root was a real path but HOME was compared
	// as spelled, so a HOME spelled through a link let every analyzer walk the
	// home tree. The root-link direction rides along: it must keep refusing.
	it.each([["home-link"], ["root-link"]] as const)(
		"refuses to run anything when the %s spelling names the home directory (#4911)",
		async (kind) => {
			const cacheManager = makeCacheManager();
			const clients = makeClients();
			const home = path.join(tmp, "home");
			fs.mkdirSync(home, { recursive: true });
			const link = path.join(tmp, "link");
			fs.symlinkSync(home, link, "junction");

			const result = await fetchFreshProjectDiagnostics(
				cacheManager,
				kind === "root-link" ? link : home,
				clients,
				undefined,
				{ homeDir: kind === "home-link" ? link : home },
			);

			expect(result.unsafeRoot).toBe(true);
			expect(clients.knipClient.analyze).not.toHaveBeenCalled();
		},
	);

	it("runs normally for a project directory UNDER the home directory (#747)", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients();
		const fakeHome = path.join(tmp, "home", "user");
		const project = path.join(fakeHome, "code", "app");
		fs.mkdirSync(project, { recursive: true });

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			project,
			clients,
			undefined,
			{ homeDir: fakeHome },
		);

		expect(result.unsafeRoot).toBeUndefined();
		expect(clients.knipClient.analyze).toHaveBeenCalledTimes(1);
	});

	it("runs the reporter's home-cwd reproduction for an explicit project root (#2053)", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients();
		const fakeHome = path.join(tmp, "home", "user");
		const project = path.join(fakeHome, "repo");
		fs.mkdirSync(project, { recursive: true });

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			fakeHome,
			clients,
			undefined,
			{ homeDir: fakeHome, analysisRoot: path.join(project, "..", "repo") },
		);

		expect(result.unsafeRoot).toBeUndefined();
		expect(result.analysisRootError).toBeUndefined();
		expect(clients.knipClient.analyze).toHaveBeenCalledWith(
			fs.realpathSync(project),
			expect.anything(),
		);
	});

	it("shares one validated explicit root with every heavyweight consumer (#2977)", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients({ jscpdAvailable: true, madgeAvailable: true });
		const fakeHome = path.join(tmp, "home", "user");
		const project = path.join(fakeHome, "repo");
		fs.mkdirSync(project, { recursive: true });

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			fakeHome,
			clients,
			undefined,
			{ homeDir: fakeHome, analysisRoot: "repo" },
		);

		const validated = result.analysisRootValidation;
		expect(validated).toEqual({
			state: "safe",
			root: fs.realpathSync(project),
		});
		for (const consumer of [
			clients.knipClient.analyze,
			clients.jscpdClient.scan,
			clients.depChecker.scanProject,
		]) {
			expect(consumer).toHaveBeenCalled();
			const calls = (consumer as unknown as { mock: { calls: unknown[][] } })
				.mock.calls;
			expect(calls[0]?.[0]).toBe(fs.realpathSync(project));
		}
	});

	it("refuses an explicit analysis root AT or ABOVE home (#2053, #749)", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients();
		const fakeHome = path.join(tmp, "home", "user");
		fs.mkdirSync(fakeHome, { recursive: true });

		for (const analysisRoot of [fakeHome, path.join(fakeHome, "..")]) {
			const result = await fetchFreshProjectDiagnostics(
				cacheManager,
				path.join(fakeHome, "session"),
				clients,
				undefined,
				{ homeDir: fakeHome, analysisRoot },
			);

			expect(result.unsafeRoot).toBe(true);
			expect(result.coldReasons?.knip).toMatch(/at or above/i);
		}
		expect(clients.knipClient.analyze).not.toHaveBeenCalled();
		expect(cacheManager.writeCache).not.toHaveBeenCalled();
	});

	it("refuses a missing or non-directory explicit analysis root (#2053)", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients();
		const missing = path.join(tmp, "missing-project");
		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
			undefined,
			{ homeDir: path.join(tmp, "home"), analysisRoot: missing },
		);

		expect(result.analysisRootError).toMatch(/unavailable/i);
		expect(clients.knipClient.analyze).not.toHaveBeenCalled();
		expect(
			getDegradationSummary().some(
				({ kind }) => kind === "lens-diagnostics-analysis-root-rejected",
			),
		).toBe(true);
	});

	it("rejects every explicit root that is not strictly below canonical home (#2977 F1)", async () => {
		const cacheManager = makeCacheManager();
		const fakeHome = path.join(tmp, "home", "user");
		const inside = path.join(fakeHome, "repo");
		const outside = path.join(tmp, "outside");
		fs.mkdirSync(inside, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		fs.symlinkSync(outside, path.join(fakeHome, "link-out"), "dir");

		const cases = [
			["ceiling", fakeHome, false],
			["above", path.join(fakeHome, ".."), false],
			[
				"traversal",
				path.join(fakeHome, "repo", "..", "..", "..", "outside"),
				false,
			],
			["absolute outside", outside, false],
			["symlink outside", path.join(fakeHome, "link-out"), false],
			["relative", "repo", true],
			["empty", "", false],
			["non-existent", path.join(fakeHome, "missing"), false],
		] as const;
		for (const [, root, accepted] of cases) {
			const caseClients = makeClients();
			const result = await fetchFreshProjectDiagnostics(
				cacheManager,
				fakeHome,
				caseClients,
				undefined,
				{ homeDir: fakeHome, analysisRoot: root },
			);
			expect(
				result.unsafeRoot === true || result.analysisRootError !== undefined,
			).toBe(!accepted);
			expect(caseClients.knipClient.analyze).toHaveBeenCalledTimes(
				accepted ? 1 : 0,
			);
		}
		expect(cacheManager.writeCache).toHaveBeenCalled();
		const summary = getDegradationSummary();
		expect(
			summary.some(
				({ kind }) => kind === "lens-diagnostics-analysis-root-rejected",
			),
		).toBe(true);
	});

	it("reports jscpd cold when the tool isn't available, without writing cache", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients({ jscpdAvailable: false });

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		expect(clients.jscpdClient.scan).not.toHaveBeenCalled();
		expect(result.cold).toContain("jscpd");
		expect(cacheManager.writeCache).not.toHaveBeenCalledWith(
			expect.stringMatching(/^jscpd/),
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
	});

	it("writes to the jscpd-ts cache key when a tsconfig.json is present", async () => {
		fs.writeFileSync(path.join(tmp, "tsconfig.json"), "{}");
		const cacheManager = makeCacheManager();
		const clients = makeClients({
			jscpdAvailable: true,
			jscpdResult: {
				success: true,
				analyzed: true,
				duplicatedLines: 4,
				totalLines: 10,
				percentage: 40,
				clones: [
					{
						fileA: "a.ts",
						startA: 1,
						fileB: "b.ts",
						startB: 2,
						lines: 4,
						tokens: 10,
					},
				],
			},
		});

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		expect(clients.jscpdClient.scan).toHaveBeenCalledWith(
			path.resolve(tmp),
			undefined,
			undefined,
			true,
		);
		expect(cacheManager.writeCache).toHaveBeenCalledWith(
			"jscpd-ts",
			expect.anything(),
			path.resolve(tmp),
			expect.anything(),
		);
		expect(result.runners).toContain("jscpd");
		expect(cacheManager.writeCache).toHaveBeenCalledWith(
			"jscpd-ts",
			expect.objectContaining({ duplicatedLines: 4, percentage: 40 }),
			path.resolve(tmp),
			expect.anything(),
		);
	});

	it("persists the present madge result for downstream diagnostics", async () => {
		const cacheManager = makeCacheManager();
		const madgeResult = {
			circular: [
				[path.join(tmp, "src", "a.ts"), path.join(tmp, "src", "b.ts")],
			],
			count: 1,
		};
		const clients = makeClients({ madgeAvailable: true, madgeResult });

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		expect(clients.depChecker.scanProject).toHaveBeenCalledWith(
			path.resolve(tmp),
		);
		expect(cacheManager.writeCache).toHaveBeenCalledWith(
			"madge",
			madgeResult,
			path.resolve(tmp),
			expect.anything(),
		);
		expect(result.cold).not.toContain("madge");
	});

	it("gates govulncheck/trivy on their own static signals, without cache reads", async () => {
		// No go.mod, no .pi-lens.json trivy.enabled — both should report cold
		// and never call analyze()/scan().
		const cacheManager = makeCacheManager();
		const clients = makeClients();

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		expect(clients.govulncheckClient.analyze).not.toHaveBeenCalled();
		expect(clients.trivyClient.scan).not.toHaveBeenCalled();
		expect(result.cold).toEqual(
			expect.arrayContaining(["govulncheck", "trivy"]),
		);
	});

	it("gates gitleaks on hasGitRepo (#608): cold when tmp isn't a git repo at all", async () => {
		// tmp has no .git and no explicit gitleaks marker either — cold either way.
		const cacheManager = makeCacheManager();
		const clients = makeClients();

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		expect(clients.gitleaksClient.scan).not.toHaveBeenCalled();
		expect(result.cold).toContain("gitleaks");
	});

	// #1623: `cold` alone can't distinguish "not a git repo" from "gitleaks
	// binary missing" from "no go.mod" — a caller could only ever render a
	// generic guess (the pre-fix `warmTriggerFor` lookup). Each gate must now
	// capture ITS OWN reason, at the point it decides, into `coldReasons` —
	// the single source of truth the render layer reads instead of
	// re-deriving one.
	it("captures the SPECIFIC reason each cold analyzer was skipped, not just its id (#1623)", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients();

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		expect(result.coldReasons?.gitleaks).toMatch(/not a git repository/i);
		expect(result.coldReasons?.govulncheck).toMatch(/go\.mod/i);
		expect(result.coldReasons?.trivy).toBeDefined();
		// jscpd/madge stayed cold because ensureAvailable() returned false by
		// default in this test's stub clients — the reason must say so, not
		// just repeat the generic "runs at session-start" guess.
		expect(result.coldReasons?.jscpd).toMatch(/unavailable/i);
	});

	// #1623 fix-round F1: `ensureAvailable() === false` collapses a durable
	// absence and a TRANSIENT probe failure under an active retry cooldown
	// into the same boolean. Pre-fix-round, every cold reason in this module
	// said "<tool> binary unavailable" regardless of which one it was — a
	// confident false claim for a tool that is actually installed and about
	// to retry on its own. The reason must be built from the client's real
	// availability verdict (the SAME `AvailabilityOutcome`/`AvailabilityCause`
	// taxonomy the dispatch layer already uses), not a re-guessed string.
	it("renders a retry-cooldown reason, not 'binary unavailable', for a transient probe failure (#1623 fix-round F1)", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients({ jscpdAvailable: false });
		const retryAtMs = Date.now() + 15_000;
		(
			clients.jscpdClient as unknown as {
				getAvailabilityVerdict: ReturnType<typeof vi.fn>;
			}
		).getAvailabilityVerdict = vi.fn().mockReturnValue({
			outcome: "transient",
			cause: "probe-timeout",
			retryAtMs,
		});

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		expect(result.coldReasons?.jscpd).toMatch(/retry cooldown \(\d+s\)/);
		expect(result.coldReasons?.jscpd).not.toMatch(/binary unavailable/i);
	});

	// #1623 fix-round F1: govulncheck's project-trust denial (govulncheck-
	// client.ts, `assertInstallAllowed`) deliberately never touches the
	// availability latch — a later trust grant must be able to retry — so a
	// reason built purely from the latch would see nothing and fall back to
	// the generic "binary unavailable" guess for a tool that isn't even
	// missing, just policy-blocked. fresh-fetch.ts's govulncheck task must
	// check trust denial itself before falling back to the latch.
	it("renders the project-trust denial reason for govulncheck, not 'binary unavailable' (#1623 fix-round F1)", async () => {
		fs.writeFileSync(path.join(tmp, "go.mod"), "module demo\n\ngo 1.21\n");
		setProjectTrustState("untrusted");
		try {
			const cacheManager = makeCacheManager();
			const clients = makeClients();
			(
				clients.govulncheckClient.ensureAvailable as ReturnType<typeof vi.fn>
			).mockResolvedValue(false);

			const result = await fetchFreshProjectDiagnostics(
				cacheManager,
				tmp,
				clients,
			);

			expect(result.coldReasons?.govulncheck).toMatch(/not trusted/i);
			expect(result.coldReasons?.govulncheck).not.toMatch(
				/binary unavailable/i,
			);
		} finally {
			resetProjectTrust();
		}
	});

	it("runs gitleaks fresh on a bare git repo with NO explicit gitleaks config (#608 smart-default)", async () => {
		// The whole point of #608: mode=full uses the looser gate (any tracked
		// git repo), not #130's strict opt-in-config gate — no .gitleaks* marker
		// here, only .git, and gitleaks should still run.
		fs.mkdirSync(path.join(tmp, ".git"));
		const cacheManager = makeCacheManager();
		const clients = makeClients();
		(clients.gitleaksClient.scan as ReturnType<typeof vi.fn>).mockResolvedValue(
			{
				success: true,
				findings: [{ ruleId: "aws-key", file: "a.ts", startLine: 1 }],
				scannedAt: "now",
			},
		);

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		expect(clients.gitleaksClient.scan).toHaveBeenCalledTimes(1);
		expect(clients.gitleaksClient.scan).toHaveBeenCalledWith(
			path.resolve(tmp),
			{ requireSignal: false },
		);
		expect(cacheManager.writeCache).toHaveBeenCalledWith(
			"gitleaks",
			expect.objectContaining({ success: true }),
			path.resolve(tmp),
			expect.anything(),
		);
		expect(result.runners).toContain("gitleaks");
	});

	it("still runs gitleaks fresh when both .git and an explicit gitleaks marker are present", async () => {
		fs.mkdirSync(path.join(tmp, ".git"));
		fs.writeFileSync(path.join(tmp, ".gitleaksignore"), "");
		const cacheManager = makeCacheManager();
		const clients = makeClients();
		(clients.gitleaksClient.scan as ReturnType<typeof vi.fn>).mockResolvedValue(
			{
				success: true,
				findings: [],
				scannedAt: "now",
			},
		);

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		expect(clients.gitleaksClient.scan).toHaveBeenCalledTimes(1);
		// A clean scan (no findings) doesn't land in `runners` by design (that
		// list means "contributed a finding"), but `timings` proves it ran.
		expect(result.timings.gitleaks).toBeDefined();
	});

	// #1617: gitleaks (and every other SecurityScanClient-family analyzer —
	// trivy, govulncheck, opengrep — surfaced here too) had ZERO disposition
	// wiring — a mark never suppressed a mode=full finding, only a dispatch
	// (per-edit) one. These prove the fix actually reaches this lane, using
	// the SAME `gitleaksFindingToProjectDiagnostic` identity mode=full already
	// surfaces (so a real agent mark, made against exactly this tool/rule/
	// message/line, is what's being tested here — not a hand-picked shortcut).
	describe("agent/user dispositions filter mode=full findings (#1617)", () => {
		function seedGitRepoWithFinding(): { file: string; content: string } {
			fs.mkdirSync(path.join(tmp, ".git"));
			const content = "const clientId = 'not-a-real-secret';\n";
			fs.writeFileSync(path.join(tmp, "a.ts"), content);
			return { file: path.resolve(tmp, "a.ts"), content };
		}

		it("drops a gitleaks finding the agent marked false-positive", async () => {
			const { file, content } = seedGitRepoWithFinding();
			const cacheManager = makeCacheManager();
			const clients = makeClients();
			(
				clients.gitleaksClient.scan as ReturnType<typeof vi.fn>
			).mockResolvedValue({
				success: true,
				findings: [{ ruleId: "generic-api-key", file: "a.ts", startLine: 1 }],
				scannedAt: "now",
			});

			// Pre-fix baseline: unmarked finding is reported.
			const before = await fetchFreshProjectDiagnostics(
				cacheManager,
				tmp,
				clients,
			);
			expect(before.diagnostics).toHaveLength(1);
			expect(before.dispositionSuppressed ?? 0).toBe(0);

			markDisposition(
				path.resolve(tmp),
				{
					cwd: path.resolve(tmp),
					filePath: file,
					tool: "gitleaks",
					rule: "gitleaks:generic-api-key",
					message: "Potential secret: generic-api-key",
					line: 1,
					content,
				},
				"false-positive",
			);

			const after = await fetchFreshProjectDiagnostics(
				cacheManager,
				tmp,
				clients,
			);
			expect(after.diagnostics).toHaveLength(0);
			expect(after.dispositionSuppressed).toBe(1);
		});

		it("re-reports once the marked line's content changes (the disposition layer's own 'unmark' — no delete API exists anywhere in this store)", async () => {
			// #690's false-positive is STRICT-anchored BY DESIGN (see
			// diagnostic-dispositions.ts's module doc): "if the line is
			// rewritten, the rule earned a fresh chance to fire on the new
			// content, so the mark should NOT follow it." There is no
			// unmark/delete API anywhere on this store (grepped the whole repo
			// before writing this test) — a rewritten line IS how a
			// false-positive mark is undone today. This proves that contract
			// holds through the new mode=full wiring, not just dispatch.
			const { file } = seedGitRepoWithFinding();
			const cacheManager = makeCacheManager();
			const clients = makeClients();
			(
				clients.gitleaksClient.scan as ReturnType<typeof vi.fn>
			).mockResolvedValue({
				success: true,
				findings: [{ ruleId: "generic-api-key", file: "a.ts", startLine: 1 }],
				scannedAt: "now",
			});
			const originalContent = fs.readFileSync(file, "utf-8");
			markDisposition(
				path.resolve(tmp),
				{
					cwd: path.resolve(tmp),
					filePath: file,
					tool: "gitleaks",
					rule: "gitleaks:generic-api-key",
					message: "Potential secret: generic-api-key",
					line: 1,
					content: originalContent,
				},
				"false-positive",
			);
			const suppressed = await fetchFreshProjectDiagnostics(
				cacheManager,
				tmp,
				clients,
			);
			expect(suppressed.diagnostics).toHaveLength(0);

			// The line is rewritten (still triggers the same rule at the same
			// file:line) — the strict anchor's line-content hash no longer
			// matches the mark, so gitleaks re-reporting it is a FRESH finding.
			fs.writeFileSync(file, "const clientId = 'still-not-a-real-secret';\n");
			const restored = await fetchFreshProjectDiagnostics(
				cacheManager,
				tmp,
				clients,
			);
			expect(restored.diagnostics).toHaveLength(1);
			expect(restored.dispositionSuppressed ?? 0).toBe(0);
		});

		it("drops a govulncheck finding marked won't-fix (suppress)", async () => {
			fs.writeFileSync(path.join(tmp, "go.mod"), "module demo\n\ngo 1.21\n");
			const content = "package main\n\nfunc main() {}\n";
			fs.writeFileSync(path.join(tmp, "main.go"), content);
			const cacheManager = makeCacheManager();
			const clients = makeClients();
			(
				clients.govulncheckClient.analyze as ReturnType<typeof vi.fn>
			).mockResolvedValue({
				success: true,
				findings: [
					{
						osv: "GO-2024-0001",
						module: "example.com/vuln",
						trace: [{ filename: "main.go", line: 1 }],
					},
				],
				scannedAt: "now",
			});

			const before = await fetchFreshProjectDiagnostics(
				cacheManager,
				tmp,
				clients,
			);
			expect(before.diagnostics).toHaveLength(1);

			markDisposition(
				path.resolve(tmp),
				{
					cwd: path.resolve(tmp),
					filePath: path.resolve(tmp, "main.go"),
					tool: "govulncheck",
					rule: "govulncheck:GO-2024-0001",
					message:
						"Vulnerability GO-2024-0001: reachable vulnerable dependency",
					line: 1,
					content,
				},
				"suppress",
			);

			const after = await fetchFreshProjectDiagnostics(
				cacheManager,
				tmp,
				clients,
			);
			expect(after.diagnostics).toHaveLength(0);
			expect(after.dispositionSuppressed).toBe(1);
		});
	});

	it("runs govulncheck fresh only when go.mod is present", async () => {
		fs.writeFileSync(path.join(tmp, "go.mod"), "module demo\n\ngo 1.21\n");
		const cacheManager = makeCacheManager();
		const clients = makeClients();

		await fetchFreshProjectDiagnostics(cacheManager, tmp, clients);

		expect(clients.govulncheckClient.analyze).toHaveBeenCalledTimes(1);
		expect(cacheManager.writeCache).toHaveBeenCalledWith(
			"govulncheck",
			expect.anything(),
			path.resolve(tmp),
			expect.anything(),
		);
	});

	it("runs trivy fresh only when opted-in AND a dependency manifest exists", async () => {
		fs.writeFileSync(
			path.join(tmp, ".pi-lens.json"),
			JSON.stringify({ trivy: { enabled: true } }),
		);
		fs.writeFileSync(path.join(tmp, "package.json"), "{}");
		const cacheManager = makeCacheManager();
		const clients = makeClients();

		await fetchFreshProjectDiagnostics(cacheManager, tmp, clients);

		expect(clients.trivyClient.scan).toHaveBeenCalledTimes(1);
		expect(cacheManager.writeCache).toHaveBeenCalledWith(
			"trivy",
			expect.anything(),
			path.resolve(tmp),
			expect.anything(),
		);
	});

	// #1628: before this fix, `TrivyResult.secrets` was never read here at
	// all — only `findings` (CVEs) reached `lens_diagnostics mode=full`. A
	// trivy-only secret finding was a genuine honesty gap: scanned and
	// cached, but never surfaced, and therefore never disposition-suppressible.
	it("surfaces trivy secret findings under the 'trivy' runner and honors dispositions (#1628)", async () => {
		fs.writeFileSync(
			path.join(tmp, ".pi-lens.json"),
			JSON.stringify({ trivy: { enabled: true } }),
		);
		fs.writeFileSync(path.join(tmp, "package.json"), "{}");
		const content = "const apiKey = 'not-a-real-secret';\n";
		fs.writeFileSync(path.join(tmp, "a.ts"), content);
		const cacheManager = makeCacheManager();
		const clients = makeClients();
		(clients.trivyClient.scan as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: true,
			scannedAt: "now",
			findings: [],
			licenses: [],
			secrets: [{ ruleId: "generic-api-key", file: "a.ts", line: 1 }],
		});

		const before = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);
		expect(before.runners).toContain("trivy");
		expect(before.diagnostics).toContainEqual(
			expect.objectContaining({
				tool: "trivy",
				rule: "trivy-secret:generic-api-key",
			}),
		);

		markDisposition(
			path.resolve(tmp),
			{
				cwd: path.resolve(tmp),
				filePath: path.resolve(tmp, "a.ts"),
				tool: "trivy",
				rule: "trivy-secret:generic-api-key",
				message: "Potential secret: generic-api-key",
				line: 1,
				content,
			},
			"false-positive",
		);

		const after = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);
		expect(after.diagnostics).not.toContainEqual(
			expect.objectContaining({ rule: "trivy-secret:generic-api-key" }),
		);
		expect(after.dispositionSuppressed).toBe(1);
	});

	// #585 regression: opengrep was registered in the cache-only extractor
	// registry (extractors.ts) but MISSING from this fresh-fetch path, so its
	// session-start scan cached findings that `lens_diagnostics mode=full` never
	// read back — a scan-and-orphan honesty gap (#533). It must surface here the
	// same way gitleaks/trivy do: fresh scan → cache write → adapted diagnostics.
	it("surfaces opengrep findings (ERROR→blocking, CWE-tagged) and caches them (#585)", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients();
		(clients.opengrepClient.scan as ReturnType<typeof vi.fn>).mockResolvedValue(
			{
				success: true,
				analyzed: true,
				scannedAt: "now",
				findings: [
					{
						checkId: "python.lang.security.audit.subprocess-shell-true",
						path: "src/run.py",
						startLine: 7,
						startCol: 3,
						endLine: 7,
						endCol: 20,
						message: "shell=True is dangerous",
						severity: "ERROR",
						cwe: ["CWE-78: OS Command Injection"],
					},
				],
			},
		);

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		// Structurally always-on: no static project gate, only an availability
		// probe — the scan runs even on a bare tmp dir with no manifest/marker.
		expect(clients.opengrepClient.scan).toHaveBeenCalledTimes(1);
		expect(clients.opengrepClient.scan).toHaveBeenCalledWith(path.resolve(tmp));
		expect(cacheManager.writeCache).toHaveBeenCalledWith(
			"opengrep",
			expect.objectContaining({ success: true }),
			path.resolve(tmp),
			expect.objectContaining({ scanDurationMs: expect.any(Number) }),
		);
		expect(result.runners).toContain("opengrep");
		const diag = result.diagnostics.find((d) => d.runner === "opengrep");
		expect(diag).toMatchObject({
			filePath: path.join(path.resolve(tmp), "src/run.py"),
			line: 7,
			column: 3,
			severity: "error",
			semantic: "blocking",
			tool: "opengrep",
			rule: "opengrep:python.lang.security.audit.subprocess-shell-true",
			message: "shell=True is dangerous (CWE-78: OS Command Injection)",
		});
	});

	it("reports opengrep cold (not clean) when the tool isn't available (#585)", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients();
		(
			clients.opengrepClient.ensureAvailable as ReturnType<typeof vi.fn>
		).mockResolvedValue(false);

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		expect(clients.opengrepClient.scan).not.toHaveBeenCalled();
		expect(result.cold).toContain("opengrep");
		expect(result.runners).not.toContain("opengrep");
	});

	// #1004 regression: test-runner was omitted from ANALYZER_IDS (the same
	// #585-class gap opengrep had) — the turn_end test fire cached findings
	// under "test-runner-findings" but nothing in fetchFreshProjectDiagnostics
	// read them back, so mode=full silently dropped test failures for
	// unedited/project-wide calls. This must FAIL on pre-fix code (ANALYZER_IDS
	// missing "test-runner") and pass once the cache-read task is wired.
	it("surfaces cached test-runner findings via mode=full without re-running the suite (#1004)", async () => {
		const cacheManager = makeCacheManager();
		fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, "src/foo.test.ts"),
			"test('foo', () => {});\n",
		);
		const testResult = {
			file: path.join(path.resolve(tmp), "src/foo.test.ts"),
			runner: "vitest",
			passed: 1,
			failed: 1,
			duration: 42,
			failures: [
				{
					name: "foo works",
					message: "expected true to be false",
					location: "src/foo.test.ts:17",
				},
			],
		};
		const provenance = snapshotAdvisoryProvenance({
			cwd: tmp,
			runtime: { telemetrySessionId: "scan", projectSeq: 0, turnIndex: 0 },
			generation: 1,
			files: [{ path: testResult.file, role: "test" }],
		});
		(cacheManager.readCache as ReturnType<typeof vi.fn>).mockImplementation(
			(scanner: string) => {
				if (scanner === "test-runner-findings") {
					return {
						data: {
							content: "FAIL",
							stale: false,
							results: [testResult],
							provenance,
						},
						meta: { timestamp: new Date().toISOString() },
					};
				}
				return null;
			},
		);
		const clients = makeClients();

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		// Cache-read only — no client method exists to "run" test-runner here,
		// and this must NOT write back to the cache (nothing fresher to write).
		expect(cacheManager.writeCache).not.toHaveBeenCalledWith(
			"test-runner-findings",
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
		expect(result.runners).toContain("test-runner");
		const diag = result.diagnostics.find((d) => d.tool === "test-runner");
		// #1004 review follow-up: `TestFailure.location` ("relPath:line") must
		// reach `ProjectDiagnostic.line` — before the fix every test-runner
		// finding rendered as `L?:` in lens-diagnostics, unlike jscpd/knip/madge
		// which all carry real line numbers.
		expect(diag).toMatchObject({
			filePath: testResult.file,
			line: 17,
			severity: "error",
			semantic: "blocking",
			tool: "test-runner",
			runner: "vitest",
			rule: "test:vitest",
			message: "foo works: expected true to be false",
		});

		const mismatched = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
			undefined,
			{ runtime: new RuntimeCoordinator() },
		);
		expect(
			mismatched.diagnostics.find((d) => d.tool === "test-runner"),
		).toMatchObject({ severity: "info", semantic: "none" });
	});

	// #1004 review follow-up (honesty gap, #533): test-runner's cache can be
	// STALE (the turn advanced before the test run finished —
	// `runtime-turn.ts`'s `stale` flag) — mode=full must not present a stale
	// result as if it were fresh, the same way the one-shot turn-context
	// message already prefixes stale failures.
	it("prefixes test-runner findings with a stale marker when the cache says stale (#1004)", async () => {
		const cacheManager = makeCacheManager();
		const testResult = {
			file: path.join(path.resolve(tmp), "src/bar.test.ts"),
			runner: "vitest",
			passed: 0,
			failed: 1,
			duration: 10,
			failures: [{ name: "bar works", message: "boom" }],
		};
		(cacheManager.readCache as ReturnType<typeof vi.fn>).mockImplementation(
			(scanner: string) => {
				if (scanner === "test-runner-findings") {
					return {
						data: { content: "FAIL", stale: true, results: [testResult] },
						meta: { timestamp: new Date().toISOString() },
					};
				}
				return null;
			},
		);
		const clients = makeClients();

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		const diag = result.diagnostics.find((d) => d.tool === "test-runner");
		expect(diag?.message).toMatch(/^\[stale/);
	});

	it("reports test-runner cold (not clean) when no turn_end cache exists yet (#1004)", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients();

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		expect(result.cold).toContain("test-runner");
		expect(result.runners).not.toContain("test-runner");
	});

	it("runs every applicable dead-code language client and reports 'dead-code' cold only when none apply", async () => {
		const cacheManager = makeCacheManager();
		const pythonClient = {
			id: "python",
			language: "Python",
			detect: vi.fn().mockReturnValue(true),
			analyze: vi.fn().mockResolvedValue({
				success: true,
				language: "python",
				summary: "",
				unusedExports: [
					{
						category: "export",
						kind: "func",
						name: "x",
						file: "z.py",
						line: 9,
					},
				],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				analyzed: true,
			}),
		};
		const clients = makeClients();
		(clients as unknown as { deadCodeClients: unknown[] }).deadCodeClients = [
			pythonClient,
		];

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		expect(pythonClient.detect).toHaveBeenCalledWith(path.resolve(tmp));
		expect(pythonClient.analyze).toHaveBeenCalledTimes(1);
		expect(cacheManager.writeCache).toHaveBeenCalledWith(
			"dead-code-python",
			expect.anything(),
			path.resolve(tmp),
			expect.anything(),
		);
		expect(result.runners).toContain("dead-code");
		expect(result.authoritativeCoverage).toEqual([]);
	});

	it("records only the real opengrep scanned-path evidence", async () => {
		const client = new OpengrepClient();
		client.ensureAvailable = vi.fn().mockResolvedValue(true);
		vi.spyOn(safeSpawn, "safeSpawnAsync").mockImplementationOnce(
			async (_command, args: string[]) => {
				const report = args[args.indexOf("--json-output") + 1];
				// Captured from opengrep 1.25.0 --json on a clean fixture.
				fs.writeFileSync(
					report,
					'{"version":"1.25.0","results":[],"errors":[],"paths":{"scanned":["src/a.py"]},"interfile_languages_used":[],"skipped_rules":[]}',
				);
				return { status: 0, stdout: "", stderr: "" };
			},
		);
		const clients = makeClients();
		(clients as unknown as { opengrepClient: OpengrepClient }).opengrepClient =
			client;
		const result = await fetchFreshProjectDiagnostics(
			makeCacheManager(),
			tmp,
			clients,
		);
		const coverage = result.authoritativeCoverage ?? [];
		expect(coverage).toHaveLength(1);
		expect(coverage[0].runnerId).toBe("opengrep");
		expect(coverage[0].files).toEqual(new Set([path.resolve(tmp, "src/a.py")]));
	});

	it("records analyzed-file coverage for a non-opengrep runner", async () => {
		const scanned = path.join(tmp, "src", "a.ts");
		fs.mkdirSync(path.dirname(scanned), { recursive: true });
		const clients = makeClients({
			knipResult: {
				success: true,
				analyzed: true,
				analyzedFiles: [scanned],
				issues: [],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "ok",
			},
		});
		const result = await fetchFreshProjectDiagnostics(
			makeCacheManager(),
			tmp,
			clients,
		);
		expect(result.authoritativeCoverage).toEqual([
			expect.objectContaining({
				runnerId: "knip",
				files: new Set([scanned]),
			}),
		]);
	});

	it("does not record coverage for a captured failed empty opengrep scan", async () => {
		const client = new OpengrepClient();
		client.ensureAvailable = vi.fn().mockResolvedValue(true);
		vi.spyOn(safeSpawn, "safeSpawnAsync").mockImplementationOnce(
			async (_command, args: string[]) => {
				const report = args[args.indexOf("--json-output") + 1];
				// Captured from opengrep 1.29.0 --json on a symlink-root refusal.
				fs.writeFileSync(
					report,
					'{"version":"1.29.0","results":[],"errors":[{"code":2,"level":"error","type":"SemgrepError","message":"File not found"}],"paths":{"scanned":[]},"skipped_rules":[]}',
				);
				return { status: 2, stdout: "", stderr: "" };
			},
		);
		const clients = makeClients();
		(clients as unknown as { opengrepClient: OpengrepClient }).opengrepClient =
			client;
		const result = await fetchFreshProjectDiagnostics(
			makeCacheManager(),
			tmp,
			clients,
		);
		expect(result.analyzed).not.toContain("opengrep");
		expect(result.authoritativeCoverage).toEqual([]);
	});

	// #2962: the zero-scanned DECLARATION is now carried (an entry with an empty
	// set) instead of being dropped. `analyzed` still contains opengrep so the
	// render layer keeps #2970's analysed-and-found-nothing state; the empty set
	// is what removes its file-level retirement authority.
	it("records an empty coverage declaration for a captured successful empty opengrep scan", async () => {
		const client = new OpengrepClient();
		client.ensureAvailable = vi.fn().mockResolvedValue(true);
		vi.spyOn(safeSpawn, "safeSpawnAsync").mockImplementationOnce(
			async (_command, args: string[]) => {
				const report = args[args.indexOf("--json-output") + 1];
				// Captured from opengrep 1.29.0 --json with no matching language.
				fs.writeFileSync(
					report,
					'{"version":"1.29.0","results":[],"errors":[],"paths":{"scanned":[]},"interfile_languages_used":[],"skipped_rules":[]}',
				);
				return { status: 0, stdout: "", stderr: "" };
			},
		);
		const clients = makeClients();
		(clients as unknown as { opengrepClient: OpengrepClient }).opengrepClient =
			client;
		const result = await fetchFreshProjectDiagnostics(
			makeCacheManager(),
			tmp,
			clients,
		);
		expect(result.analyzed).toContain("opengrep");
		expect(result.authoritativeCoverage).toEqual([
			{
				runnerId: "opengrep",
				root: realpathOrResolve(tmp),
				files: new Set(),
			},
		]);
	});

	// #2962, driven through the production path: the REAL
	// `fetchFreshProjectDiagnostics` result is handed to the REAL
	// `runnerRetirementDecision` — the two production units joined at their own
	// interface, never a hand-shaped coverage array.
	// Captured from opengrep 1.29.0 --json: a complete report (no `errors`) whose
	// `paths.scanned` is empty because no rule language matched the root.
	const COMPLETE_ZERO_SCANNED =
		'{"version":"1.29.0","results":[],"errors":[],"paths":{"scanned":[]},"interfile_languages_used":[],"skipped_rules":[]}';
	// Captured from opengrep's warning-level partial shape: one unlexable file
	// zeroed the scanned set.
	const PARTIAL_ZERO_SCANNED =
		'{"results":[],"errors":[{"level":"warn","message":"invalid UTF-8"}],"paths":{"scanned":[]}}';

	function retained(tool: string): WidgetDiagnostic {
		return {
			tool,
			severity: "warning",
			message: "retained",
			uri: "",
			rule: `${tool}:finding`,
		};
	}

	async function fetchWithOpengrepReport(reportJson: string | undefined) {
		const client = new OpengrepClient();
		client.ensureAvailable = vi
			.fn()
			.mockResolvedValue(reportJson !== undefined);
		vi.spyOn(safeSpawn, "safeSpawnAsync").mockImplementation(
			async (_command, args: string[]) => {
				const flag = args.indexOf("--json-output");
				// Only opengrep's own invocation writes a report; any other spawn
				// this fetch makes must not be handed one.
				if (flag >= 0 && reportJson !== undefined) {
					fs.writeFileSync(args[flag + 1], reportJson);
				}
				return { status: 0, stdout: "", stderr: "" };
			},
		);
		const clients = makeClients();
		(clients as unknown as { opengrepClient: OpengrepClient }).opengrepClient =
			client;
		return await fetchFreshProjectDiagnostics(makeCacheManager(), tmp, clients);
	}

	// Recurrence: one complete opengrep report with `paths.scanned: []` used to
	// retire EVERY retained opengrep finding in the tree, because the missing
	// coverage entry fell through to the whole-root id-only arm.
	it("a complete zero-scanned opengrep report keeps a retained finding", async () => {
		const result = await fetchWithOpengrepReport(COMPLETE_ZERO_SCANNED);
		expect(result.analyzed).toContain("opengrep");
		expect(
			runnerRetirementDecision(
				retained("opengrep"),
				path.join(tmp, "src", "never-scanned.py"),
				new Set(result.analyzed),
				result.authoritativeCoverage,
			),
		).toBe("keep");
	});

	// The over-reach direction: the zero-file declaration belongs to opengrep
	// alone. knip declares no coverage, so its own id-only arm still retires.
	it("a zero-coverage opengrep scan does not change another runner's decision", async () => {
		const result = await fetchWithOpengrepReport(COMPLETE_ZERO_SCANNED);
		expect(result.analyzed).toContain("knip");
		expect(
			runnerRetirementDecision(
				retained("knip"),
				path.join(tmp, "src", "never-scanned.ts"),
				new Set(result.analyzed),
				result.authoritativeCoverage,
			),
		).toBe("retire");
	});

	// #2962's headline premise, measured rather than asserted: a COLD opengrep
	// does not convert another runner's retained findings into keep-forever —
	// coverage is filtered by `entry.runnerId`, so knip still retires. Pinned so
	// the cross-runner leak the issue describes cannot appear later.
	it("coverage state: a cold coverage producer does not change another runner's decision", async () => {
		const result = await fetchWithOpengrepReport(undefined);
		expect(result.cold).toContain("opengrep");
		expect(result.analyzed).not.toContain("opengrep");
		expect(
			runnerRetirementDecision(
				retained("knip"),
				path.join(tmp, "src", "never-scanned.ts"),
				new Set(result.analyzed),
				result.authoritativeCoverage,
			),
		).toBe("retire");
		expect(
			runnerRetirementDecision(
				retained("opengrep"),
				path.join(tmp, "src", "never-scanned.py"),
				new Set(result.analyzed),
				result.authoritativeCoverage,
			),
		).toBe("keep");
	});

	// The unlexable-file case from #2962: the warning-level report zeroes the
	// scanned set, the producer is partial rather than analysed, and the retained
	// finding is kept.
	it("a partial zero-scanned report keeps a retained finding", async () => {
		const result = await fetchWithOpengrepReport(PARTIAL_ZERO_SCANNED);
		expect(result.partial).toContain("opengrep");
		expect(result.analyzed).not.toContain("opengrep");
		expect(
			runnerRetirementDecision(
				retained("opengrep"),
				path.join(tmp, "src", "never-scanned.py"),
				new Set(result.analyzed),
				result.authoritativeCoverage,
			),
		).toBe("keep");
	});

	it("records the zero-coverage producer once per session", async () => {
		await fetchWithOpengrepReport(COMPLETE_ZERO_SCANNED);
		await fetchWithOpengrepReport(COMPLETE_ZERO_SCANNED);
		const group = getDegradationSummary().find(
			({ kind }) => kind === "runner-coverage-empty",
		);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toBe(
			`opengrep:${realpathOrResolve(tmp)}`,
		);
	});

	// Recurrence: a successful partial report used to enter `analyzed` without
	// paths, then render as cold/not-run despite carrying findings.
	it("keeps a partial opengrep scan distinct from cold", async () => {
		const client = new OpengrepClient();
		client.ensureAvailable = vi.fn().mockResolvedValue(true);
		vi.spyOn(safeSpawn, "safeSpawnAsync").mockImplementationOnce(
			async (_command, args: string[]) => {
				const report = args[args.indexOf("--json-output") + 1];
				// Captured from opengrep's warning-level partial report shape.
				fs.writeFileSync(
					report,
					'{"results":[],"errors":[{"level":"warn","message":"invalid UTF-8"}],"paths":{"scanned":[]}}',
				);
				return { status: 0, stdout: "", stderr: "" };
			},
		);
		const clients = makeClients();
		(clients as unknown as { opengrepClient: OpengrepClient }).opengrepClient =
			client;
		const result = await fetchFreshProjectDiagnostics(
			makeCacheManager(),
			tmp,
			clients,
		);
		expect(result.analyzed).not.toContain("opengrep");
		expect(result.partial).toContain("opengrep");
		expect(result.cold).not.toContain("opengrep");
		expect(result.partialReasons?.opengrep).toBe("invalid UTF-8");
		expect(result.authoritativeCoverage).toEqual([]);
	});

	// Recurrence: a warning-level report with findings and scanned paths used to
	// be cached as complete when the fresh-fetch partial branch was bypassed.
	it("keeps findings visible and skips cache for a partial scanned report", async () => {
		const client = new OpengrepClient();
		client.ensureAvailable = vi.fn().mockResolvedValue(true);
		vi.spyOn(safeSpawn, "safeSpawnAsync").mockImplementationOnce(
			async (_command, args: string[]) => {
				const report = args[args.indexOf("--json-output") + 1];
				// Captured from opengrep 1.25.0 --json with one finding and one
				// warning-level skipped-file error.
				fs.writeFileSync(
					report,
					'{"results":[{"check_id":"python.lang.security.audit.subprocess-shell-true","path":"a.py","start":{"line":7,"col":3},"end":{"line":7,"col":20},"extra":{"message":"shell=True is dangerous","severity":"ERROR","metadata":{"cwe":["CWE-78: OS Command Injection"]}}}],"errors":[{"level":"warn","message":"skipped 1 file"}],"paths":{"scanned":["a.py"]}}',
				);
				return { status: 0, stdout: "", stderr: "" };
			},
		);
		const cacheManager = makeCacheManager();
		const clients = makeClients();
		(clients as unknown as { opengrepClient: OpengrepClient }).opengrepClient =
			client;

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
		);

		expect(result.partial).toContain("opengrep");
		expect(result.partialReasons?.opengrep).toBe("skipped 1 file");
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				runner: "opengrep",
				filePath: path.resolve(tmp, "a.py"),
				message: "shell=True is dangerous (CWE-78: OS Command Injection)",
			}),
		);
		expect(cacheManager.writeCache).not.toHaveBeenCalledWith(
			"opengrep",
			expect.anything(),
			path.resolve(tmp),
			expect.anything(),
		);
	});

	it("does not cache a dead-code result that did not analyse the root (#2887)", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients();
		const deadCodeClient = {
			id: "python",
			language: "Python",
			detect: vi.fn().mockReturnValue(true),
			analyze: vi.fn().mockResolvedValue({
				success: true,
				analyzed: false,
				language: "Python",
				summary: "not applicable",
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
			}),
		};
		(clients as unknown as { deadCodeClients: unknown[] }).deadCodeClients = [
			deadCodeClient,
		];

		await fetchFreshProjectDiagnostics(cacheManager, tmp, clients);

		expect(cacheManager.writeCache).not.toHaveBeenCalledWith(
			"dead-code-python",
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
	});

	it("runs all analyzers in parallel, not serially", async () => {
		// Regression guard for the issue's core ask: total wall time should be
		// bounded by the single slowest analyzer, not their sum. Simulate each
		// analyzer taking ~20ms; if they ran serially (7 analyzers) the whole
		// call would take >100ms. In parallel it should stay close to 20ms.
		fs.writeFileSync(path.join(tmp, ".gitleaksignore"), "");
		fs.writeFileSync(path.join(tmp, "go.mod"), "module demo\n\ngo 1.21\n");
		fs.writeFileSync(
			path.join(tmp, ".pi-lens.json"),
			JSON.stringify({ trivy: { enabled: true } }),
		);
		fs.writeFileSync(path.join(tmp, "package.json"), "{}");

		const delay = () => new Promise((res) => setTimeout(res, 20));
		const cacheManager = makeCacheManager();
		const clients = makeClients({ jscpdAvailable: true, madgeAvailable: true });
		for (const key of [
			"knipClient",
			"jscpdClient",
			"depChecker",
			"gitleaksClient",
			"govulncheckClient",
			"trivyClient",
		] as const) {
			const c = clients[key] as unknown as Record<
				string,
				ReturnType<typeof vi.fn>
			>;
			for (const methodName of ["analyze", "scan", "scanProject"]) {
				if (c[methodName]) {
					const original = c[methodName].getMockImplementation() as
						| ((...args: unknown[]) => unknown)
						| undefined;
					c[methodName].mockImplementation(async (...args: unknown[]) => {
						await delay();
						return original ? original(...args) : undefined;
					});
				}
			}
		}

		const start = Date.now();
		await fetchFreshProjectDiagnostics(cacheManager, tmp, clients);
		const elapsed = Date.now() - start;

		// Generous ceiling: serial execution of 6 x 20ms would be >=120ms.
		expect(elapsed).toBeLessThan(100);
	});

	// Shape 4 (an abort listener is a watcher: released on every settle path).
	// The fetch raced its analyzers against the caller's signal with a private
	// listener nothing removed, so each completed fetch left one on the turn's
	// signal.
	it("a completed fetch leaves no abort listener on the caller's signal", async () => {
		fs.writeFileSync(path.join(tmp, "tsconfig.json"), "{}");
		const turn = new AbortController();

		const result = await fetchFreshProjectDiagnostics(
			makeCacheManager(),
			tmp,
			makeClients(),
			turn.signal,
		);

		expect(result.aborted).toBeUndefined();
		expect(getEventListeners(turn.signal, "abort")).toHaveLength(0);
	});

	it("returns promptly with partial results when the signal aborts mid-scan, instead of waiting for every analyzer (#585 follow-up)", async () => {
		fs.writeFileSync(path.join(tmp, "tsconfig.json"), "{}");
		const cacheManager = makeCacheManager();
		const clients = makeClients({ jscpdAvailable: true });

		// knip resolves fast (well within the abort budget); jscpd is mocked to
		// take far longer than the abort fires, simulating a slow analyzer still
		// in flight when mode=full's wall-clock ceiling / Escape fires.
		let jscpdResolve: (() => void) | undefined;
		(clients.jscpdClient.scan as ReturnType<typeof vi.fn>).mockImplementation(
			() =>
				new Promise((resolve) => {
					jscpdResolve = () =>
						resolve({
							success: true,
							duplicatedLines: 0,
							totalLines: 0,
							percentage: 0,
							clones: [],
						});
					// Deliberately never auto-resolves within the test — only via
					// jscpdResolve(), called explicitly after assertions below so
					// the process doesn't leak a dangling timer.
				}),
		);

		const controller = new AbortController();
		const start = Date.now();
		const resultPromise = fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			clients,
			controller.signal,
		);
		setTimeout(() => controller.abort(), 20);

		const result = await resultPromise;
		const elapsed = Date.now() - start;

		// Returned promptly around the abort, not waiting for jscpd's still-
		// pending promise (which would hang the test if awaited directly).
		expect(elapsed).toBeLessThan(500);
		expect(result.aborted).toBe(true);
		expect(result.abortedIds).toContain("jscpd");
		// knip had time to settle before the abort fired.
		expect(result.abortedIds).not.toContain("knip");
		// Aborted analyzers are folded into `cold` too, so a caller that only
		// checks `cold` still treats them as "not a clean verdict" rather than
		// silently absent.
		expect(result.cold).toContain("jscpd");

		// Let the still-in-flight jscpd promise resolve so it doesn't leak
		// across tests / trigger an unhandled rejection warning.
		jscpdResolve?.();
	});
});
