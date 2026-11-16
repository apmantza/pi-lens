// flake-shape: real-process-spawn — #5675: whether a push-only server is asked again about a dependent is decided on the wire (didChange frames and the publications they cause); only a spawned server speaking LSP over stdio shows it
/**
 * #5675: a push-only dependent whose only answer predates the edit is re-asked
 * once, and the answer it gives then is the cascade's observation.
 *
 * Recurrence this prevents: since #5046 a neighbour answer older than the run
 * reads unconfirmed, and nothing asked jdtls again. jdtls republishes ONE
 * importer shortly after the exporter edit (before the cascade starts) and
 * never the other, so the nightly java row only passed when a watcher
 * `Created` newer than the importer's last push (#4320) made the cascade's
 * touch re-send it: a coincidence of the fixture's birth time and the client's
 * start (88 ms idle, 107 ms under load against a 100 ms margin). A long-lived
 * production client never has that Created, so real jdtls importers stayed
 * unconfirmed every time.
 *
 * Production chain: the real `LSPService` and `createLSPClient` over a scripted
 * stdio server (`tests/fixtures/fake-lsp-server.mjs`, `FAKE_LSP_JDTLS_LIKE`),
 * the real review graph, and the real `computeCascadeForFile`. The fixture
 * files are older than the client by 250 ms, so no Created is ever recorded.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	neighbourShowsFinding,
	neighbourVerdict,
} from "../../scripts/lib/lsp-cascade-smoke.mjs";
import {
	_setServersForFileForTests,
	explainServersForFile,
	initLSPConfig,
} from "../../clients/lsp/config.js";
import { getLSPService, resetLSPService } from "../../clients/lsp/index.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { computeCascadeForFile } from "../../clients/dispatch/integration.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { FAKE_LSP_SERVER_PATH } from "../support/fake-lsp-server.js";
import { withEnv } from "../support/with-env.js";
import { waitFor } from "./interleaving-kit.js";
import { pinFixtureHome, setupTestEnvironment } from "./test-utils.js";

// A passthrough spy: the real cascade logger still runs, and the test reads
// the rows the cascade handed it (the success-path record has no other reader).
const logged = vi.hoisted(() => ({
	rows: [] as Array<{
		phase: string;
		neighborFile?: string;
		metadata?: Record<string, unknown>;
	}>,
}));
vi.mock("../../clients/cascade-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/cascade-logger.js")>();
	return {
		...actual,
		logCascade: (entry: Parameters<typeof actual.logCascade>[0]) => {
			logged.rows.push(entry);
			actual.logCascade(entry);
		},
	};
});

const EXPORTER = "export function foo(x: number): number {\n\treturn x;\n}\n";
const EXPORTER_EDITED =
	"export function bar(x: number): number {\n\treturn x;\n}\n";
const IMPORTER = (name: string) =>
	`import { foo } from "./a";\nexport const ${name} = foo(1);\n`;
const FINDING = "no exported member";

let env: ReturnType<typeof setupTestEnvironment>;
let restoreEnv: () => void = () => {};
let restoreHome: () => void = () => {};
const pids = new Set<number>();
let caseSeq = 0;

type Shape = {
	/** The importer jdtls republishes on its own after the exporter edit. */
	early: string;
	/** `0`: the server never answers a re-ask. */
	revalidate: "0" | "1";
	/**
	 * Whether the server row declares `resendRecheck: "rechecks"` (#4782). A
	 * project `lsp.servers` row cannot declare it, so the declared case arms the
	 * test-only selection with the trait added; the default is declared, the
	 * server the cascade's re-send is for.
	 */
	rechecks?: boolean;
};

/**
 * One project, one client: warm all three files, edit the exporter on disk and
 * on the wire, let the server's own early republish land BEFORE the run starts
 * (cascadeStart is taken inside `computeCascadeForFile`), then run the cascade.
 */
async function runShape(shape: Shape) {
	caseSeq += 1;
	const proj = path.join(env.tmpDir, `p${caseSeq}`);
	const trace = path.join(env.tmpDir, `wire-${caseSeq}.log`);
	fs.mkdirSync(path.join(proj, "src"), { recursive: true });
	fs.writeFileSync(path.join(proj, "package.json"), "{}\n");
	fs.writeFileSync(
		path.join(proj, ".pi-lens.json"),
		`${JSON.stringify({
			lsp: {
				disabledServers: ["typescript", "deno"],
				servers: {
					"jdtls-like-5675": {
						command: process.execPath,
						args: [FAKE_LSP_SERVER_PATH],
						extensions: [".ts"],
						rootMarkers: ["package.json"],
						env: {
							FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "1",
							FAKE_LSP_JDTLS_LIKE: "1",
							FAKE_LSP_JDTLS_EXPORTER: "a.ts",
							FAKE_LSP_JDTLS_EARLY: shape.early,
							FAKE_LSP_JDTLS_REVALIDATE: shape.revalidate,
							FAKE_LSP_TRACE_FILE: trace,
						},
					},
				},
			},
		})}\n`,
	);
	const a = path.join(proj, "src", "a.ts");
	const b = path.join(proj, "src", "b.ts");
	const c = path.join(proj, "src", "c.ts");
	fs.writeFileSync(a, EXPORTER);
	fs.writeFileSync(b, IMPORTER("b"));
	fs.writeFileSync(c, IMPORTER("c"));
	// The client must start more than the watcher's birth margin (100 ms) after
	// these files were born, or the watcher records a Created and the cascade's
	// touch re-sends the importer by the #4320 accident this file is about.
	await waitFor(
		() => Date.now() - fs.statSync(c).birthtimeMs,
		(ageMs) => ageMs > 150,
	);

	await initLSPConfig(proj);
	if (shape.rechecks !== false)
		_setServersForFileForTests((filePath) =>
			explainServersForFile(filePath)
				.filter((entry) => entry.selected)
				.map((entry) => ({
					...entry.server,
					resendRecheck: "rechecks" as const,
				})),
		);
	const service = getLSPService();
	for (const file of [a, b, c]) {
		await service.touchFile(file, fs.readFileSync(file, "utf8"), {
			diagnostics: "document",
			collectDiagnostics: true,
			maxClientWaitMs: 15_000,
		});
	}
	const spawned = await service.getClientForFile(b);
	const pid = spawned?.client.getProcessPid?.();
	if (pid) pids.add(pid);

	fs.writeFileSync(a, EXPORTER_EDITED);
	await service.touchFile(a, EXPORTER_EDITED, {
		diagnostics: "document",
		collectDiagnostics: true,
	});
	// The server's own republish of the early importer lands here, before the
	// run starts, so its answer predates cascadeStart (#5046). The warm-up
	// answer was clean; the republish carries the finding.
	if (shape.early !== "") {
		const earlyPath = path.join(proj, "src", shape.early);
		const client = spawned?.client;
		await waitFor(
			() => client?.getDiagnostics(earlyPath).length ?? 0,
			(count) => count > 0,
		);
	}

	const run = await computeCascadeForFile(a, proj, {
		turnSeq: 1,
		writeSeq: 1,
		projectRoot: proj,
	});
	const wire = fs.existsSync(trace)
		? fs.readFileSync(trace, "utf8").split("\n").filter(Boolean)
		: [];
	const changes = (file: string) =>
		wire.filter(
			(line) =>
				line === `recv textDocument/didChange ${pathToFileURL(file).href}`,
		).length;
	return {
		proj,
		run,
		serverId: spawned?.client.serverId,
		/** The importer's answer the server holds after the run. */
		heldFindingsOnB: spawned?.client.getDiagnostics(b).length ?? 0,
		bChanges: changes(b),
		cChanges: changes(c),
		verdict: (rel: string) => neighbourVerdict(run, proj, rel),
		shows: (rel: string) => neighbourShowsFinding(run, rel, FINDING),
	};
}

describe("push-only dependent whose only answer predates the edit (#5675)", () => {
	beforeAll(() => {
		env = setupTestEnvironment("pi-lens-retouch-5675-");
		restoreEnv = withEnv({
			PI_LENS_TEST_MODE: "0",
			PI_LENS_DISABLE_TOOL_INSTALL: "1",
			PI_LENS_DISABLE_LSP_INSTALL: "1",
		});
	});

	beforeEach(() => {
		resetDegradationLedger();
		logged.rows.length = 0;
		restoreHome = pinFixtureHome("retouch-5675").restore;
		setProjectTrustState("trusted");
	});

	afterEach(async () => {
		await getLSPService().shutdown({ fast: true, reason: "test" });
		resetLSPService();
		resetProjectTrust();
		_setServersForFileForTests(undefined);
		restoreHome();
	});

	afterAll(() => {
		for (const pid of pids) {
			try {
				process.kill(pid, 0);
				process.kill(pid, "SIGKILL");
			} catch {
				/* already exited */
			}
		}
		restoreEnv();
		env.cleanup();
	});

	it("concludes both importers when one republished early and the other stayed silent", async () => {
		const r = await runShape({ early: "b.ts", revalidate: "1" });
		expect({
			b: r.verdict("src/b.ts"),
			c: r.verdict("src/c.ts"),
			bShows: r.shows("src/b.ts"),
			cShows: r.shows("src/c.ts"),
		}).toEqual({ b: "findings", c: "findings", bShows: true, cShows: true });
		expect(r.run.result?.formatted).not.toContain("inconclusive");
		// At most one re-touch per neighbour, never a loop: B's re-sent document
		// makes the server republish C inside C's own first wait, so C may need
		// none.
		expect(r.bChanges).toBe(1);
		expect(r.cChanges).toBeLessThanOrEqual(1);
		// #5675 r2 F4: a rescued neighbour leaves one cascade-log row saying the
		// re-touch is what concluded it (a run that fixed nothing logs none).
		const touchRows = (rel: string) =>
			logged.rows.filter(
				(row) =>
					row.phase === "neighbor_touch" &&
					row.neighborFile === path.join(r.proj, rel),
			);
		expect(
			touchRows("src/b.ts").map((row) => ({
				inconclusive: row.metadata?.inconclusive,
				retouched: row.metadata?.retouched,
			})),
		).toEqual([{ inconclusive: false, retouched: true }]);
	}, 90_000);

	it("concludes importers no server republished at all", async () => {
		const r = await runShape({ early: "", revalidate: "1" });
		expect({
			b: r.verdict("src/b.ts"),
			c: r.verdict("src/c.ts"),
		}).toEqual({ b: "findings", c: "findings" });
		expect(r.run.result?.formatted).not.toContain("inconclusive");
		// Each neighbour is re-asked at most once; whichever re-send the server
		// answers first republishes the other.
		expect(r.bChanges).toBeLessThanOrEqual(1);
		expect(r.cChanges).toBeLessThanOrEqual(1);
		expect(r.bChanges + r.cChanges).toBeGreaterThanOrEqual(1);
	}, 90_000);

	it("leaves the importers unconfirmed, never clean, when the re-ask is not answered", async () => {
		const r = await runShape({ early: "b.ts", revalidate: "0" });
		expect({
			b: r.verdict("src/b.ts"),
			c: r.verdict("src/c.ts"),
		}).toEqual({ b: "unconfirmed", c: "unconfirmed" });
		// One re-touch each, even though the first touch's wait expired.
		expect([r.bChanges, r.cChanges]).toEqual([1, 1]);
		expect(r.run.result?.formatted).toContain("no clean result was confirmed");
		const record = getDegradationSummary().find(
			(group) => group.kind === "cascade-pre-edit-answer",
		);
		expect(
			record?.latestReasons.map((entry) => entry.reason).join("\n"),
		).toContain("re-touched");
		// #5675 r2 F3: the record is keyed per server and path, so two silent
		// neighbours are two subjects, never one `:` subject with a count of two.
		const didNotConclude = getDegradationSummary()
			.filter((group) => group.kind === "cascade-pre-edit-answer")
			.flatMap((group) => group.latestReasons)
			.filter((entry) => entry.reason.includes("did not conclude"))
			.map((entry) => entry.subject)
			.sort();
		expect(didNotConclude).toEqual(
			[
				`${r.serverId}:${normalizeMapKey(path.join(r.proj, "src", "b.ts"))}`,
				`${r.serverId}:${normalizeMapKey(path.join(r.proj, "src", "c.ts"))}`,
			].sort(),
		);
	}, 90_000);

	// #5675 r2 F1: #4782's `resendRecheck` trait. A server not declared to
	// re-check unchanged bytes may publish nothing for them (clangd 22.1.0 does
	// not), and a re-send empties the client's answer with none coming, so the
	// importer's held finding is lost. Recurrence: the r1 head re-sent to every
	// push server (probe: didChange frames 1 -> 31 with 30 neighbours, the
	// importer's held finding 1 -> 0, latency 1617 -> 3151 ms).
	it("sends nothing to a server not declared to re-check unchanged bytes", async () => {
		const r = await runShape({
			early: "b.ts",
			revalidate: "0",
			rechecks: false,
		});
		expect([r.bChanges, r.cChanges]).toEqual([0, 0]);
		// The answer the server published before the run is still the one held.
		expect(r.heldFindingsOnB).toBe(1);
		expect({
			b: r.verdict("src/b.ts"),
			c: r.verdict("src/c.ts"),
		}).toEqual({ b: "unconfirmed", c: "unconfirmed" });
		// The #5040 outcome, unchanged: never clean, no cascade result to read.
		expect(r.run.skipReason).toBe("indeterminate");
		expect(r.run.result).toBeUndefined();
		// Still counted as the pre-edit answer it is, and never as a re-touch.
		const reasons = getDegradationSummary()
			.filter((group) => group.kind === "cascade-pre-edit-answer")
			.flatMap((group) => group.latestReasons)
			.map((entry) => entry.reason)
			.join("\n");
		expect(reasons).toContain("no publication for this dependent");
		expect(reasons).not.toContain("re-touched");
		expect(
			logged.rows.filter(
				(row) =>
					row.phase === "neighbor_touch" && row.metadata?.retouched === true,
			),
		).toEqual([]);
	}, 90_000);
});
