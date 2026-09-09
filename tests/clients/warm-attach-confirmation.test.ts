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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	contentHash,
	WARM_DIAGNOSTICS_SCHEMA_VERSION,
} from "../../clients/mcp/ipc.js";
import type { WarmDiagnosticsResponse } from "../../clients/mcp/ipc.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const touchFile = vi.fn();
vi.mock("../../clients/lsp/index.js", () => ({
	// `_serveWarmRequestForTests` reads only `touchFile` on the diagnostics
	// route; the rest of the surface comes from the factory (#2592).
	getLSPService: () => makeLspServiceDouble({ touchFile }),
}));

const FILE = "C:/repo/notes.md";
const CONTENT = "# hi\n";

function request() {
	return {
		route: "diagnostics" as const,
		version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
		file: FILE,
		cwd: "C:/repo",
		content: CONTENT,
		contentHash: contentHash(CONTENT),
		// Generous: `serveRequest` rejects a request whose deadline has already
		// passed, and drops `fresh` when it serves after it.
		deadlineAt: Date.now() + 60_000,
	};
}

async function serve() {
	const { _serveWarmRequestForTests } =
		await import("../../clients/warm-attach.js");
	const served = await _serveWarmRequestForTests(request());
	expect(served.error).toBeUndefined();
	return served.result as WarmDiagnosticsResponse;
}

describe("#1253 — warm-attach serves the touch confirmation", () => {
	beforeEach(() => {
		vi.resetModules();
		touchFile.mockReset();
	});
	afterEach(() => {
		vi.restoreAllMocks();
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
});
