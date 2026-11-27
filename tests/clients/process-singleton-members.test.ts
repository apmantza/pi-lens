/**
 * Shape 25 (module-scope uniqueness): process-wide state is kept through
 * `getProcessSingleton` (`clients/process-singletons.ts`), not through a
 * hand-rolled `Symbol.for` slot beside it.
 *
 * The recurrence this holds: a hand-rolled slot adopts whatever value sits
 * under its key. #2146's own header names the meeting that breaks that: a
 * stale `dist/` graph and a fresh source graph (or a reload after an upgrade)
 * share one process, so a slot another build shaped differently is read as
 * this build's. Measured on `8ec49ccf5` (the pre-fold tree, with
 * the slots seeded the same way): `noteSpawnTimeout` threw `Cannot read
 * properties of undefined (reading 'set')`, `getOpaqueBaselineStore().has`
 * threw `is not a function`, and `safeSpawnAsync` threw `reading 'add'`. The
 * seam instead discards the cell and records ONE `process-singleton-reset`
 * row. No released build ever shaped these slots differently (`git log -S` on
 * each interface), so this is the seam's contract held at each member, not a
 * defect that shipped.
 *
 * Each member gets two cells through its production caller:
 *  - another module evaluation sees what the first recorded (the #2146 case);
 *  - a cell of an older family version is discarded and the caller still
 *    answers, with the reset recorded once.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOpaqueBaselineStore } from "../../clients/opaque-mutation-scan.js";
import { getDegradationSummary } from "../../clients/degradation-ledger.js";
import {
	_resetProcessSingletonsForTests,
	_seedProcessSingletonCellForTests,
	getProcessSingletonResets,
} from "../../clients/process-singletons.js";
import {
	_resetProbeHomeRedirectStateForTests,
	getGlobalPiLensLogDir,
	getProbeHomeResolution,
} from "../../clients/probe-home-state.js";
import {
	isInSpawnTimeoutCooldown,
	noteSpawnTimeout,
	resetSpawnTimeoutCooldowns,
} from "../../clients/spawn-timeout-cooldown.js";

/** What an older build's cell looks like to this build: the right schema, an older version. */
function seedOlderCell(family: string): void {
	_seedProcessSingletonCellForTests(family, {
		schema: "pi-lens.process-singletons",
		version: 0,
		value: { shapedByAnOlderBuild: true },
	});
}

function resetFamilies(family: string): string[] {
	return getProcessSingletonResets()
		.filter((entry) => entry.family === family)
		.map((entry) => entry.family);
}

beforeEach(() => {
	_resetProcessSingletonsForTests();
});

afterEach(() => {
	vi.resetModules();
	_resetProcessSingletonsForTests();
});

describe("spawn-timeout-cooldown keeps its map in a process singleton", () => {
	it("a second module evaluation sees the cooldown the first recorded", async () => {
		noteSpawnTimeout({
			tool: "mdl",
			command: "/bin/markdownlint-cli2",
			phase: "run",
		});
		vi.resetModules();
		const second = await import("../../clients/spawn-timeout-cooldown.js");
		expect(second.isInSpawnTimeoutCooldown("markdownlint-cli2")).toBe(true);
		resetSpawnTimeoutCooldowns();
	});

	it("discards a cell of an older version and records the reset once", () => {
		seedOlderCell("spawn-timeout-cooldown");
		noteSpawnTimeout({
			tool: "mdl",
			command: "/bin/markdownlint-cli2",
			phase: "run",
		});
		expect(isInSpawnTimeoutCooldown("markdownlint-cli2")).toBe(true);
		isInSpawnTimeoutCooldown("markdownlint-cli2");
		expect(resetFamilies("spawn-timeout-cooldown")).toEqual([
			"spawn-timeout-cooldown",
		]);
		// The record a reader sees: one `process-singleton-reset` group, naming the family.
		const row = getDegradationSummary().find(
			(entry) => entry.kind === "process-singleton-reset",
		);
		expect(row?.latestReasons.map((reason) => reason.subject)).toEqual([
			"spawn-timeout-cooldown",
		]);
	});
});

describe("the opaque baseline store lives in a process singleton", () => {
	const baseline = { startedAt: 1, projectSeq: 0, strategy: "git" } as const;

	it("a second module evaluation takes the baseline the first recorded", async () => {
		getOpaqueBaselineStore().record("/p:1", "call-1", baseline);
		vi.resetModules();
		const second = await import("../../clients/opaque-mutation-scan.js");
		expect(second.getOpaqueBaselineStore().has("/p:1", "call-1")).toBe(true);
	});

	it("discards a cell of an older version and records the reset once", () => {
		seedOlderCell("opaque-baseline-store");
		const store = getOpaqueBaselineStore();
		store.record("/p:1", "call-1", baseline);
		expect(getOpaqueBaselineStore().has("/p:1", "call-1")).toBe(true);
		expect(resetFamilies("opaque-baseline-store")).toEqual([
			"opaque-baseline-store",
		]);
	});
});

describe("the probe-home decision lives in a process singleton", () => {
	const savedHome = process.env.PI_LENS_HOME;
	const savedProbe = process.env.PILENS_PROBE;
	const savedCwd = process.cwd();
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-singleton-probe-"));
		delete process.env.PI_LENS_HOME;
		process.env.PILENS_PROBE = "1";
		process.chdir(root);
	});

	afterEach(() => {
		process.chdir(savedCwd);
		if (savedHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = savedHome;
		if (savedProbe === undefined) delete process.env.PILENS_PROBE;
		else process.env.PILENS_PROBE = savedProbe;
		_resetProbeHomeRedirectStateForTests();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("a second module evaluation reads the decision the first made", async () => {
		const first = getGlobalPiLensLogDir();
		vi.resetModules();
		const second = await import("../../clients/probe-home-state.js");
		expect(second.getProbeHomeResolution()?.probeHome).toBe(first);
	});

	it("discards a cell of an older version and resolves again", () => {
		seedOlderCell("probe-home-resolution");
		const dir = getGlobalPiLensLogDir();
		expect(dir).toBe(path.join(fs.realpathSync(root), ".pi-lens-probe-home"));
		expect(getProbeHomeResolution()?.probeHome).toBe(dir);
		expect(resetFamilies("probe-home-resolution")).toEqual([
			"probe-home-resolution",
		]);
	});
});
