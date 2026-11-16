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
} from "vitest";
import {
	neighbourShowsFinding,
	neighbourVerdict,
} from "../../scripts/lib/lsp-cascade-smoke.mjs";
import { initLSPConfig } from "../../clients/lsp/config.js";
import { getLSPService, resetLSPService } from "../../clients/lsp/index.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { computeCascadeForFile } from "../../clients/dispatch/integration.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { FAKE_LSP_SERVER_PATH } from "../support/fake-lsp-server.js";
import { withEnv } from "../support/with-env.js";
import { waitFor } from "./interleaving-kit.js";
import { pinFixtureHome, setupTestEnvironment } from "./test-utils.js";

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
		restoreHome = pinFixtureHome("retouch-5675").restore;
		setProjectTrustState("trusted");
	});

	afterEach(async () => {
		await getLSPService().shutdown({ fast: true, reason: "test" });
		resetLSPService();
		resetProjectTrust();
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
		expect(r.run.result?.formatted).toContain("no clean result was confirmed");
		// One re-touch each, even though the first touch's wait expired.
		expect([r.bChanges, r.cChanges]).toEqual([1, 1]);
		const record = getDegradationSummary().find(
			(group) => group.kind === "cascade-pre-edit-answer",
		);
		expect(
			record?.latestReasons.map((entry) => entry.reason).join("\n"),
		).toContain("re-touched");
	}, 90_000);
});
