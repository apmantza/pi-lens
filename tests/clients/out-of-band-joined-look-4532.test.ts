/**
 * #4532 gap 6: a look that joins another look of its key gets the walk it
 * demands.
 *
 * Both looks are single-flight with one trailing pass, and the trailing pass
 * runs the FIRST caller's closure. A bash `tool_result` always walks the
 * declaration files; a `tool_call` walks at most once per
 * `PI_LENS_DECLARATION_LOOK_MS`. So a bash result that joined a `tool_call`
 * look in flight got a trailing pass under the `tool_call`'s trigger: no walk,
 * and a declaration file its command wrote into a gitignored directory reached
 * no server until some later walk (re-probe on 9fff43034, cells G6a and G6h).
 *
 * Cells, written before the fix:
 *
 * | Cell | Starter | Joiner | Pre-fix | Post-fix |
 * |---|---|---|---|---|
 * | out-of-band look | `tool_call` (throttled, held in its publish) | bash `tool_result` | the joiner's `.d.ts` is not published | published by the trailing pass, row `joinedWalk: true` |
 * | HEAD look (`resyncHeadMove`) | `tool_call` | bash `tool_result`, same look key | not published | published before the joiner settles |
 *
 * The flight is held open by a subscriber of the real disk-change publisher
 * that waits on a gate during the starter's own publish (an install it saw),
 * so the join happens by construction, never by timing. The throttle is held
 * shut so the trigger is the only difference between the two callers.
 */
import { getEventListeners } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type DiskChange,
	subscribeDiskChange,
} from "../../clients/disk-changes.js";
import {
	_setRecentPhasesForTest,
	getRecentLoggedPhases,
} from "../../clients/latency-logger.js";
import { lookForOutOfBandChanges } from "../../clients/out-of-band-changes.js";
import { resyncHeadMove } from "../../clients/runtime-tool-result.js";
import { gatedPromise } from "../support/fault-injection.js";
import { withEnv } from "../support/with-env.js";

let root: string;
const cleanups: Array<() => void> = [];

/** The out-of-band publishes this case saw. */
function recordPublishes(): DiskChange[] {
	const seen: DiskChange[] = [];
	cleanups.push(
		subscribeDiskChange(
			"t4532-g6-observes-publish",
			(change) => {
				seen.push(change);
			},
			["out-of-band"],
		),
	);
	return seen;
}

/**
 * Hold the next out-of-band publish open until `release` runs: the starter's
 * pass is then in flight, so a call of the same key joins it.
 */
function holdNextPublish(): {
	reached: Promise<void>;
	release: () => void;
} {
	const reached = gatedPromise<void>();
	const gate = gatedPromise<void>();
	let holding = true;
	cleanups.push(
		subscribeDiskChange(
			"t4532-g6-holds-publish",
			async () => {
				if (!holding) return;
				holding = false;
				reached.resolve();
				await gate.promise;
			},
			["out-of-band"],
		),
	);
	// A gate left shut would hold a flight past this case.
	cleanups.push(() => gate.resolve());
	return { reached: reached.promise, release: () => gate.resolve() };
}

/** Did any publish name `file` as created? */
function publishedCreated(seen: DiskChange[], file: string): boolean {
	return seen.some((change) =>
		(change.pathChanges ?? []).some(
			(entry) => entry.filePath === file && entry.type === "created",
		),
	);
}

beforeEach(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4532-g6-"));
	fs.mkdirSync(path.join(root, "gen"), { recursive: true });
	fs.writeFileSync(path.join(root, ".gitignore"), "gen/\n");
	// The tool_call throttle is held shut: a tool_call look never walks here, so
	// a walk can only come from the bash result's demand.
	cleanups.push(withEnv({ PI_LENS_DECLARATION_LOOK_MS: "600000" }));
	_setRecentPhasesForTest([]);
	// The root's first look records the baseline.
	await lookForOutOfBandChanges(root, "tool_result");
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("#4532 gap 6: a joined look gets the walk it demands", () => {
	it("walks for a bash result that joined a tool_call out-of-band look", async () => {
		const seen = recordPublishes();
		const hold = holdNextPublish();
		// The starter sees an install, so its pass publishes and is held there.
		fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
		const generated = path.join(root, "gen", "api.d.ts");
		const starter = lookForOutOfBandChanges(root, "tool_call");
		let joiner: Promise<void> | undefined;
		try {
			await hold.reached;
			// The bash command's codegen write, then its result's look, which
			// joins the flight in the same synchronous step as the call.
			fs.writeFileSync(generated, "export declare const api: 1;\n");
			joiner = lookForOutOfBandChanges(root, "tool_result");
		} finally {
			hold.release();
		}
		await joiner;
		expect(publishedCreated(seen, generated)).toBe(true);
		await starter;
		// A bash result's own walk, alone, is not a joined one.
		const own = path.join(root, "gen", "own.d.ts");
		fs.writeFileSync(own, "export declare const own: 1;\n");
		await lookForOutOfBandChanges(root, "tool_result");
		expect(publishedCreated(seen, own)).toBe(true);
		const rows = getRecentLoggedPhases()
			.filter((entry) => entry.phase === "lsp_out_of_band_change")
			.map((entry) => entry.metadata ?? {})
			.filter((metadata) => metadata.created === 1);
		expect(rows).toHaveLength(2);
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ trigger: "tool_call", joinedWalk: true }),
				expect.objectContaining({ trigger: "tool_result", joinedWalk: false }),
			]),
		);
	});

	it("walks for a bash result that joined a tool_call HEAD look", async () => {
		const seen = recordPublishes();
		const hold = holdNextPublish();
		const look = (trigger: "tool_call" | "tool_result") =>
			resyncHeadMove({
				root,
				key: `t4532-g6|${root}`,
				trigger,
				label: trigger === "tool_call" ? "read" : "bash",
			});
		fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
		const generated = path.join(root, "gen", "api.d.ts");
		const starter = look("tool_call");
		let joiner: Promise<void> | undefined;
		try {
			await hold.reached;
			fs.writeFileSync(generated, "export declare const api: 1;\n");
			joiner = look("tool_result");
		} finally {
			hold.release();
		}
		// The joiner's own promise settles only after its walk published.
		await joiner;
		expect(publishedCreated(seen, generated)).toBe(true);
		await starter;
	});

	// #5005 F3: the answer route abandons its wait when its caller aborts, but
	// a look is single-flight, so the abandon must not cut a walk another caller
	// joined. The flight is held open by a subscriber, so the join and the abort
	// are construction, not timing.
	it("lets an aborted caller stop waiting without cutting the shared flight", async () => {
		const seen = recordPublishes();
		const hold = holdNextPublish();
		const generated = path.join(root, "gen", "aborted.d.ts");
		fs.writeFileSync(generated, "export declare const aborted: 1;\n");
		const controller = new AbortController();
		const caller = lookForOutOfBandChanges(root, "tool_call", undefined, {
			walk: "always",
			signal: controller.signal,
		});
		try {
			await hold.reached;
			controller.abort();
			// Settles while the flight is still inside its publish. An
			// implementation that awaited the walk would hang here.
			await caller;
		} finally {
			hold.release();
		}
		// The flight was not cut: it finished its publish and advanced the root's
		// record, so the next look of this root finds nothing new.
		await lookForOutOfBandChanges(root, "tool_call", undefined, {
			walk: "always",
		});
		expect(
			seen.filter((change) =>
				(change.pathChanges ?? []).some(
					(entry) => entry.filePath === generated && entry.type === "created",
				),
			),
		).toHaveLength(1);
	});

	// Shape 4 (a watcher is released on every settle path): a look that finishes
	// without an abort must not leave its listener on the caller's signal, which
	// outlives the look by a whole turn.
	it("leaves no abort listener on the caller's signal once its look settles", async () => {
		fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
		const turn = new AbortController();

		await lookForOutOfBandChanges(root, "tool_call", undefined, {
			walk: "always",
			signal: turn.signal,
		});

		expect(getEventListeners(turn.signal, "abort")).toHaveLength(0);
	});
});
