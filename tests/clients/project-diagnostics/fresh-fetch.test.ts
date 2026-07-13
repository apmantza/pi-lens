import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapClients } from "../../../clients/bootstrap.js";
import { fetchFreshProjectDiagnostics } from "../../../clients/project-diagnostics/fresh-fetch.js";

// fetchFreshProjectDiagnostics calls each client through the plain
// `BootstrapClients` interface, so a hand-rolled stub (not a real client
// instance) is enough to exercise the orchestration — only the module-level
// static gates (GitleaksClient.hasGitRepo — #608's mode=full smart-default,
// GovulncheckClient.hasGoModule, TrivyClient.shouldScan) run for real, against
// a real tmp-dir fixture.

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-fresh-fetch-"));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
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
		jscpdAvailable: boolean;
		jscpdResult: unknown;
		madgeAvailable: boolean;
		madgeResult: unknown;
	}> = {},
): BootstrapClients {
	return {
		knipClient: {
			analyze: vi.fn().mockResolvedValue({
				success: true,
				issues: overrides.knipIssues ?? [],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "ok",
			}),
		},
		jscpdClient: {
			ensureAvailable: vi
				.fn()
				.mockResolvedValue(overrides.jscpdAvailable ?? false),
			scan: vi.fn().mockResolvedValue(
				overrides.jscpdResult ?? {
					success: true,
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
				.mockResolvedValue(overrides.madgeResult ?? { circular: [], count: 0 }),
		},
		govulncheckClient: {
			ensureAvailable: vi.fn().mockResolvedValue(true),
			analyze: vi.fn().mockResolvedValue({
				success: true,
				findings: [],
				scannedAt: "now",
			}),
		},
		gitleaksClient: {
			ensureAvailable: vi.fn().mockResolvedValue(true),
			scan: vi.fn().mockResolvedValue({
				success: true,
				findings: [],
				scannedAt: "now",
			}),
		},
		trivyClient: {
			ensureAvailable: vi.fn().mockResolvedValue(true),
			scan: vi.fn().mockResolvedValue({
				success: true,
				findings: [],
				scannedAt: "now",
			}),
		},
		deadCodeClients: [],
		// The remaining BootstrapClients fields are unused by fetchFreshProjectDiagnostics.
	} as unknown as BootstrapClients;
}

describe("fetchFreshProjectDiagnostics (#585)", () => {
	it("runs knip fresh and writes its result to cache", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients({
			knipIssues: [
				{ type: "file", name: "dead.ts", file: "dead.ts" },
			],
		});

		const result = await fetchFreshProjectDiagnostics(cacheManager, tmp, clients);

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

	it("reports jscpd cold when the tool isn't available, without writing cache", async () => {
		const cacheManager = makeCacheManager();
		const clients = makeClients({ jscpdAvailable: false });

		const result = await fetchFreshProjectDiagnostics(cacheManager, tmp, clients);

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

		const result = await fetchFreshProjectDiagnostics(cacheManager, tmp, clients);

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
	});

	it("gates govulncheck/trivy on their own static signals, without cache reads", async () => {
		// No go.mod, no .pi-lens.json trivy.enabled — both should report cold
		// and never call analyze()/scan().
		const cacheManager = makeCacheManager();
		const clients = makeClients();

		const result = await fetchFreshProjectDiagnostics(cacheManager, tmp, clients);

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

		const result = await fetchFreshProjectDiagnostics(cacheManager, tmp, clients);

		expect(clients.gitleaksClient.scan).not.toHaveBeenCalled();
		expect(result.cold).toContain("gitleaks");
	});

	it("runs gitleaks fresh on a bare git repo with NO explicit gitleaks config (#608 smart-default)", async () => {
		// The whole point of #608: mode=full uses the looser gate (any tracked
		// git repo), not #130's strict opt-in-config gate — no .gitleaks* marker
		// here, only .git, and gitleaks should still run.
		fs.mkdirSync(path.join(tmp, ".git"));
		const cacheManager = makeCacheManager();
		const clients = makeClients();
		(clients.gitleaksClient.scan as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: true,
			findings: [{ ruleId: "aws-key", file: "a.ts", startLine: 1 }],
			scannedAt: "now",
		});

		const result = await fetchFreshProjectDiagnostics(cacheManager, tmp, clients);

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
		(clients.gitleaksClient.scan as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: true,
			findings: [],
			scannedAt: "now",
		});

		const result = await fetchFreshProjectDiagnostics(cacheManager, tmp, clients);

		expect(clients.gitleaksClient.scan).toHaveBeenCalledTimes(1);
		// A clean scan (no findings) doesn't land in `runners` by design (that
		// list means "contributed a finding"), but `timings` proves it ran.
		expect(result.timings.gitleaks).toBeDefined();
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

	it("runs every applicable dead-code language client and reports 'dead-code' cold only when none apply", async () => {
		const cacheManager = makeCacheManager();
		const pythonClient = {
			id: "python",
			language: "python",
			detect: vi.fn().mockReturnValue(true),
			analyze: vi.fn().mockResolvedValue({
				success: true,
				language: "python",
				summary: "",
				unusedExports: [
					{ category: "export", kind: "func", name: "x", file: "z.py", line: 9 },
				],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
			}),
		};
		const clients = makeClients();
		(clients as unknown as { deadCodeClients: unknown[] }).deadCodeClients = [
			pythonClient,
		];

		const result = await fetchFreshProjectDiagnostics(cacheManager, tmp, clients);

		expect(pythonClient.detect).toHaveBeenCalledWith(path.resolve(tmp));
		expect(pythonClient.analyze).toHaveBeenCalledTimes(1);
		expect(cacheManager.writeCache).toHaveBeenCalledWith(
			"dead-code-python",
			expect.anything(),
			path.resolve(tmp),
			expect.anything(),
		);
		expect(result.runners).toContain("dead-code");
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
			const c = clients[key] as unknown as Record<string, ReturnType<typeof vi.fn>>;
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
