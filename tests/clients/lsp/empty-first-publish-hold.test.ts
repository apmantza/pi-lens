/**
 * #3310 — the publish handler's one-shot hold on an asynchronously-indexing
 * server's EMPTY first publish.
 *
 * The recurrence these cases prevent: pi-lens's `publishDiagnostics` handler
 * cached, stamped and emitted on EVERY publish, so intelephense's empty
 * pre-index publish resolved the push wait and `lsp_diagnostics` reported a php
 * file carrying an undefined-variable error as "confirmed clean" — a false
 * clean, the failure the wait policy exists to prevent ("a timeout is *not* a
 * false clean", docs/lsp-capability-matrix.md).
 *
 * The end-to-end proof through the real tool handler and a real wire lives in
 * `tests/tools/lsp-diagnostics-empty-first-publish-3310.test.ts`. This file
 * drives the production notification handler (`setupIncomingHandlers`) directly
 * because the release, arrival-order and one-shot cells need publish ORDERING
 * the wire cannot schedule deterministically, and the connection is the one
 * genuine process boundary in the picture.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted`: the factory below is hoisted above the static imports, and
// `clients/degradation-ledger.js` imports the real logger during that window.
const { logLatency } = vi.hoisted(() => ({ logLatency: vi.fn() }));
vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));

import {
	setupIncomingHandlers,
	type LSPClientState,
	type LSPDiagnostic,
} from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { SERVER_DIAGNOSTIC_STRATEGIES } from "../../../clients/lsp/wait-policy/strategies.js";
import { createMockState } from "./mock-client-state.js";

const FILE = "/project/app.php";
const KEY = normalizeMapKey(FILE);
const PHP_DEBOUNCE_MS = 150;
// Keep one explicit row per marker server: a new marker must add its consumer
// cases here, and removing a marker leaves the stale row red. This prevents a
// parameterized suite from silently shrinking when the strategy table drifts.
const EMPTY_FIRST_PUBLISH_CONSUMER_SERVERS = [
	"php",
	"terraform",
	"typescript",
] as const;

const FINDING: LSPDiagnostic = {
	severity: 1,
	message: "Undefined variable '$undeclared'.",
	range: { start: { line: 5, character: 22 }, end: { line: 5, character: 27 } },
};

type Publish = (params: {
	uri: string;
	diagnostics?: LSPDiagnostic[];
	version?: number;
}) => void;

function armHandler(serverId: string): {
	state: LSPClientState;
	publish: Publish;
	emitted: string[];
} {
	const state = createMockState({
		serverId,
		diagnosticEmitter: new EventEmitter(),
	});
	const emitted: string[] = [];
	state.diagnosticEmitter.on("diagnostics", (path: string) =>
		emitted.push(path),
	);
	setupIncomingHandlers(state, {});
	const calls = vi.mocked(state.connection.onNotification).mock
		.calls as unknown as Array<[string, Publish]>;
	const handler = calls.find(
		(call) => call[0] === "textDocument/publishDiagnostics",
	)?.[1];
	expect(handler).toBeDefined();
	return { state, publish: handler as Publish, emitted };
}

const uri = `file://${FILE}`;

describe("#3310 empty-first-publish hold (php/intelephense class)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		logLatency.mockClear();
	});
	it("has one consumer row for every empty-first-publish marker", () => {
		const markedServers = Object.entries(SERVER_DIAGNOSTIC_STRATEGIES)
			.filter(([, strategy]) => strategy.emptyFirstPublish === "indexing")
			.map(([serverId]) => serverId)
			.sort();
		expect([...EMPTY_FIRST_PUBLISH_CONSUMER_SERVERS].sort()).toEqual(
			markedServers,
		);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("holds the empty first publish: nothing cached, no stamp, no emit", () => {
		const { state, publish, emitted } = armHandler("php");

		publish({ uri, diagnostics: [] });
		vi.advanceTimersByTime(PHP_DEBOUNCE_MS * 4);

		expect(state.pushDiagnostics.has(KEY)).toBe(false);
		expect(state.diagnosticsVersion).toBe(0);
		expect(state.diagnosticsVersionsByPath.get(KEY)).toBeUndefined();
		expect(emitted).toEqual([]);
	});

	it("records the hold exactly once per client session", () => {
		const { publish } = armHandler("php");

		publish({ uri, diagnostics: [] });
		publish({ uri: `file:///project/other.php`, diagnostics: [] });
		vi.advanceTimersByTime(PHP_DEBOUNCE_MS * 4);

		const held = logLatency.mock.calls
			.map(([row]) => row as { phase?: string; metadata?: unknown })
			.filter((row) => row.phase === "lsp_empty_first_publish_held");
		expect(held).toHaveLength(1);
		expect(held[0]?.metadata).toMatchObject({
			serverId: "php",
			emptyFirstPublish: "indexing",
			pubVersion: "push-unversioned",
		});
	});

	it.each(EMPTY_FIRST_PUBLISH_CONSUMER_SERVERS)(
		"%s releases the hold on the server's next publish — the real set after indexing",
		(serverId) => {
			const { state, publish, emitted } = armHandler(serverId);

			publish({ uri, diagnostics: [] });
			vi.advanceTimersByTime(PHP_DEBOUNCE_MS * 2);
			publish({ uri, diagnostics: [FINDING] });
			vi.advanceTimersByTime(PHP_DEBOUNCE_MS * 2);

			expect(state.pushDiagnostics.get(KEY)).toHaveLength(1);
			expect(state.diagnosticsVersionsByPath.get(KEY)).toBeGreaterThan(0);
			expect(emitted).toEqual([KEY]);
		},
	);

	it.each(EMPTY_FIRST_PUBLISH_CONSUMER_SERVERS)(
		"%s releases the hold on a SECOND empty publish, so a genuinely clean file still confirms",
		(serverId) => {
			// Measured: intelephense re-publishes `[]` right after `indexingEnded` for
			// a clean file, which is what makes the hold releasable by the server
			// itself rather than by a timer.
			const { state, publish, emitted } = armHandler(serverId);

			publish({ uri, diagnostics: [] });
			vi.advanceTimersByTime(PHP_DEBOUNCE_MS * 2);
			publish({ uri, diagnostics: [] });
			vi.advanceTimersByTime(PHP_DEBOUNCE_MS * 2);

			expect(state.pushDiagnostics.get(KEY)).toEqual([]);
			expect(emitted).toEqual([KEY]);
		},
	);

	it("holds at most ONE publish per client session", () => {
		const { state, publish } = armHandler("php");
		const otherFile = "/project/second.php";
		const otherKey = normalizeMapKey(otherFile);

		publish({ uri, diagnostics: [] });
		vi.advanceTimersByTime(PHP_DEBOUNCE_MS * 2);
		// A different document's empty first publish is NOT held: the cold index
		// builds once per session, so the second document's answer is an answer.
		publish({ uri: `file://${otherFile}`, diagnostics: [] });
		vi.advanceTimersByTime(PHP_DEBOUNCE_MS * 2);

		expect(state.pushDiagnostics.has(KEY)).toBe(false);
		expect(state.pushDiagnostics.get(otherKey)).toEqual([]);
	});

	it("honours an empty publish that clears an earlier finding, after the debounce settled", () => {
		const { state, publish, emitted } = armHandler("php");

		publish({ uri, diagnostics: [FINDING] });
		vi.advanceTimersByTime(PHP_DEBOUNCE_MS * 2);
		expect(state.pushDiagnostics.get(KEY)).toHaveLength(1);

		publish({ uri, diagnostics: [] });
		vi.advanceTimersByTime(PHP_DEBOUNCE_MS * 2);

		expect(state.pushDiagnostics.get(KEY)).toEqual([]);
		expect(emitted).toEqual([KEY, KEY]);
	});

	it("honours an empty publish that clears an earlier finding still inside the debounce window", () => {
		// Nothing is cached yet when the clearing publish lands, so the pending
		// debounce timer is the only evidence that this is not a first publish.
		const { state, publish } = armHandler("php");

		publish({ uri, diagnostics: [FINDING] });
		publish({ uri, diagnostics: [] });
		vi.advanceTimersByTime(PHP_DEBOUNCE_MS * 2);

		expect(state.pushDiagnostics.get(KEY)).toEqual([]);
	});

	it("releases the hold on a repeated version stamp", () => {
		const { state, publish } = armHandler("php");
		state.documentVersions.set(KEY, 1);

		publish({ uri, diagnostics: [], version: 1 });
		vi.advanceTimersByTime(PHP_DEBOUNCE_MS * 2);
		expect(state.pushDiagnostics.has(KEY)).toBe(false);

		publish({ uri, diagnostics: [FINDING], version: 1 });
		vi.advanceTimersByTime(PHP_DEBOUNCE_MS * 2);

		expect(state.pushDiagnostics.get(KEY)).toHaveLength(1);
		expect(state.diagnosticDocVersions.get(KEY)).toBe(1);
	});

	it("leaves a server OUTSIDE the measured class resolving on its empty publish", () => {
		// The Tier 2/2* case (#3310 AC2): a server that publishes `[]` once for a
		// genuinely clean file must keep its affirmative clean, with no added
		// latency. `yaml` carries no strategy entry, so this is the default path
		// every unmeasured push server takes.
		const { state, publish, emitted } = armHandler("yaml");

		publish({ uri: `file:///project/app.yaml`, diagnostics: [] });
		vi.advanceTimersByTime(200);

		const yamlKey = normalizeMapKey("/project/app.yaml");
		expect(state.pushDiagnostics.get(yamlKey)).toEqual([]);
		expect(emitted).toEqual([yamlKey]);
		expect(
			logLatency.mock.calls.filter(
				([row]) =>
					(row as { phase?: string }).phase === "lsp_empty_first_publish_held",
			),
		).toEqual([]);
	});

	it.each(EMPTY_FIRST_PUBLISH_CONSUMER_SERVERS)(
		"%s leaves an empty-only first publish unanswered at the caller ceiling",
		(serverId) => {
			// F5: no publish at all is still no answer — the hold cannot manufacture
			// one. An empty-only publish is likewise deliberately indeterminate: the
			// #3310 trade-off is an unanswered caller rather than a false clean.
			const { state, publish, emitted } = armHandler(serverId);
			publish({ uri, diagnostics: [] });

			vi.advanceTimersByTime(
				SERVER_DIAGNOSTIC_STRATEGIES[serverId]?.aggregateWaitMs ?? 1500,
			);

			expect(state.pushDiagnostics.size).toBe(0);
			expect(state.emptyFirstPublishHoldSpent).toBe(true);
			expect(emitted).toEqual([]);
			expect(
				logLatency.mock.calls.filter(
					([row]) =>
						(row as { phase?: string }).phase ===
						"lsp_empty_first_publish_held",
				),
			).toHaveLength(1);
		},
	);
});
