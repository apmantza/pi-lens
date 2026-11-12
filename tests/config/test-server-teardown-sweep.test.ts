/**
 * #4589: a test that starts a real listening server must close it, and await
 * the close, before the case or the file ends — a ratchet.
 *
 * The 2026-10-17 audit of Greptile's reviews counted the same test-hygiene
 * leak seven times (#4563, #4572, #4573, #4574, #4581, #4582, #4586): a case
 * binds a port or a socket path and a later case in the same worker finds it
 * held. The named recurrence for this rule is #4581 (a case that started a
 * real background resource and did not await its own teardown, so it outlived
 * the test). Rule A (`test-env-restore-sweep.test.ts`) covers unrestored env
 * writes; this rule covers the listener. The detector lives in
 * `tests/support/test-server-teardown-gate.ts`; its docstring states the
 * accepted start forms, the accepted teardown placements (a teardown hook, a
 * `finally`, the start's own function, or a local helper every call site
 * settles) and the declared gaps.
 *
 * The state table the sweep decides from, one row per form:
 *
 * | start form | teardown form | verdict |
 * |---|---|---|
 * | `const s = createServer(...)`, pushed to a module array | `afterEach` iterates it, awaiting `Promise.all(... map(s => new Promise(r => s.close(r))))` | closed |
 * | `const s = net.createServer(...)`, pushed to a describe's array | `afterEach` awaits `new Promise(r => s.close(r))` per element | closed |
 * | `const s = http.createServer(...)`, assigned to `server` | `afterEach` awaits `new Promise(r => server.close(r))` | closed |
 * | `const s = net.createServer(...)`, `.listen` and close in one helper | `await new Promise(r => s.close(r))` in the same function | closed |
 * | `const s = net.createServer(...)` | `afterEach(() => new Promise(r => s.close(r)))` (the hook returns it) | closed |
 * | `const s = net.createServer(...)` | `afterEach(closeServer)`, a same-file function that awaits the close | closed |
 * | `const s = net.createServer(...)` | `const closed = new Promise(...); await closed;` | closed |
 * | `const s = net.createServer(...)` | `if (NEVER) await closed;`, the close outside that branch | unawaited — the await may never run |
 * | `const s = net.createServer(...)` | `async function unused(){ await closed; }`, nobody calls it | unawaited |
 * | `const s = net.createServer(...)` | `setTimeout(async () => { await p; }, 0)`, a callback the hook does not await | unawaited |
 * | `let s; s = net.createServer(...)` at file scope | `afterEach` calls `s.close()`, unawaited | unawaited (baseline) |
 * | `const s = net.createServer(...)` | `finally { s.closeAllConnections?.(); s.close(); }`, unawaited | unawaited (baseline) |
 * | a helper returns `{ close: () => new Promise(d => s.close(d)) }` | caller awaits `handle.close()` | helper (baseline) |
 * | `new WebSocketServer({ port })` | none | unresolvable — always reported |
 * | `Bun.serve({ port })` | none | unresolvable — the handle is not readable |
 * | `const { serve } = Bun; serve({ port })` | none | unresolvable — a runtime global's own function |
 * | `dgram.createSocket("udp4").bind(0)` | none | unresolvable — a start verb on a socket handle |
 * | `socket["bind"](0)`, a computed start verb | none | unclosed — the computed spelling is the same start |
 * | `socket[verb](0)`, a computed key nobody can read | none | unresolvable — never clean |
 *
 * Settlement is proven on the awaited VALUE, never on proximity (F1), and only
 * where that `await` runs on the hook's or helper's own straight-line path
 * (N1, shape 43):
 * `await xs.forEach(...)` and `await xs.map(...)` await undefined and an array,
 * `Promise.race` can settle on another value, and a helper that creates the
 * promise without returning it settles nothing — all report. A `bind`/`serve`
 * on a receiver that is not a socket or server handle is
 * `Function.prototype.bind`, not a start, and that reading is declared in the
 * detector's docstring.
 *
 * A `.listen` receiver that is not a plain identifier, a computed start verb
 * whose key or receiver the scan cannot read, and a server construction the
 * binding scan cannot attribute to a start, are reported as `unresolvable`
 * rather than counted clean (AGENTS.md shape 69): the detector fails closed on
 * a start spelling it does not know.
 *
 * The baseline (`tests/support/test-server-teardown-baseline.ts`) admits the
 * starts already unproven on master, so this lands as a ratchet instead of a
 * mass edit. Every admitted row carries a reason in
 * `tests/support/test-server-teardown-admissions.ts`, re-checked here against
 * the file's own close evidence: a new row cannot be admitted by appending one
 * line (AGENTS.md shape 38).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFile,
	readWalkedFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { TEST_SERVER_TEARDOWN_ADMISSIONS } from "../support/test-server-teardown-admissions.js";
import { TEST_SERVER_TEARDOWN_BASELINE } from "../support/test-server-teardown-baseline.js";
import {
	escapeRowKey,
	findUnclosedServerStarts,
	type ServerTeardownFinding,
	serverTeardownKey,
	serverTeardownMechanisms,
} from "../support/test-server-teardown-gate.js";
import {
	scaledTestTimeout,
	TREE_WALK_TIMEOUT_MS,
} from "../support/test-timeout-scale.js";

const REPO_ROOT = path.resolve(__dirname, "../..");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");
const BASELINE_PATH = path.join(
	REPO_ROOT,
	"tests/support/test-server-teardown-baseline.ts",
);
const BASELINE_HEADER =
	"#4589 baseline: the started servers already unproven on master, admitted so the sweep is a ratchet, not a mass edit.";
/** The admission guard's row spelling; a regenerated row must pass it. */
const ROW_RE = /^tests\/[\w./-]+\.ts:[^\s]+$/;
/**
 * #5508: the budget for the admission re-check, which classifies every
 * distinct admitted file with the detector's own parser. Its cost is the
 * admitted-file population, and that population grows as rows are admitted, so
 * vitest's 5 s default is a flake the next admission row re-arms. Measured
 * through the built seam: 1.07 s for 4 rows over 3 files when every row
 * classified the file itself, about 0.2 s now (Linux). The Windows leg did not
 * get faster: 1.05-1.77 s before and 1.48 s after, with one 5000 ms timeout
 * under runner contention. 20 s is about 14x the calm Windows figure and 4x the worst
 * observation, and the lane's `PI_LENS_TEST_TIMEOUT_SCALE` widens it there.
 */
const ADMISSION_RECHECK_TIMEOUT_MS = scaledTestTimeout(20_000);
const BASELINE: ReadonlySet<string> = new Set(TEST_SERVER_TEARDOWN_BASELINE);

function detectAcrossFiles(files: string[]): ServerTeardownFinding[] {
	const findings: ServerTeardownFinding[] = [];
	for (const { file, source } of readWalkedFiles(files)) {
		// Repo-relative, so a baseline row survives a lane's absolute path.
		findings.push(
			...findUnclosedServerStarts(relativePosix(REPO_ROOT, file), source),
		);
	}
	return findings;
}

let sweepPromise: ServerTeardownFinding[] | undefined;

function sweepOnce(): ServerTeardownFinding[] {
	if (sweepPromise) return sweepPromise;
	const files = listSourceFiles(TESTS_ROOT, { extensions: [".ts"] });
	// Floor 1,500 against the ~1,600 `tests/**/*.ts` at authoring time: low
	// enough that ordinary churn never trips it, high enough that a silently
	// dropped directory does (shape 10).
	assertNonEmptyScan("#4589 server-teardown sweep", files.length, 1500);
	sweepPromise = detectAcrossFiles(files);
	return sweepPromise;
}

/** Baseline rows the live tree no longer reports, so the list only shrinks. */
function staleBaselineRows(
	findings: readonly ServerTeardownFinding[],
	baseline: ReadonlySet<string>,
): string[] {
	const live = new Set(findings.map(serverTeardownKey));
	return [...baseline].filter((entry) => !live.has(entry)).sort();
}

/**
 * Keys the live tree reports that the baseline does not admit. One row per
 * distinct `file:receiver`: a second start of an admitted binding in the same
 * file is the same decision, not a new offender.
 */
function unadmittedOffenders(
	findings: readonly ServerTeardownFinding[],
	baseline: ReadonlySet<string>,
): string[] {
	const reported = new Map<string, ServerTeardownFinding>();
	for (const finding of findings) {
		const entry = serverTeardownKey(finding);
		if (baseline.has(entry) || reported.has(entry)) continue;
		reported.set(entry, finding);
	}
	return [...reported.values()]
		.map(
			(finding) =>
				`${serverTeardownKey(finding)} (${finding.verdict} at line ${finding.line}): ${finding.reason}`,
		)
		.sort();
}

describe("#4589 server-teardown detector — the shapes that must red and green", () => {
	const detect = (source: string) =>
		findUnclosedServerStarts("tests/config/case.test.ts", source);

	it("reds on a listener nothing closes (#4581: a case starts a real resource and never tears it down)", () => {
		expect(
			scanListen([
				"const server = net.createServer(() => {});",
				"await new Promise((resolve) => server.listen(endpoint, resolve));",
			]),
		).toEqual([["server", "unclosed"]]);
	});

	it("reds on a close that is not awaited (#4581: a teardown that starts and is never awaited)", () => {
		// `net.Server.close()` returns the server, so neither a bare call nor
		// `await server.close()` settles: only the callback form, wrapped in a
		// promise, has a completion to await.
		for (const close of [
			"\tserver.close();",
			"\tawait server.close();",
			"\tserver.close(() => resolveClose());",
		]) {
			const findings = detect(
				[
					"const server = net.createServer(() => {});",
					"await new Promise((resolve) => server.listen(endpoint, resolve));",
					"afterEach(() => {",
					close,
					"});",
				].join("\n"),
			);
			expect(
				findings.map((finding) => [finding.server, finding.verdict]),
				close,
			).toEqual([["server", "unawaited"]]);
			expect(findings[0]?.mechanism, close).toBe("teardown");
		}
	});

	it("greens on an awaited close in a teardown hook", () => {
		expect(
			scanListen([
				"const server = net.createServer(() => {});",
				"await new Promise((resolve) => server.listen(endpoint, resolve));",
				"afterEach(async () => {",
				"\tawait new Promise((resolve) => server.close(() => resolve()));",
				"});",
			]),
		).toEqual([]);
	});

	it("greens on a close in the start's own `finally`", () => {
		expect(
			scanListen([
				"it('a', async () => {",
				"\tconst server = net.createServer(() => {});",
				"\tawait new Promise((resolve) => server.listen(endpoint, resolve));",
				"\ttry {",
				"\t\tawait run();",
				"\t} finally {",
				"\t\tawait new Promise((resolve) => server.close(() => resolve()));",
				"\t}",
				"});",
			]),
		).toEqual([]);
	});

	it("serves the sonar shape: a module array closed in afterEach through Promise.all", () => {
		expect(
			scanListen([
				"const servers = [];",
				"afterEach(async () => {",
				"\tawait Promise.all(",
				"\t\tservers.splice(0).map(",
				"\t\t\t(server) =>",
				"\t\t\t\tnew Promise((resolveClose) =>",
				"\t\t\t\t\tserver.close(() => resolveClose()),",
				"\t\t\t\t),",
				"\t\t),",
				"\t);",
				"});",
				"async function start() {",
				"\tconst server = net.createServer(() => {});",
				"\tservers.push(server);",
				"\tawait new Promise((resolveListen) => server.listen(0, resolveListen));",
				"}",
			]),
		).toEqual([]);
	});

	it("serves the ipc-frame-bounds shape: a describe array closed in a for-of afterEach", () => {
		expect(
			scanListen([
				"describe('x', () => {",
				"\tconst sockets = [];",
				"\tafterEach(async () => {",
				"\t\tfor (const server of sockets.splice(0)) {",
				"\t\t\tawait new Promise((resolve) => server.close(() => resolve()));",
				"\t\t}",
				"\t});",
				"\tit('a', async () => {",
				"\t\tconst server = net.createServer(() => {});",
				"\t\tsockets.push(server);",
				"\t\tawait new Promise((resolve) => server.listen(endpoint, resolve));",
				"\t});",
				"});",
			]),
		).toEqual([]);
	});

	it("greens on Promise.all over an array of close promises", () => {
		// The awaited value is the combinator's promise, and the array holds the
		// close promises themselves (not a callback's return values).
		expect(
			scanListen([
				"const server = net.createServer(() => {});",
				"await new Promise((resolve) => server.listen(0, resolve));",
				"afterEach(async () => {",
				"\tawait Promise.all([",
				"\t\tnew Promise((resolve) => server.close(() => resolve())),",
				"\t]);",
				"});",
			]),
		).toEqual([]);
	});

	it("follows a `let server; server = local` alias, and a close in the start's function", () => {
		expect(
			scanListen([
				"let server;",
				"async function serve() {",
				"\tconst local = http.createServer(() => {});",
				"\tawait new Promise((resolve) => local.listen(0, resolve));",
				"\tserver = local;",
				"}",
				"afterEach(async () => {",
				"\tif (server) await new Promise((r) => server.close(() => r()));",
				"});",
			]),
		).toEqual([]);
	});

	it("reports a returned close closure as `helper`, and a settled close elsewhere as `misplaced`", () => {
		// A close the detector cannot follow is reported, never credited: the
		// handle crosses a return value (the analyze-cli stub shape).
		expect(
			scanListen([
				"function startStub() {",
				"\tconst server = net.createServer(() => {});",
				"\treturn new Promise((resolve) => server.listen(endpoint, () =>",
				"\t\tresolve({ close: () => new Promise((done) => { server.close(() => done()); }) }),",
				"\t));",
				"}",
			]),
		).toEqual([["server", "helper"]]);
		// A settled close with no accepted placement: the listener is closed and
		// awaited, but at module scope, where no teardown can rely on it running.
		expect(
			scanListen([
				"const server = net.createServer(() => {});",
				"it('a', async () => {",
				"\tawait new Promise((resolve) => server.listen(endpoint, resolve));",
				"});",
				"await new Promise((resolve) => server.close(() => resolve()));",
			]),
		).toEqual([["server", "misplaced"]]);
	});

	it("follows a local helper whose every call site awaits it", () => {
		expect(
			scanListen([
				"function stop() {",
				"\treturn new Promise((resolve) => server.close(() => resolve()));",
				"}",
				"it('a', async () => {",
				"\tconst server = net.createServer(() => {});",
				"\tawait new Promise((resolve) => server.listen(endpoint, resolve));",
				"\tawait stop();",
				"});",
			]),
		).toEqual([]);
		// One unawaited call site voids the helper credit.
		expect(
			scanListen([
				"function stop() {",
				"\treturn new Promise((resolve) => server.close(() => resolve()));",
				"}",
				"it('a', async () => {",
				"\tconst server = net.createServer(() => {});",
				"\tawait new Promise((resolve) => server.listen(endpoint, resolve));",
				"\tawait stop();",
				"});",
				"it('b', () => {",
				"\tstop();",
				"});",
			]),
		).toEqual([["server", "unawaited"]]);
	});

	it("settles only when the awaited value is the close promise (F1, escapes)", () => {
		// A `.listen` start pushed to a module array, closed inside `afterEach`.
		const arrayTeardown = (body: string[]): string[] => [
			"const servers = [];",
			"afterEach(async () => {",
			...body,
			"});",
			"async function start() {",
			"\tconst server = net.createServer(() => {});",
			"\tservers.push(server);",
			"\tawait new Promise((resolve) => server.listen(0, resolve));",
			"}",
		];
		const escapes: Array<[string, string[]]> = [
			[
				"forEach discards the callback's value",
				[
					"\tawait servers.forEach((server) =>",
					"\t\tnew Promise((resolve) => server.close(() => resolve())),",
					"\t);",
				],
			],
			[
				"map without Promise.all awaits an array",
				[
					"\tawait servers.map((server) =>",
					"\t\tnew Promise((resolve) => server.close(() => resolve())),",
					"\t);",
				],
			],
			[
				"Promise.race can settle on another value",
				[
					"\tawait Promise.race([",
					"\t\tnew Promise((resolve) => server.close(() => resolve())),",
					"\t\ttimeout,",
					"\t]);",
				],
			],
			[
				"awaiting an array of promises settles none of them",
				["\tawait [new Promise((resolve) => server.close(() => resolve()))];"],
			],
			[
				"a stored promise whose reference nothing settles",
				[
					"\tconst closed = new Promise((resolve) =>",
					"\t\tserver.close(() => resolve()),",
					"\t);",
					"\tvoid closed;",
				],
			],
			[
				"a stored promise nothing awaits at all",
				[
					"\tconst closed = new Promise((resolve) =>",
					"\t\tserver.close(() => resolve()),",
					"\t);",
				],
			],
		];
		for (const [label, body] of escapes) {
			const findings = detect(arrayTeardown(body).join("\n"));
			expect(
				findings.map((finding) => [
					finding.server,
					finding.verdict,
					finding.mechanism,
				]),
				label,
			).toEqual([["server", "unawaited", "teardown"]]);
		}
	});

	it("reports a helper that creates the close promise and drops it (F1)", () => {
		expect(
			scanListen([
				"const server = net.createServer(() => {});",
				"await new Promise((resolve) => server.listen(endpoint, resolve));",
				"function stop() {",
				"\tnew Promise((resolve) => server.close(() => resolve()));",
				"}",
				"await stop();",
			]),
		).toEqual([["server", "unawaited"]]);
	});

	it("reports a settlement form nobody listed (a derived promise)", () => {
		// The close promise is consumed through `.then(...)`, whose own promise
		// nobody awaits. The detector does not reason about a derived promise,
		// so the row reports instead of passing (shape 69, fail closed).
		expect(
			scanListen([
				"it('a', async () => {",
				"\tconst server = net.createServer(() => {});",
				"\tawait new Promise((resolve) => server.listen(endpoint, resolve));",
				"\tawait new Promise((resolve) => server.close(() => resolve())).then(",
				"\t\t() => undefined,",
				"\t);",
				"});",
			]),
		).toEqual([["server", "unawaited"]]);
	});

	it("credits only the fulfillment callback of a then-chain (R1, shape 69)", () => {
		// `then`'s SECOND argument and a `catch` callback run only on rejection,
		// so neither proves the close was awaited on the hook's own path. Only
		// the fulfillment callback chains into the promise the call returns; a
		// `finally` callback always runs and is credited for the same reason.
		const holdClose = [
			"it('a', async () => {",
			"\tconst server = net.createServer(() => {});",
			"\tawait new Promise((resolve) => server.listen(endpoint, resolve));",
			"\tconst closed = new Promise((resolve) => server.close(() => resolve()));",
		];
		const rejected: Array<[string, string]> = [
			[
				"a second then argument",
				"\tawait Promise.resolve().then(undefined, async () => { await closed; });",
			],
			[
				"a fulfillment callback that does not wait, next to a rejection one",
				"\tawait Promise.resolve().then(\n\t\t() => undefined,\n\t\tasync () => { await closed; },\n\t);",
			],
			[
				"a catch callback",
				"\tawait Promise.resolve().catch(async () => { await closed; });",
			],
		];
		for (const [label, tail] of rejected) {
			expect(scanListen([...holdClose, tail, "});"]), label).toEqual([
				["server", "unawaited"],
			]);
		}
		// The legitimately credited forms, same close.
		for (const [label, tail] of [
			[
				"the fulfillment callback",
				"\tawait Promise.resolve().then(async () => { await closed; });",
			],
			[
				"the finally callback",
				"\tawait Promise.resolve().finally(async () => { await closed; });",
			],
		] as Array<[string, string]>) {
			expect(scanListen([...holdClose, tail, "});"]), label).toEqual([]);
		}
	});

	it("greens on the teardown forms vitest awaits (F1, false positives)", () => {
		const forms: Array<[string, string[]]> = [
			[
				"the hook returns the promise",
				[
					"const server = net.createServer(() => {});",
					"await new Promise((resolve) => server.listen(endpoint, resolve));",
					"afterEach(() =>",
					"\tnew Promise((resolve) => server.close(() => resolve())),",
					");",
				],
			],
			[
				"the hook is handed the function by reference",
				[
					"const server = net.createServer(() => {});",
					"await new Promise((resolve) => server.listen(endpoint, resolve));",
					"async function closeServer() {",
					"\tawait new Promise((resolve) => server.close(() => resolve()));",
					"}",
					"afterEach(closeServer);",
				],
			],
			[
				"the hook is handed a function that returns the promise",
				[
					"const server = net.createServer(() => {});",
					"await new Promise((resolve) => server.listen(endpoint, resolve));",
					"function closeServer() {",
					"\treturn new Promise((resolve) => server.close(() => resolve()));",
					"}",
					"afterEach(closeServer);",
				],
			],
			[
				"the promise is stored and awaited later",
				[
					"it('a', async () => {",
					"\tconst server = net.createServer(() => {});",
					"\tawait new Promise((resolve) => server.listen(endpoint, resolve));",
					"\tconst closed = new Promise((resolve) =>",
					"\t\tserver.close(() => resolve()),",
					"\t);",
					"\tawait closed;",
					"});",
				],
			],
		];
		for (const [label, form] of forms) {
			expect(detect(form.join("\n")), label).toEqual([]);
		}
	});

	it("credits an await only where the hook or helper actually runs it (N1, shape 43)", () => {
		// The close promise exists, and an `await` on it exists, but the hook
		// returns before that await runs: the listener can outlive the case. Each
		// row is inside an accepted teardown placement, so a green row is a
		// silent pass.
		const teardown = (body: string[]): string[] => [
			"const server = net.createServer(() => {});",
			"await new Promise((resolve) => server.listen(endpoint, resolve));",
			"afterEach(async () => {",
			...body,
			"});",
		];
		const unproven: Array<[string, string[]]> = [
			[
				"a nested function nobody calls",
				[
					"\tconst closed = new Promise((resolve) =>\n\t\tserver.close(() => resolve())\n\t);",
					"\tasync function unused() { await closed; }",
				],
			],
			[
				"a callback the hook does not await",
				[
					"\tsetTimeout(async () => { await new Promise((resolve) => server.close(() => resolve())); }, 0);",
				],
			],
			[
				"a dead branch",
				[
					"\tconst closed = new Promise((resolve) =>\n\t\tserver.close(() => resolve())\n\t);",
					"\tif (process.env.NEVER_SET) await closed;",
				],
			],
			// A plant nobody listed: the same unreachability through a
			// short-circuit operand, which is not a branch statement at all.
			[
				"a short-circuit operand",
				[
					"\tconst closed = new Promise((resolve) =>\n\t\tserver.close(() => resolve())\n\t);",
					"\tprocess.env.NEVER_SET && (await closed);",
				],
			],
			[
				"a map callback nothing collects",
				[
					"\t[server].map(async () => { await new Promise((resolve) => server.close(() => resolve())); });",
				],
			],
			// A logical assignment evaluates its right side only when its operator's
			// condition holds, so the await may never run (E4).
			[
				"a logical assignment",
				[
					"\tconst closed = new Promise((resolve) =>\n\t\tserver.close(() => resolve())\n\t);",
					"\tlet k = 1;",
					"\tk ||= await closed;",
				],
			],
			[
				"an and-assignment",
				[
					"\tconst closed = new Promise((resolve) =>\n\t\tserver.close(() => resolve())\n\t);",
					"\tlet k = 0;",
					"\tk &&= await closed;",
				],
			],
		];
		for (const [label, body] of unproven) {
			expect(
				detect(teardown(body).join("\n")).map((finding) => [
					finding.server,
					finding.verdict,
				]),
				label,
			).toEqual([["server", "unawaited"]]);
		}
		// The forms that do run the await: a guard enclosing BOTH the close and
		// its await, and a callback whose returned promise a combinator settles.
		const proven: Array<[string, string[]]> = [
			[
				"a guard that encloses the close and its await",
				[
					"\tif (server) await new Promise((resolve) => server.close(() => resolve()));",
				],
			],
			[
				"a combinator over the callbacks' promises",
				[
					"\tawait Promise.all([server].map(async () => { await new Promise((resolve) => server.close(() => resolve())); }));",
				],
			],
			[
				"a nested helper the hook awaits",
				[
					"\tconst closed = new Promise((resolve) =>\n\t\tserver.close(() => resolve())\n\t);",
					"\tasync function settle() { await closed; }",
					"\tawait settle();",
				],
			],
			[
				"an awaited IIFE",
				[
					"\tawait (async () => { await new Promise((resolve) => server.close(() => resolve())); })();",
				],
			],
			[
				"an awaited then callback",
				[
					"\tawait Promise.resolve().then(async () => { await new Promise((resolve) => server.close(() => resolve())); });",
				],
			],
		];
		const missed: string[] = [];
		for (const [label, body] of proven) {
			const found = detect(teardown(body).join("\n"));
			if (found.length > 0)
				missed.push(`${label}: ${found.map((f) => f.verdict).join()}`);
		}
		expect(missed).toEqual([]);
	});

	it("reports a start verb on a handle the scan cannot follow (F4)", () => {
		// `Bun.serve` binds a port with no handle the detector can read.
		expect(
			scanListen([
				"const handle = Bun.serve({ port: 0, fetch: () => new Response() });",
			]),
		).toEqual([["Bun", "unresolvable"]]);
		// A socket `bind` is a start: inline, and through a readable variable.
		expect(scanListen(['dgram.createSocket("udp4").bind(0);'])).toEqual([
			['dgram.createSocket("udp4")', "unresolvable"],
		]);
		expect(
			scanListen([
				'const socket = dgram.createSocket("udp4");',
				"socket.bind(0);",
			]),
		).toEqual([["socket", "unclosed"]]);
		// `Function.prototype.bind` on a value that is not a handle is not a
		// start: it is the declared gap, and the "bind census" case below counts
		// that population from the same parser.
		expect(
			scanListen(["const fn = () => {};", "const bound = fn.bind(null);"]),
		).toEqual([]);
	});

	it("reports a computed or indirect start verb on a readable handle (N3, shape 34)", () => {
		// A computed member is the same start as the dot spelling (shape 34).
		expect(
			scanListen([
				'const socket = dgram.createSocket("udp4");',
				'socket["bind"](0);',
			]),
		).toEqual([["socket", "unclosed"]]);
		expect(scanListen(['dgram.createSocket("udp4")["bind"](0);'])).toEqual([
			['dgram.createSocket("udp4")', "unresolvable"],
		]);
		// A computed `listen` on a readable server is that server's start, not an
		// anonymous construction row.
		expect(
			scanListen([
				"const server = net.createServer(() => {});",
				"await new Promise((resolve) => server['listen']?.(0, resolve));",
			]),
		).toEqual([["server", "unclosed"]]);
		// A computed verb the scan cannot read is reported, never clean, even
		// when the handle is provably closed and awaited.
		expect(
			scanListen([
				'const socket = dgram.createSocket("udp4");',
				'const verb = "bind";',
				"socket[verb](1);",
				"afterEach(async () => {",
				"\tawait new Promise((resolve) => socket.close(() => resolve()));",
				"});",
			]),
		).toEqual([["socket", "unresolvable"]]);
		// A start verb reached through a runtime global's own function, or an
		// alias of one: `serve` is a start the handle scan cannot see through.
		expect(
			scanListen(["const { serve } = Bun;", "serve({ port: 0 });"]),
		).toEqual([["serve", "unresolvable"]]);
		expect(
			scanListen(["const runtime = Bun;", "runtime.serve({ port: 0 });"]),
		).toEqual([["runtime", "unresolvable"]]);
		expect(scanListen(["serve({ port: 0 });"])).toEqual([
			["serve", "unresolvable"],
		]);
		// A renamed destructured member is the same start: the file bound it from
		// the global, so the scan cannot read what the name calls.
		expect(
			scanListen([
				"const { serve: startServer } = Bun;",
				"startServer({ port: 0 });",
			]),
		).toEqual([["startServer", "unresolvable"]]);
		// Not starts: a computed `Function.prototype.bind`, and a file's own
		// function named `serve`.
		expect(scanListen(["const fn = () => {};", 'fn["bind"](null);'])).toEqual(
			[],
		);
		expect(
			scanListen(["async function serve() { return 1; }", "await serve();"]),
		).toEqual([]);
	});

	it("reports only a START member destructured from a runtime global (P2, shape 69)", () => {
		// A destructured helper (`sleep`, `write`) is an ordinary call: it binds no
		// port, so it has no row of its own.
		expect(
			scanListen([
				"const { serve, sleep } = Bun;",
				"await sleep(10);",
				"await serve({ port: 0 });",
			]),
		).toEqual([["serve", "unresolvable"]]);
		expect(
			scanListen([
				"const { serve, write } = Bun;",
				'await write("a", "b");',
				"await serve({ port: 0 });",
			]),
		).toEqual([["serve", "unresolvable"]]);
		// A renamed non-start member is not a start either: the KEY decides.
		expect(
			scanListen([
				"const { serve, write: save } = Bun;",
				'await save("a", "b");',
				"await serve({ port: 0 });",
			]),
		).toEqual([["serve", "unresolvable"]]);
		// A renamed START member is still the start (the filter keeps it), and an
		// alias of the global is still a runtime receiver.
		expect(
			scanListen([
				"const { serve: startServer, sleep } = Bun;",
				"await sleep(1);",
				"await startServer({ port: 0 });",
			]),
		).toEqual([["startServer", "unresolvable"]]);
	});

	it("reads a start verb reached through .apply or .call (shape 69)", () => {
		// The verb is a member VALUE here, not a member call: the same handle the
		// dot spelling names, so the same teardown rules apply. No residual.
		expect(
			scanListen([
				'const socket = dgram.createSocket("udp4");',
				"socket.bind.apply(socket, [0]);",
				"afterEach(async () => {",
				"\tawait new Promise((resolve) => socket.close(() => resolve()));",
				"});",
			]),
		).toEqual([]);
		expect(
			scanListen([
				'const socket = dgram.createSocket("udp4");',
				"socket.bind.call(socket, 0);",
			]),
		).toEqual([["socket", "unclosed"]]);
		// A handle-bound verb held in a local before it is invoked.
		expect(
			scanListen([
				'const socket = dgram.createSocket("udp4");',
				'const bind = socket["bind"];',
				"bind.apply(socket, [0]);",
			]),
		).toEqual([["socket", "unclosed"]]);
		// An indirect invocation the walk cannot place, on a handle it can read,
		// reports instead of passing.
		expect(
			scanListen([
				'const socket = dgram.createSocket("udp4");',
				"function go(fn: () => void) { fn.apply(socket, [0]); }",
				"void go;",
			]),
		).toEqual([["socket", "unresolvable"]]);
	});

	it("binds the SUPPLIED receiver of .call or .apply (R2, shape 69)", () => {
		// `a.bind.call(b, 0)` invokes `a`'s verb with `b` as its receiver, so the
		// start is on `b`. The method's object is not the bound handle, and a
		// close of it is no evidence for this start.
		const pair = [
			'const a = dgram.createSocket("udp4");',
			'const b = dgram.createSocket("udp4");',
		];
		const closeOf = (handle: string) => [
			"afterEach(async () => {",
			`\tawait new Promise((resolve) => ${handle}.close(() => resolve()));`,
			"});",
		];
		for (const [label, start] of [
			["call", "a.bind.call(b, 0);"],
			["apply", "a.bind.apply(b, [0]);"],
			["Reflect.apply", "Reflect.apply(a.bind, b, [0]);"],
		] as Array<[string, string]>) {
			// The unbound `a` is closed: the real leak on `b` is still reported.
			expect(scanListen([...pair, start, ...closeOf("a")]), label).toEqual([
				["b", "unclosed"],
			]);
			// The supplied receiver is the one closed: clean.
			expect(scanListen([...pair, start, ...closeOf("b")]), label).toEqual([]);
		}
		// A supplied receiver the scan cannot read as a handle reports instead of
		// falling back to the method's object.
		expect(
			scanListen([
				'const socket = dgram.createSocket("udp4");',
				"socket.bind.call(makeHandle(), 0);",
			]),
		).toEqual([["makeHandle()", "unresolvable"]]);
	});

	it("admits a bind-through-call on a value the scan reads as no handle (F2, shape 69)", () => {
		// `Function.prototype.bind.call(fn, null)` is `fn.bind(null)`: the verb
		// came from a function value's own `bind`, and the receiver the call
		// SUPPLIES is a plain function, so no port is bound and no listener
		// starts. Applying `bind` to anything the scan can read as no handle
		// would turn every `.call`/`.apply` on a function value into a start
		// (Greptile, gate:769).
		const noListener: Array<[string, string[]]> = [
			[
				"Function.prototype.bind on a plain function",
				["const fn = () => {};", "Function.prototype.bind.call(fn, null);"],
			],
			[
				"a handle's own verb with a plain function as the receiver",
				[
					'const socket = dgram.createSocket("udp4");',
					"const fn = () => {};",
					"socket.bind.call(fn, 0);",
				],
			],
			[
				"a literal receiver binds the caller's own `this` or nothing",
				[
					'const socket = dgram.createSocket("udp4");',
					"socket.bind.call(null, 0);",
					"Reflect.apply(socket.bind, undefined, [0]);",
				],
			],
			[
				"a function value written inline",
				[
					'const socket = dgram.createSocket("udp4");',
					"socket.bind.call(() => {}, 0);",
					"Reflect.apply(socket.bind, class {}, [0]);",
				],
			],
			[
				"a preload hook bound the same way",
				[
					"const hook = async () => {};",
					"Promise.resolve().then(Function.prototype.bind.call(hook, null, 1));",
				],
			],
		];
		for (const [label, lines] of noListener)
			expect(scanListen(lines), label).toEqual([]);
		// The other directions still report: a receiver the scan cannot place at
		// all, and an invocation that supplies no receiver (the caller's own
		// `this` names no handle). A name with one plain and one unreadable
		// binding is not proven plain either: `fn` may hold whatever
		// `makeHandle()` returned by the time the call runs.
		expect(
			scanListen([
				'const socket = dgram.createSocket("udp4");',
				"let fn: unknown = () => {};",
				"fn = makeHandle();",
				"socket.bind.call(fn, 0);",
			]),
		).toEqual([["fn", "unresolvable"]]);
		expect(
			scanListen([
				'const socket = dgram.createSocket("udp4");',
				"const b = makeHandle();",
				"socket.bind.call(b, 0);",
			]),
		).toEqual([["b", "unresolvable"]]);
		expect(
			scanListen([
				'const socket = dgram.createSocket("udp4");',
				"socket.bind.call(makeHandle(), 0);",
			]),
		).toEqual([["makeHandle()", "unresolvable"]]);
		expect(
			scanListen(['const a = dgram.createSocket("udp4");', "a.bind.call();"]),
		).toEqual([["a.bind.call()", "unresolvable"]]);
	});

	it("reports a non-identifier receiver and an unclassified construction (fail closed)", () => {
		expect(
			scanListen([
				"await new Promise((resolve) => net.createServer(() => {}).listen(0, resolve));",
			]).map(([server]) => server),
		).toEqual(["net.createServer(()=>{})"]);
		// `new WebSocketServer({ port })` binds without a `.listen` call: the
		// construction screen reports it instead of counting the file clean.
		expect(
			scanListen([
				"import { WebSocketServer } from 'ws';",
				"const wss = new WebSocketServer({ port: 0 });",
				"it('a', () => { expect(wss.address()).toBeDefined(); });",
			]),
		).toEqual([["WebSocketServer", "unresolvable"]]);
	});

	it("a close named only in a comment or a string does not count", () => {
		for (const launder of [
			"\t// await new Promise((r) => server.close(() => r()));",
			'\tconst note = "server.close(() => resolve())";',
		]) {
			expect(
				scanListen([
					"const server = net.createServer(() => {});",
					"await new Promise((resolve) => server.listen(endpoint, resolve));",
					"afterEach(async () => {",
					launder,
					"});",
				]).map(([receiver, verdict]) => [receiver, verdict]),
			).toEqual([["server", "unclosed"]]);
		}
	});

	/** Run the detector over a listener-only fixture, with the file header. */
	function scanListen(lines: string[]): Array<[string, string]> {
		return detect(lines.join("\n")).map((finding) => [
			finding.server,
			finding.verdict,
		]);
	}

	it("a computed receiver name is escaped, so a regenerated row passes the guard", () => {
		const findings = detect(
			[
				"const server = net.createServer(() => {});",
				"await new Promise((resolve) => server['listen']?.(0, resolve));",
			].join("\n"),
		);
		// A computed `listen` on a readable receiver is that receiver's start
		// (N3, shape 34), so the row names the server, not the construction.
		expect(findings.map((finding) => serverTeardownKey(finding))).toEqual([
			"tests/config/case.test.ts:server",
		]);
		expect(escapeRowKey("a b%c")).toBe("a%20b%25c");
		for (const finding of findings)
			expect(ROW_RE.test(serverTeardownKey(finding))).toBe(true);
	});

	it("reds when a baseline row vanishes from the tree", () => {
		const live = detect(
			[
				"const server = net.createServer(() => {});",
				"await new Promise((resolve) => server.listen(0, resolve));",
			].join("\n"),
		);
		expect(
			staleBaselineRows(live, new Set(["tests/config/case.test.ts:server"])),
		).toEqual([]);
		expect(
			staleBaselineRows(
				live,
				new Set([
					"tests/config/case.test.ts:server",
					"tests/config/gone.test.ts:server",
				]),
			),
		).toEqual(["tests/config/gone.test.ts:server"]);
	});
});

describe("#4589 server-teardown ratchet", () => {
	beforeAll(() => sweepOnce(), 120_000);

	it(
		"reports every unproven start and reds on a new one",
		() => {
			const findings = sweepOnce();
			const problems = unadmittedOffenders(findings, BASELINE);
			process.stderr.write(
				`server-teardown-sweep: ${findings.length} live start(s), ${BASELINE.size} baselined, ${problems.length} new\n`,
			);
			expect(problems, problems.join("\n")).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"baseline entries remain live",
		() => {
			// The shrink-only direction: closing a server anywhere makes its row
			// stale, and a stale row reds until it is deleted.
			expect(staleBaselineRows(sweepOnce(), BASELINE)).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"finds the tree's start population (the sweep is not dead)",
		() => {
			// A floor on the START population, not on the findings: the tree has
			// ~20 `.listen` calls, and a walk that stops reaching them must red
			// rather than report a clean ratchet (shape 10).
			const files = listSourceFiles(TESTS_ROOT, { extensions: [".ts"] });
			const listeners = files.filter((file) => {
				const source = readWalkedFile(file);
				return source !== undefined && /\.listen\s*\(/.test(source);
			});
			assertNonEmptyScan("test files starting a listener", listeners.length, 6);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"counts the bind spellings under tests/** that the start rule leaves alone (E5)",
		() => {
			// The `bind` rule is `bind` on a handle the scan can read; every other
			// `bind` is `Function.prototype.bind`. This counts every `bind` SPELLING
			// over stripped source, so it is an upper bound on that population: a real
			// `socket.bind(0)` start is counted here too. The floor guards against a
			// dead scan, not against a moved count (#4589 review r3 E5).
			const files = listSourceFiles(TESTS_ROOT, { extensions: [".ts"] });
			let sites = 0;
			for (const { source } of readWalkedFiles(files)) {
				const code = stripSource(source);
				sites += [
					...code.matchAll(/\.\s*bind\s*\(|\[\s*["'`]bind["'`]\s*\]\s*\(/g),
				].length;
			}
			process.stderr.write(
				`server-teardown-sweep: ${sites} bind spelling(s) in tests/**\n`,
			);
			assertNonEmptyScan("bind spellings under tests/**", sites, 30);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it.skipIf(!process.env.TEST_SERVER_TEARDOWN_REGEN)(
		"regenerates the baseline",
		() => {
			const rows = [...new Set(sweepOnce().map(serverTeardownKey))].sort();
			fs.writeFileSync(
				BASELINE_PATH,
				[
					"/**",
					` * ${BASELINE_HEADER}`,
					" *",
					" * A row is `<file>:<receiver>`, keyed on the file and the started",
					' * binding, never on a line. It means "this start is not PROVABLY',
					' * closed and awaited here", so a row in a file that does close its',
					" * server is honest: it shrinks when the file is made readable. Why each",
					" * row is admitted, and the close evidence the detector found instead,",
					" * lives in `test-server-teardown-admissions.ts`; every row here must",
					" * have an entry there.",
					" */",
					"",
					"export const TEST_SERVER_TEARDOWN_BASELINE: readonly string[] = [",
					...rows.map((row) => `\t${JSON.stringify(row)},`),
					"];",
					"",
				].join("\n"),
			);
		},
		TREE_WALK_TIMEOUT_MS,
	);
});

describe("#4589 server-teardown admission guard", () => {
	it("keeps the baseline a list of file:receiver rows", () => {
		const malformed = TEST_SERVER_TEARDOWN_BASELINE.filter(
			(row) => !ROW_RE.test(row),
		);
		expect(malformed).toEqual([]);
		expect(new Set(TEST_SERVER_TEARDOWN_BASELINE).size).toBe(
			TEST_SERVER_TEARDOWN_BASELINE.length,
		);
		expect(
			fs.readFileSync(BASELINE_PATH, "utf8").includes(BASELINE_HEADER),
		).toBe(true);
	});

	it("admits every row with a reason, and no reason without a row", () => {
		// Shape 38: a new leak cannot be admitted by appending one baseline
		// line. Both directions, so a deleted row takes its reason with it.
		const rows = new Set(TEST_SERVER_TEARDOWN_BASELINE);
		const admitted = new Set(Object.keys(TEST_SERVER_TEARDOWN_ADMISSIONS));
		expect([...rows].filter((row) => !admitted.has(row)).sort()).toEqual([]);
		expect([...admitted].filter((row) => !rows.has(row)).sort()).toEqual([]);
		for (const [row, admission] of Object.entries(
			TEST_SERVER_TEARDOWN_ADMISSIONS,
		))
			expect(
				admission.reason.length,
				`${row} needs a real reason`,
			).toBeGreaterThan(80);
	});

	it(
		"re-checks every admission's mechanism against the file it names",
		() => {
			// The reason's mechanism is a claim about the file's source, re-derived
			// here by the detector's own classifier: a row admitted as `teardown`
			// must have a close in a teardown hook, not merely a `finally` or a
			// returned closure somewhere in the file.
			//
			// #5508: several rows name the same file, so the guard classifies each
			// DISTINCT file once and checks every row of that file against that one
			// classification. The cost then follows the admitted-file population and
			// not the row population, and an extra row in an admitted file costs a
			// key filter rather than a second parse of a 1,600-line file. `checked`
			// pins that grouping kept every row: a fold that handed one row per file
			// the guard would run green on a subset of the admissions.
			const problems: string[] = [];
			const rowsByFile = new Map<string, string[]>();
			for (const row of Object.keys(TEST_SERVER_TEARDOWN_ADMISSIONS)) {
				const file = row.slice(0, row.indexOf(":"));
				rowsByFile.set(file, [...(rowsByFile.get(file) ?? []), row]);
			}
			let checked = 0;
			for (const [file, rows] of rowsByFile) {
				const source = readWalkedFile(path.join(REPO_ROOT, file));
				if (source === undefined) {
					for (const row of rows) {
						problems.push(`${row}: admission names a file the walk skips`);
						checked++;
					}
					continue;
				}
				const classification = findUnclosedServerStarts(file, source);
				for (const row of rows) {
					checked++;
					const findings = classification.filter(
						(finding) => serverTeardownKey(finding) === row,
					);
					if (findings.length === 0) {
						problems.push(
							`${row}: admitted, but the detector reports no finding`,
						);
						continue;
					}
					const mechanisms = serverTeardownMechanisms(
						classification,
						findings.map((finding) => finding.server),
					);
					const admitted = TEST_SERVER_TEARDOWN_ADMISSIONS[row].mechanism;
					if (!mechanisms.includes(admitted))
						problems.push(
							`${row}: admitted as ${admitted}, but the file shows [${mechanisms.join(", ")}]`,
						);
				}
			}
			expect(checked, "every admission row must be re-checked").toBe(
				Object.keys(TEST_SERVER_TEARDOWN_ADMISSIONS).length,
			);
			expect(problems, problems.join("\n")).toEqual([]);
		},
		ADMISSION_RECHECK_TIMEOUT_MS,
	);

	it("takes one server's mechanisms, not the file's union", () => {
		// The per-server filter the guard re-check relies on. A file with two
		// admitted bindings must not let one binding's teardown evidence carry
		// the other's row, so the mechanism set is asked per started binding.
		const source = [
			"const serverA = net.createServer(() => {});",
			"await new Promise((resolve) => serverA.listen(endpoint, resolve));",
			"const serverB = net.createServer(() => {});",
			"await new Promise((resolve) => serverB.listen(endpoint, resolve));",
			"afterEach(() => {",
			"\tserverA.close();",
			"});",
		].join("\n");
		const classification = findUnclosedServerStarts(
			"tests/config/probe.test.ts",
			source,
		);
		expect(classification.map((finding) => finding.server)).toEqual([
			"serverA",
			"serverB",
		]);
		expect(serverTeardownMechanisms(classification, ["serverA"])).toEqual([
			"teardown",
		]);
		expect(serverTeardownMechanisms(classification, ["serverB"])).toEqual([
			"none",
		]);
		expect(
			serverTeardownMechanisms(classification, ["serverA", "serverB"]),
		).toEqual(["none", "teardown"]);
		expect(serverTeardownMechanisms(classification, ["nothing"])).toEqual([]);
	});

	it("crosses the boundary: a teardown hook elsewhere cannot launder a returned close", () => {
		// The guard's own seam, driven through the production classifier: the
		// file HAS an awaiting teardown for another server, and the true
		// evidence for this one is a returned closure. Presence alone would
		// accept `teardown`, which is the wrong record this check exists to red.
		const source = [
			"const server = net.createServer(() => {});",
			"await new Promise((resolve) => server.listen(endpoint, resolve));",
			"afterEach(async () => {",
			"\tawait new Promise((resolve) => other.close(() => resolve()));",
			"});",
			"const handle = {",
			"\tclose: () => new Promise((done) => { server.close(() => done()); }),",
			"};",
		].join("\n");
		const findings = findUnclosedServerStarts(
			"tests/config/probe.test.ts",
			source,
		);
		expect(findings.map((finding) => finding.verdict)).toEqual(["helper"]);
		expect(serverTeardownMechanisms(findings, ["server"])).toEqual(["helper"]);
	});
});
