/**
 * #1253 — the PRODUCER half of the warm-attach confirmation carriage.
 *
 * `WarmDiagnosticsResponse.confirmation` is the incumbent's own
 * `TouchFileResult.confirmation` re-surfaced as an explicit enumerable DTO
 * field. It exists because `inconclusive: false` is NOT the same evidence: a
 * `silentOnClean` server like marksman publishes nothing on a clean file, so
 * without the field an incumbent-served empty result is indistinguishable from
 * "never answered" on the far side and every clean Markdown file in a
 * warm-attached session renders unconfirmed.
 *
 * The consumer half is pinned in `tests/tools/lsp-diagnostics.test.ts` against a
 * mocked `tryWarmAttachedDiagnostics`, which means the field's ABSENCE degrades
 * correctly — but nothing pinned the incumbent actually emitting it. These tests
 * drive `serveRequest` directly (the socket wiring around it needs a bindable
 * unix socket, which is not available in every sandbox) and cover both
 * directions of the mixed-build contract:
 *
 *  - a confirmed touch emits `confirmation: "confirmed"`;
 *  - an unconfirmed touch OMITS the key entirely rather than serializing
 *    `undefined`, which is what makes an old client's `JSON.parse` see the same
 *    shape a pre-#1253 incumbent produces (safe-by-omission, no version bump).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	contentHash,
	WARM_DIAGNOSTICS_SCHEMA_VERSION,
} from "../../clients/mcp/ipc.js";
import type {
	WarmCodeActionsResponse,
	WarmDiagnosticsResponse,
} from "../../clients/mcp/ipc.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import { ENVIRONMENT_GAP_MARKER } from "../../clients/lsp/environment-gap.js";
import { removeTempDirSync } from "./test-utils.js";
import { ambientSocketNameIsShared } from "../support/socket-identity.js";

const touchFile = vi.fn();
const projectInfo = vi.fn();
const codeAction = vi.fn();

const FILE = "C:/repo/notes.md";
const CONTENT = "# hi\n";

function request(
	file = FILE,
	deadlineAt = Date.now() + 60_000,
	cwd = "C:/repo",
) {
	return {
		route: "diagnostics" as const,
		version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
		file,
		cwd,
		content: CONTENT,
		contentHash: contentHash(CONTENT),
		// Generous by default: `serveRequest` rejects a request whose deadline has
		// already passed, and drops `fresh` when it serves after it.
		deadlineAt,
	};
}

async function serve(file = FILE, deadlineAt?: number, cwd?: string) {
	const { _serveWarmRequestForTests } =
		await import("../../clients/warm-attach.js");
	const served = await _serveWarmRequestForTests(
		request(file, deadlineAt, cwd),
	);
	expect(served.error).toBeUndefined();
	return served.result as WarmDiagnosticsResponse;
}

describe("#1253 — warm-attach serves the touch confirmation", () => {
	beforeEach(async () => {
		vi.resetModules();
		touchFile.mockReset();
		projectInfo.mockReset();
		codeAction.mockReset();
		projectInfo.mockResolvedValue({
			executed: false,
			reason: "no live client",
		});
		// The install re-evaluates the facade after `vi.resetModules()` so
		// `serve()` reuses the lifecycle containing this case's double (#2592).
		await installLspServiceDouble({
			touchFile,
			executeReadOnlyCommandOnLiveClient: projectInfo,
			codeAction,
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("carries confirmation:'confirmed' for a confirmed clean touch", async () => {
		// The marksman shape: a clean file, nothing published, but the touch's
		// silent-clean gate confirmed it.
		touchFile.mockResolvedValue({ diags: [], confirmation: "confirmed" });

		const result = await serve();

		expect(result.confirmation).toBe("confirmed");
		expect(result.diagnostics).toEqual([]);
		expect(result.inconclusive).toBe(false);
		expect(result.fresh).toBe(true);
	});

	it("OMITS the key (not undefined) when the touch was not confirmed", async () => {
		touchFile.mockResolvedValue({ diags: [] });

		const result = await serve();

		// Omission is the mixed-build contract: the wire bytes must match what a
		// pre-#1253 incumbent produces, so an old consumer sees no new key and a
		// new consumer reads `undefined` → unconfirmed. `confirmation: undefined`
		// would serialize away to the same thing, but asserting on the key makes
		// the intent enforceable rather than incidental.
		expect("confirmation" in result).toBe(false);
		expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty(
			"confirmation",
		);
	});

	it("never fabricates a confirmation for an inconclusive touch", async () => {
		// An inconclusive touch is the case the field must not launder: the
		// server's silence is unexplained, so the far side has to stay unconfirmed.
		touchFile.mockResolvedValue({ diags: [], inconclusive: true });

		const result = await serve();

		expect(result.inconclusive).toBe(true);
		expect("confirmation" in result).toBe(false);
	});

	it("carries confirmation alongside real findings too", async () => {
		const diag = {
			severity: 1,
			message: "broken link",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 4 },
			},
		};
		touchFile.mockResolvedValue({ diags: [diag], confirmation: "confirmed" });

		const result = await serve();

		expect(result.confirmation).toBe("confirmed");
		expect(result.diagnostics).toHaveLength(1);
	});

	it("carries the NARROWED confirmation and the server ids across the wire (#1470)", async () => {
		// A partial touch is not inconclusive — the primary answered — so without
		// an explicit narrowed value the far side would read `confirmation` as
		// absent and be unable to tell "old incumbent" from "opengrep was cut off".
		touchFile.mockResolvedValue({
			diags: [],
			confirmation: "partial",
			unconfirmedServerIds: ["opengrep"],
		});

		const result = await serve();
		const overTheWire = JSON.parse(
			JSON.stringify(result),
		) as WarmDiagnosticsResponse;

		expect(overTheWire.confirmation).toBe("partial");
		expect(overTheWire.unconfirmedServerIds).toEqual(["opengrep"]);
		// The load-bearing consequence: every existing consumer tests
		// `=== "confirmed"`, so the narrowing fails closed for free.
		expect(overTheWire.confirmation).not.toBe("confirmed");
	});

	it("reads the coverage gap through touchCoverageGap, not off the confirmation string (#1470)", async () => {
		// `touchCoverageGap`'s own doc comment forbids re-deriving the rule from a
		// `confirmation` string literal. The producer sets both fields together
		// today, so a re-derivation passes every other test in this file — this one
		// hands the serve path a touch that names a coverage gap WITHOUT the
		// narrowed string, which is exactly what a second producer (or a widened
		// confirmation vocabulary) would look like. One reader, one rule.
		touchFile.mockResolvedValue({
			diags: [],
			unconfirmedServerIds: ["opengrep"],
		});

		const result = await serve();

		expect(result.confirmation).toBe("partial");
		expect(result.unconfirmedServerIds).toEqual(["opengrep"]);
	});

	// #5030: the incumbent's touch composes a content binding (does the answer
	// describe the bytes on disk), and the socket used to drop it. Recurrence it
	// prevents: a stale-bound answer crossed the wire as a bare row set and every
	// attached reader took it for the current bytes, #5017 on the warm route.
	// The field is ALWAYS present on a new incumbent (`"unknown"` when its touch
	// composed none), so its absence on the far side can only mean an older
	// incumbent: that is what lets a reader fail closed on it.
	it.each([
		[false, false],
		[true, true],
		["unknown", "unknown"],
	] as const)(
		"carries the touch's content binding %s across the wire (#5030)",
		async (bound, onTheWire) => {
			touchFile.mockResolvedValue({
				diags: [],
				confirmation: "confirmed",
				binding: { contentHash: "fp-of-sent-bytes", boundToCurrentDisk: bound },
			});

			const result = JSON.parse(
				JSON.stringify(await serve()),
			) as WarmDiagnosticsResponse;

			expect(result.binding).toEqual({
				contentHash: "fp-of-sent-bytes",
				boundToCurrentDisk: onTheWire,
			});
		},
	);

	it("sends 'unknown', never an absent field, for a touch that composed no binding (#5030)", async () => {
		touchFile.mockResolvedValue({ diags: [], confirmation: "confirmed" });

		const result = JSON.parse(
			JSON.stringify(await serve()),
		) as WarmDiagnosticsResponse;

		expect(result.binding).toEqual({ boundToCurrentDisk: "unknown" });
	});

	// #4645: only the incumbent owns the client that can answer membership, so
	// it asks and sends the answer beside the server's RAW rows. The reader runs
	// the one demotion pipeline with it (pinned in
	// `tests/clients/dispatch/runners/lsp-inferred-warm-attach.test.ts` and
	// `tests/tools/lsp-diagnostics-cache.test.ts`).
	describe("inferred-project membership answer", () => {
		const file = "C:/repo/orphan.ts";
		const diagnostic = {
			severity: 1,
			message: "Type 'number' is not assignable to type 'string'.",
			source: "typescript",
			code: 2322,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 4 },
			},
		};
		const inferred = {
			executed: true,
			result: {
				success: true,
				body: { configFileName: "/dev/null/inferredProject1*" },
			},
		};

		beforeEach(() => {
			touchFile.mockResolvedValue({
				diags: [diagnostic],
				confirmation: "confirmed",
			});
		});

		it("carries the inferred-project answer beside the raw rows", async () => {
			projectInfo.mockResolvedValue(inferred);

			const result = JSON.parse(
				JSON.stringify(await serve(file)),
			) as WarmDiagnosticsResponse;

			expect(result.diagnostics).toEqual([diagnostic]);
			expect(result.projectIdentity?.projectKind).toBe("inferred");
			expect(result.confirmation).toBe("confirmed");
			expect(result.fresh).toBe(true);
			expect(projectInfo).toHaveBeenCalledExactlyOnceWith(
				file,
				"typescript.tsserverRequest",
				["projectInfo", { file, needFileNameList: false }],
			);
		});

		it("carries a configured-project answer and leaves the rows raw", async () => {
			projectInfo.mockResolvedValue({
				executed: true,
				result: {
					success: true,
					body: { configFileName: "C:/repo/tsconfig.json" },
				},
			});

			const result = await serve(file);

			expect(result.diagnostics).toEqual([diagnostic]);
			expect(result.projectIdentity?.projectKind).toBe("configured");
		});

		it("omits the answer when membership is unavailable (mixed-build safe)", async () => {
			const result = await serve(file);

			expect(result.diagnostics).toEqual([diagnostic]);
			expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty(
				"projectIdentity",
			);
		});

		it("does not probe membership for clean diagnostics", async () => {
			touchFile.mockResolvedValue({ diags: [], confirmation: "confirmed" });

			const result = await serve(file);

			expect(result.diagnostics).toEqual([]);
			expect(projectInfo).not.toHaveBeenCalled();
			expect("projectIdentity" in result).toBe(false);
		});

		// #4645 F5 recurrence: the incumbent used to send rows it had run the
		// environment rule over, and an attached batch cache then stored that
		// install-state verdict as a real warning. After `npm ci` the replay could
		// not undo it. The rule depends on install state no cache key carries, so
		// the wire keeps the server's own row and the reader runs the rule.
		it("never rewrites an ambient-gap row, even in an inferred project", async () => {
			const dir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-warm-gap-")),
			);
			try {
				const gapRow = {
					...diagnostic,
					message: "Cannot find name 'setTimeout'.",
					code: 2304,
				};
				touchFile.mockResolvedValue({
					diags: [gapRow],
					confirmation: "confirmed",
				});
				projectInfo.mockResolvedValue(inferred);

				const result = await serve(path.join(dir, "orphan.ts"), undefined, dir);

				expect(result.diagnostics).toEqual([gapRow]);
				expect(result.diagnostics[0]?.message).not.toContain(
					ENVIRONMENT_GAP_MARKER,
				);
				expect(result.projectIdentity?.projectKind).toBe("inferred");
			} finally {
				removeTempDirSync(dir);
			}
		});

		// #4645 F1/F7 recurrence: a probe allowed to run to the request's deadline
		// made the reply late by timer slack, the client read it as
		// `stale-answer` (or its own timer won), and `promoteToLocal` ended warm
		// attach for the session, with nothing recording why. The probe now stops
		// short of the deadline by the send reserve. This fake probe settles AT
		// the deadline, so a probe bounded by the deadline itself still answers.
		it("abandons a probe that settles only at the deadline, answers fresh and records it", async () => {
			await serve(file); // load the lazy service modules before the clock is faked
			const ledger = await import("../../clients/degradation-ledger.js");
			ledger.resetDegradationLedger();
			vi.useFakeTimers();
			const deadlineAt = Date.now() + 1_000;
			projectInfo.mockImplementation(
				() =>
					new Promise((resolve) =>
						setTimeout(resolve, deadlineAt - Date.now(), inferred),
					),
			);

			const { _serveWarmRequestForTests } =
				await import("../../clients/warm-attach.js");
			const pending = _serveWarmRequestForTests(request(file, deadlineAt));
			await vi.advanceTimersByTimeAsync(2_000);
			const result = (await pending).result as WarmDiagnosticsResponse;

			expect(result.fresh).toBe(true);
			expect(result.servedAt).toBeLessThan(deadlineAt);
			expect(result.diagnostics).toEqual([diagnostic]);
			expect("projectIdentity" in result).toBe(false);
			const abandoned = ledger
				.getDegradationSummary()
				.find(
					(group) => group.kind === "warm-attach-membership-probe-abandoned",
				);
			expect(abandoned?.latestReasons.map((row) => row.subject)).toEqual([
				"probe-timeout",
			]);
		});

		// #4645 F1, end to end: the fake-clock case above lands every timer on its
		// due instant, the one value where a reply AT the deadline still reads
		// fresh, so it cannot see the client's own timer racing the reply. This
		// drives the real `startServer` wiring, a real socket and the real client
		// (`requestWarmDiagnostics`, whose timer is armed for the same deadline).
		// The probe never settles until the case ends. Before the reserve, every
		// reply landed at the deadline and read `timeout` or `stale-answer`, which
		// `tryWarmAttachedDiagnostics` answers with a permanent `promoteToLocal`.
		// lane: Unit tests (CI's short TMPDIR); the client never dials a shared
		// pid-scoped name, so this case skips where the cut makes one.
		it.skipIf(ambientSocketNameIsShared(process.pid))(
			"answers a slow probe in time through the real socket and client timer",
			async () => {
				const home = fs.mkdtempSync(
					path.join(os.tmpdir(), "pi-lens-warm-e2e-"),
				);
				const cwd = path.join(home, "ws");
				fs.mkdirSync(cwd);
				vi.stubEnv("PI_LENS_HOME", home);
				vi.stubEnv("PI_LENS_WARM_ATTACH", "1");
				const pendingProbes: Array<(answer: typeof inferred) => void> = [];
				projectInfo.mockImplementation(
					() =>
						new Promise((resolve) => {
							pendingProbes.push(resolve);
						}),
				);
				const warm = await import("../../clients/warm-attach.js");
				const ipc = await import("../../clients/mcp/ipc.js");
				try {
					await warm.configureWarmAttach(cwd);
					const replies = [];
					for (let run = 0; run < 3; run++) {
						replies.push(
							await ipc.requestWarmDiagnostics(
								cwd,
								process.pid,
								path.join(cwd, "orphan.ts"),
								CONTENT,
								300,
							),
						);
					}
					for (const reply of replies) {
						expect(reply.available).toBe(true);
						if (!reply.available) continue;
						expect(reply.response.diagnostics).toEqual([diagnostic]);
						expect("projectIdentity" in reply.response).toBe(false);
					}
				} finally {
					for (const release of pendingProbes) release(inferred);
					warm._resetWarmAttachForTests();
					vi.unstubAllEnvs();
					removeTempDirSync(home);
				}
			},
		);

		it("sends no probe when the touch left no time before the send reserve", async () => {
			await serve(file); // load the lazy service modules before the clock is faked
			projectInfo.mockClear();
			const ledger = await import("../../clients/degradation-ledger.js");
			ledger.resetDegradationLedger();
			vi.useFakeTimers();
			const deadlineAt = Date.now() + 1_000;
			projectInfo.mockResolvedValue(inferred);
			touchFile.mockImplementation(
				() =>
					new Promise((resolve) =>
						setTimeout(resolve, deadlineAt - Date.now() - 10, {
							diags: [diagnostic],
							confirmation: "confirmed",
						}),
					),
			);

			const { _serveWarmRequestForTests } =
				await import("../../clients/warm-attach.js");
			const pending = _serveWarmRequestForTests(request(file, deadlineAt));
			await vi.advanceTimersByTimeAsync(2_000);
			const result = (await pending).result as WarmDiagnosticsResponse;

			expect(projectInfo).not.toHaveBeenCalled();
			expect(result.fresh).toBe(true);
			expect(result.diagnostics).toEqual([diagnostic]);
			const abandoned = ledger
				.getDegradationSummary()
				.find(
					(group) => group.kind === "warm-attach-membership-probe-abandoned",
				);
			expect(abandoned?.latestReasons.map((row) => row.subject)).toEqual([
				"no-time-left",
			]);
		});
	});

	it("survives the JSON round trip the socket actually performs", async () => {
		touchFile.mockResolvedValue({ diags: [], confirmation: "confirmed" });

		const result = await serve();
		// `startServer` writes `JSON.stringify(await serveRequest(req))` — a
		// non-enumerable side channel would vanish here (the #1179 shape-5 class).
		const overTheWire = JSON.parse(
			JSON.stringify(result),
		) as WarmDiagnosticsResponse;

		expect(overTheWire.confirmation).toBe("confirmed");
		expect(overTheWire.version).toBe(WARM_DIAGNOSTICS_SCHEMA_VERSION);
	});

	it("serves an empty action list for a range with no client to ask (#5554)", async () => {
		// #5554 r2 F6: `LSPService.codeAction` answers undefined when no client
		// can be asked. The warm reply's schema needs one array per range, so an
		// unmapped undefined would make the reader drop every range's quick fix
		// as a schema mismatch.
		touchFile.mockResolvedValue({ diags: [], confirmation: "confirmed" });
		await serve();
		const action = { title: "Fix it", kind: "quickfix" };
		codeAction.mockResolvedValueOnce(undefined).mockResolvedValueOnce([action]);
		const range = {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 1 },
		};
		const { _serveWarmRequestForTests } =
			await import("../../clients/warm-attach.js");
		const served = await _serveWarmRequestForTests({
			route: "code-actions",
			version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
			file: FILE,
			cwd: "C:/repo",
			contentHash: contentHash(CONTENT),
			ranges: [range, range],
			deadlineAt: Date.now() + 60_000,
		});
		expect(served.error).toBeUndefined();
		expect((served.result as WarmCodeActionsResponse).actions).toEqual([
			[],
			[action],
		]);
	});
});
