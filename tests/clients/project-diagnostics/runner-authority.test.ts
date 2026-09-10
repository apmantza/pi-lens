/**
 * #2154 round 4: a project runner is authoritative for RETIRING a retained
 * finding only when it actually analysed the root during this call.
 *
 * Recurrence this file prevents: PR #2868 round 3 gated authority opt-OUT
 * (`result.analyzed === false`), and only knip and jscpd ever set that flag.
 * The other seven runners were authoritative by default, so a gitleaks that
 * crashed before writing its report (`success: true`, zero findings) and a
 * madge that never ran (no top-level source file) both retired real retained
 * findings. Every case below drives the REAL client to the shape it actually
 * returns; only the process boundary (`safeSpawnAsync`, the availability
 * probes, the binary resolution) is faked.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapClients } from "../../../clients/bootstrap.js";
import { DependencyChecker } from "../../../clients/dependency-checker.js";
import { PythonDeadCodeClient } from "../../../clients/dead-code-client.js";
import { GitleaksClient } from "../../../clients/gitleaks-client.js";
import { GovulncheckClient } from "../../../clients/govulncheck-client.js";
import { JscpdClient } from "../../../clients/jscpd-client.js";
import { KnipClient } from "../../../clients/knip-client.js";
import { OpengrepClient } from "../../../clients/opengrep-client.js";
import { TrivyClient } from "../../../clients/trivy-client.js";
import { fetchFreshProjectDiagnostics } from "../../../clients/project-diagnostics/fresh-fetch.js";
import { removeTempDirSync } from "../test-utils.js";
import { _resetStateCacheForTests } from "../../../clients/diagnostic-dispositions.js";

vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...((await importOriginal()) as typeof import("../../../clients/safe-spawn.js")),
	safeSpawnAsync: vi.fn(async () => ({
		error: null,
		status: 0,
		stdout: "",
		stderr: "",
	})),
}));

const { safeSpawnAsync } = await import("../../../clients/safe-spawn.js");
const spawnMock = vi.mocked(safeSpawnAsync);

type SpawnOutcome = {
	error?: { message: string } | null;
	status?: number | null;
	stdout?: string;
	stderr?: string;
};

/**
 * Write a fake report where the spawned command was told to put one, and
 * nowhere else: an availability probe (`<bin> --version`) reaches the same
 * double, and an unconditional `args[index + 1]` write for an absent flag
 * lands on the repo working directory instead of the fixture.
 */
function reportWriter(flag: string, content: string) {
	return async (_cmd: string, args: string[]) => {
		const at = args.indexOf(flag);
		if (at >= 0 && args[at + 1]) {
			fs.mkdirSync(path.dirname(args[at + 1]), { recursive: true });
			fs.writeFileSync(args[at + 1], content);
		}
		return {
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		} as unknown as Awaited<ReturnType<typeof safeSpawnAsync>>;
	};
}

/**
 * A real `govulncheck -mode=source -format=json` stream: one config record, the
 * OSV entry, then the reachable finding. Record shapes are the ones
 * `tests/clients/govulncheck-client.test.ts` pins against the tool's documented
 * JSON protocol — not invented here.
 */
const GOVULNCHECK_STREAM = [
	JSON.stringify({ config: { protocol_version: "v1.0.0" } }),
	JSON.stringify({
		osv: {
			id: "GO-2024-1234",
			summary: "Path traversal in archive/tar",
			database_specific: { url: "https://pkg.go.dev/vuln/GO-2024-1234" },
			affected: [
				{
					package: { name: "archive/tar" },
					ranges: [{ events: [{ introduced: "0" }, { fixed: "1.21.5" }] }],
				},
			],
		},
	}),
	JSON.stringify({
		finding: {
			osv: "GO-2024-1234",
			fixed_version: "1.21.5",
			trace: [
				{
					module: "archive/tar",
					package: "archive/tar",
					function: "extract",
					position: { filename: "/proj/cmd/main.go", line: 42 },
				},
			],
		},
	}),
].join("\n");

function spawnReturns(outcome: SpawnOutcome): void {
	spawnMock.mockImplementation(
		async () =>
			({
				error: outcome.error ?? null,
				status: outcome.status ?? 0,
				stdout: outcome.stdout ?? "",
				stderr: outcome.stderr ?? "",
			}) as unknown as Awaited<ReturnType<typeof safeSpawnAsync>>,
	);
}

let tmp: string;
let previousDataDir: string | undefined;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-runner-authority-"));
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(tmp, "pi-lens-data");
	_resetStateCacheForTests();
	spawnMock.mockReset();
	spawnReturns({});
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	_resetStateCacheForTests();
	removeTempDirSync(tmp);
});

function makeCacheManager(
	readCache: (scanner: string) => unknown = () => null,
) {
	return {
		writeCache: vi.fn(),
		readCache: vi.fn(readCache),
	} as unknown as import("../../../clients/cache-manager.js").CacheManager & {
		writeCache: ReturnType<typeof vi.fn>;
	};
}

/**
 * Every runner EXCEPT the one under test is held inert through its own
 * production gate (unavailable, or a static project-type signal the tmp
 * fixture does not carry), so `analyzed` names exactly the runner each test
 * drives. knip has no such gate — it is always probed — so its stub reports
 * an unsuccessful run, which lands in `failed`, never in `analyzed`.
 */
function inertClients(overrides: Partial<BootstrapClients> = {}) {
	return {
		knipClient: {
			analyze: vi
				.fn()
				.mockResolvedValue({ success: false, summary: "inert knip stub" }),
		},
		jscpdClient: { ensureAvailable: vi.fn().mockResolvedValue(false) },
		depChecker: { ensureAvailable: vi.fn().mockResolvedValue(false) },
		govulncheckClient: { ensureAvailable: vi.fn().mockResolvedValue(false) },
		gitleaksClient: { ensureAvailable: vi.fn().mockResolvedValue(false) },
		trivyClient: { ensureAvailable: vi.fn().mockResolvedValue(false) },
		opengrepClient: { ensureAvailable: vi.fn().mockResolvedValue(false) },
		deadCodeClients: [],
		...overrides,
	} as unknown as BootstrapClients;
}

// ── through the real fetchFreshProjectDiagnostics ─────────────────────────────

describe("runner authority is opt-in (#2154)", () => {
	it("keeps knip out of the analysed set when the real client finds no project root", async () => {
		const client = new KnipClient(false);

		const result = await fetchFreshProjectDiagnostics(
			makeCacheManager(),
			tmp,
			inertClients({ knipClient: client as never }),
		);

		expect(result.analyzed).not.toContain("knip");
		expect(result.cold).toContain("knip");
	});

	it("marks knip analysed when the real client parses a clean knip report", async () => {
		fs.writeFileSync(path.join(tmp, "package.json"), '{"name":"demo"}');
		spawnReturns({ status: 0, stdout: '{"files":[],"issues":[]}' });
		const client = new KnipClient(false);
		vi.spyOn(
			client as unknown as { ensureAvailable: () => Promise<boolean> },
			"ensureAvailable",
		).mockResolvedValue(true);

		const result = await fetchFreshProjectDiagnostics(
			makeCacheManager(),
			tmp,
			inertClients({ knipClient: client as never }),
		);

		expect(result.analyzed).toContain("knip");
		expect(result.runners).not.toContain("knip");
	});

	it("keeps jscpd out of the analysed set when the real client finds no source files", async () => {
		const client = new JscpdClient(false);
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);

		const result = await fetchFreshProjectDiagnostics(
			makeCacheManager(),
			tmp,
			inertClients({ jscpdClient: client as never }),
		);

		expect(result.analyzed).not.toContain("jscpd");
		expect(result.cold).toContain("jscpd");
	});

	it("keeps madge out of the analysed set when the real dependency checker skips the root", async () => {
		// No top-level .ts/.js file: `DepChecker.scanProject` returns the same
		// `{circular: [], count: 0}` it returns for a real clean scan, without
		// ever spawning madge — the ordinary `src/`-layout repo.
		fs.mkdirSync(path.join(tmp, "src"));
		fs.writeFileSync(path.join(tmp, "src/index.ts"), "export const a = 1;\n");
		const client = new DependencyChecker(false);
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);

		const result = await fetchFreshProjectDiagnostics(
			makeCacheManager(),
			tmp,
			inertClients({ depChecker: client as never }),
		);

		expect(result.analyzed).not.toContain("madge");
	});

	it("keeps gitleaks out of the analysed set when the real scan produces no report", async () => {
		fs.mkdirSync(path.join(tmp, ".git"));
		spawnReturns({ status: 1, stderr: "panic: runtime error" });
		const client = new GitleaksClient(false);
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);

		const result = await fetchFreshProjectDiagnostics(
			makeCacheManager(),
			tmp,
			inertClients({ gitleaksClient: client as never }),
		);

		expect(result.analyzed).not.toContain("gitleaks");
	});

	it("marks gitleaks analysed when the real scan parses a report", async () => {
		fs.mkdirSync(path.join(tmp, ".git"));
		const client = new GitleaksClient(false);
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
		spawnMock.mockImplementation(reportWriter("--report-path", "[]"));

		const result = await fetchFreshProjectDiagnostics(
			makeCacheManager(),
			tmp,
			inertClients({ gitleaksClient: client as never }),
		);

		expect(result.analyzed).toContain("gitleaks");
	});

	it("keeps govulncheck out of the analysed set when the scan produced no output", async () => {
		// The v4 F1 chain, end to end through the record site: a govulncheck
		// that exits 0 having written nothing was authoritative, and deleted a
		// real CVE row from mode=full and mode=all.
		fs.writeFileSync(path.join(tmp, "go.mod"), "module demo\n");
		spawnReturns({ status: 0, stdout: "" });
		const client = new GovulncheckClient(false);
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);

		const result = await fetchFreshProjectDiagnostics(
			makeCacheManager(),
			tmp,
			inertClients({ govulncheckClient: client as never }),
		);

		expect(result.analyzed).not.toContain("govulncheck");
	});

	it("keeps trivy out of the analysed set when the real scan produces no report", async () => {
		fs.writeFileSync(path.join(tmp, "package.json"), '{"name":"demo"}');
		fs.writeFileSync(
			path.join(tmp, ".pi-lens.json"),
			JSON.stringify({ trivy: { enabled: true } }),
		);
		spawnReturns({ status: 1, stderr: "trivy: fatal" });
		const client = new TrivyClient(false);
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);

		const result = await fetchFreshProjectDiagnostics(
			makeCacheManager(),
			tmp,
			inertClients({ trivyClient: client as never }),
		);

		expect(result.analyzed).not.toContain("trivy");
	});

	it("keeps dead-code out of the analysed set when the real client is unavailable", async () => {
		fs.writeFileSync(path.join(tmp, "requirements.txt"), "requests\n");
		const client = new PythonDeadCodeClient(false);
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(false);

		const result = await fetchFreshProjectDiagnostics(
			makeCacheManager(),
			tmp,
			inertClients({ deadCodeClients: [client] as never }),
		);

		expect(result.analyzed).not.toContain("dead-code");
	});

	it("keeps test-runner out of the analysed set on a cache read", async () => {
		// test-runner is a cache read BY DESIGN (fresh-fetch's own task header):
		// it never runs a suite this call, so it can never be authoritative for
		// retiring a finding, however fresh the cached rows look.
		fs.mkdirSync(path.join(tmp, "src"));
		fs.writeFileSync(path.join(tmp, "src/foo.test.ts"), "test('a',()=>{});\n");
		const cacheManager = makeCacheManager((scanner) =>
			scanner === "test-runner-findings"
				? {
						data: {
							content: "FAIL",
							stale: false,
							results: [
								{
									file: path.join(path.resolve(tmp), "src/foo.test.ts"),
									runner: "vitest",
									passed: 0,
									failed: 1,
									duration: 1,
									failures: [
										{
											name: "a",
											message: "boom",
											location: "src/foo.test.ts:3",
										},
									],
								},
							],
						},
						meta: { timestamp: new Date().toISOString() },
					}
				: null,
		);

		const result = await fetchFreshProjectDiagnostics(
			cacheManager,
			tmp,
			inertClients(),
		);

		expect(result.runners).toContain("test-runner");
		expect(result.analyzed).not.toContain("test-runner");
	});
});

// ── the clients' own return shapes ────────────────────────────────────────────

describe("client results carry the analysed-this-root signal (#2154)", () => {
	it("marks the knip result analysed only when it parsed knip output", async () => {
		fs.writeFileSync(path.join(tmp, "package.json"), '{"name":"demo"}');
		const client = new KnipClient(false);
		vi.spyOn(
			client as unknown as { ensureAvailable: () => Promise<boolean> },
			"ensureAvailable",
		).mockResolvedValue(true);

		spawnReturns({
			status: 1,
			stdout: JSON.stringify({
				issues: [{ type: "export", name: "dead", file: "a.ts", line: 1 }],
			}),
		});
		const parsed = await client.analyze(tmp);
		expect(parsed.analyzed).toBe(true);

		// Exit 0 with empty stdout: a real clean knip run always prints
		// `{"issues":[]}`, so this shape is unexplained and must not be
		// authoritative (clients/knip-client.ts's own exit-code table).
		spawnReturns({ status: 0, stdout: "" });
		const empty = await new KnipClient(false).analyze(tmp);
		expect(empty.success).toBe(true);
		expect(empty.analyzed).not.toBe(true);
	});

	it("does not mark a knip memo hit as analysed", async () => {
		fs.writeFileSync(path.join(tmp, "package.json"), '{"name":"demo"}');
		spawnReturns({ status: 0, stdout: '{"issues":[]}' });
		const client = new KnipClient(false);
		vi.spyOn(
			client as unknown as { ensureAvailable: () => Promise<boolean> },
			"ensureAvailable",
		).mockResolvedValue(true);

		const first = await client.analyze(tmp, undefined, { projectSeq: 1 });
		const memo = await client.analyze(tmp, undefined, { projectSeq: 1 });

		expect(first.analyzed).toBe(true);
		expect(memo.execution).toBe("cache");
		expect(memo.analyzed).not.toBe(true);
	});

	it("marks the jscpd result analysed only when it parsed a report", async () => {
		fs.writeFileSync(path.join(tmp, "a.ts"), "export const a = 1;\n");
		const client = new JscpdClient(false);
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);

		// Exit 0 with no report file written.
		spawnReturns({ status: 0 });
		const noReport = await client.scan(tmp);
		expect(noReport.success).toBe(true);
		expect(noReport.analyzed).not.toBe(true);

		spawnMock.mockImplementation(async (_cmd: string, args: string[]) => {
			const at = args.indexOf("--output");
			if (at >= 0 && args[at + 1]) {
				fs.mkdirSync(args[at + 1], { recursive: true });
				fs.writeFileSync(
					path.join(args[at + 1], "jscpd-report.json"),
					JSON.stringify({ statistics: { total: {} }, duplicates: [] }),
				);
			}
			return {
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			} as unknown as Awaited<ReturnType<typeof safeSpawnAsync>>;
		});
		const parsed = await client.scan(tmp);
		expect(parsed.analyzed).toBe(true);
	});

	it("marks the madge scan analysed only when it parsed the dependency graph", async () => {
		fs.writeFileSync(path.join(tmp, "a.ts"), "export const a = 1;\n");
		const client = new DependencyChecker(false);
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
		vi.spyOn(
			client as unknown as {
				resolveMadge: (root: string) => Promise<unknown>;
			},
			"resolveMadge",
		).mockResolvedValue({ cmd: "madge", prefix: [] });

		spawnReturns({ error: { message: "spawn ENOENT" } });
		const crashed = await client.scanProject(tmp);
		expect(crashed.analyzed).not.toBe(true);

		spawnReturns({ status: 0, stdout: "{}" });
		const parsed = await new DependencyChecker(false).scanProject(tmp);
		expect(parsed.analyzed).toBe(true);
	});

	it("marks the gitleaks result analysed only when it parsed a report", async () => {
		const client = new GitleaksClient(false);
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);

		// The strict #130 gate: no opt-in signal, so no scan is attempted.
		const skipped = await client.scan(tmp);
		expect(skipped.success).toBe(true);
		expect(skipped.analyzed).not.toBe(true);

		spawnMock.mockImplementation(reportWriter("--report-path", "[]"));
		const parsed = await client.scan(tmp, { requireSignal: false });
		expect(parsed.analyzed).toBe(true);
	});

	it("marks the trivy result analysed only when it parsed a report", async () => {
		fs.writeFileSync(path.join(tmp, "package.json"), '{"name":"demo"}');
		const client = new TrivyClient(false);
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);

		// Not opted in: `trivy.enabled` is absent from .pi-lens.json.
		const skipped = await client.scan(tmp);
		expect(skipped.success).toBe(true);
		expect(skipped.analyzed).not.toBe(true);

		fs.writeFileSync(
			path.join(tmp, ".pi-lens.json"),
			JSON.stringify({ trivy: { enabled: true } }),
		);
		spawnMock.mockImplementation(
			reportWriter("--output", JSON.stringify({ Results: [] })),
		);
		const parsed = await client.scan(tmp);
		expect(parsed.analyzed).toBe(true);
	});

	it("marks the govulncheck result analysed only when it parsed the scan stream", async () => {
		const client = new GovulncheckClient(false);
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);

		// No go.mod: govulncheck reports success without scanning anything.
		const skipped = await client.analyze(tmp);
		expect(skipped.success).toBe(true);
		expect(skipped.analyzed).not.toBe(true);

		fs.writeFileSync(path.join(tmp, "go.mod"), "module demo\n");

		// Exit 0 with nothing on stdout. `govulncheck -format=json` always
		// writes a JSON stream (config + progress records at minimum), so an
		// empty one is never evidence of "no vulnerabilities" — round 4 parsed
		// it as a clean scan and retired a real CVE row (v4 F1).
		spawnReturns({ status: 0, stdout: "" });
		const empty = await client.analyze(tmp);
		expect(empty.analyzed).not.toBe(true);

		// A real stream, exit 3 (govulncheck's findings-present code). Record
		// shapes taken from the vectors in tests/clients/govulncheck-client.test.ts.
		// Same instance: `dedupeScan` clears a settled run, so this is a second
		// real scan, not a shared one.
		spawnReturns({ status: 3, stdout: GOVULNCHECK_STREAM });
		const parsed = await client.analyze(tmp);
		expect(parsed.analyzed).toBe(true);
		expect(parsed.findings.map((finding) => finding.osv)).toEqual([
			"GO-2024-1234",
		]);
	});

	it("does not mark an aborted govulncheck with partial output as analysed", async () => {
		// `safeSpawnAsync` resolves a timeout / ambient abort as
		// `{status: null, error, stdout: <partial>}`. Parsing that truncated
		// stream yields whatever findings happened to have been flushed, which
		// must never be authoritative over the retained ones (v4 F1).
		fs.writeFileSync(path.join(tmp, "go.mod"), "module demo\n");
		const client = new GovulncheckClient(false);
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);

		spawnReturns({
			status: null,
			error: { message: "spawn timed out after 120000ms" },
			stdout: GOVULNCHECK_STREAM.slice(0, GOVULNCHECK_STREAM.length - 40),
		});
		const aborted = await client.analyze(tmp);

		expect(aborted.analyzed).not.toBe(true);
		expect(aborted.success).toBe(false);
	});

	it("does not mark a non-zero govulncheck with config-only output as analysed", async () => {
		fs.writeFileSync(path.join(tmp, "go.mod"), "module demo\n");
		const client = new GovulncheckClient(false);
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);

		spawnReturns({
			status: 1,
			stdout: JSON.stringify({ config: { protocol_version: "v1.0.0" } }),
			stderr: "loading packages: compile failure",
		});
		const result = await client.analyze(tmp);

		expect(result.success).toBe(false);
		expect(result.analyzed).not.toBe(true);
		expect(result.findings).toHaveLength(0);
	});

	it("does not mark a non-zero govulncheck with config-and-progress output as analysed", async () => {
		fs.writeFileSync(path.join(tmp, "go.mod"), "module demo\n");
		const client = new GovulncheckClient(false);
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);

		spawnReturns({
			status: 1,
			stdout: [
				JSON.stringify({ config: { protocol_version: "v1.0.0" } }),
				JSON.stringify({ progress: { message: "Scanning..." } }),
			].join("\n"),
			stderr: "loading packages: compile failure",
		});
		const result = await client.analyze(tmp);

		expect(result.success).toBe(false);
		expect(result.analyzed).not.toBe(true);
		expect(result.findings).toHaveLength(0);
	});

	it("does not mark a truncated non-zero govulncheck stream as analysed", async () => {
		fs.writeFileSync(path.join(tmp, "go.mod"), "module demo\n");
		const client = new GovulncheckClient(false);
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);

		const osvRecord = GOVULNCHECK_STREAM.split("\n")[1];
		spawnReturns({
			status: 1,
			stdout: [GOVULNCHECK_STREAM.split("\n")[0], osvRecord].join("\n"),
			stderr: "loading packages: compile failure",
		});
		const result = await client.analyze(tmp);

		expect(result.success).toBe(false);
		expect(result.analyzed).not.toBe(true);
		expect(result.findings).toHaveLength(0);
	});

	it("marks the opengrep result analysed only when it parsed a report", async () => {
		const client = new OpengrepClient(false);
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);

		spawnReturns({ status: 1, stderr: "opengrep: fatal" });
		const noReport = await client.scan(tmp);
		expect(noReport.analyzed).not.toBe(true);

		spawnMock.mockImplementation(
			reportWriter("--json-output", JSON.stringify({ results: [] })),
		);
		const parsed = await new OpengrepClient(false).scan(tmp);
		expect(parsed.analyzed).toBe(true);
	});

	it("marks the dead-code result analysed only when vulture ran over the root", async () => {
		const client = new PythonDeadCodeClient(false);
		const available = vi
			.spyOn(client, "ensureAvailable")
			.mockResolvedValue(false);

		// No Python project root anywhere up the tree.
		const noRoot = await client.analyze(tmp);
		expect(noRoot.success).toBe(true);
		expect(noRoot.analyzed).not.toBe(true);

		fs.writeFileSync(path.join(tmp, "requirements.txt"), "requests\n");
		const unavailable = await client.analyze(tmp);
		expect(unavailable.success).toBe(true);
		expect(unavailable.analyzed).not.toBe(true);

		available.mockResolvedValue(true);
		spawnReturns({ status: 0, stdout: "" });
		const parsed = await client.analyze(tmp);
		expect(parsed.analyzed).toBe(true);
	});
});
