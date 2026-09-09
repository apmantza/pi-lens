/**
 * #766: cross-operation ordering of the shared circular-dep state.
 *
 * `lastCircular`/`circularFiles` are instance state that every madge run
 * OVERWRITES wholesale, and three writers race for it: turn-end batches,
 * `checkFile`, and the background `scanProject` (runtime-session and
 * project-diagnostics/fresh-fetch both drive one). Folding in array order fixes
 * ordering WITHIN a batch, but nothing stopped an operation that started against
 * OLDER file content from finishing last and resurrecting its stale view over
 * newer state.
 *
 * Each operation now takes a generation when it classifies and publishes only
 * while that generation is still the newest. These tests deliberately reverse
 * completion order against classification order, so a checker without the guard
 * fails them.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

const safeSpawnAsync = vi.fn();
const safeSpawn = vi.fn();
const findNodeToolBinary = vi.fn();
const ensureTool = vi.fn();

vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync, safeSpawn }));
vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/package-manager.js")
	>()),
	findNodeToolBinary,
}));
vi.mock("../../clients/installer/index.js", () => ({
	// #2140: the probe resolver asks the installer for a release-managed
	// binary (`~/.pi-lens/bin`) before falling back to PATH. Undefined is
	// "no managed install", which is what these tests already assumed.
	findManagedToolBinary: vi.fn(async () => undefined),
	ensureTool,
	getManagedToolsDir: () => path.join(os.tmpdir(), "pilens-fake-home", "tools"),
	// #1276: stubbed for the same reason as the sibling madge test files — see
	// dependency-checker-madge-resolution.test.ts.
	isSpawnableCommand: vi.fn(async () => true),
}));

const VERSION_OK = {
	status: 0,
	error: null,
	stdout: "madge 8.0.0",
	stderr: "",
};

describe("DependencyChecker shared-state generation guard (#766)", () => {
	let tmp: string;

	beforeEach(() => {
		vi.resetAllMocks();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-madge-gen-"));
		findNodeToolBinary.mockResolvedValue("/fake/bin/madge");
		ensureTool.mockResolvedValue(undefined);
	});

	afterEach(() => {
		removeTempDirSync(tmp);
	});

	function writeSource(name: string, imports: string[]): string {
		const file = path.join(tmp, name);
		fs.writeFileSync(
			file,
			`${imports.map((i) => `import { x } from "${i}";`).join("\n")}\nexport const v = 1;\n`,
		);
		return file;
	}

	/** A gate the test opens by hand, so ordering never depends on wall-clock. */
	function makeGate(): { wait: Promise<void>; open: () => void } {
		let open!: () => void;
		const wait = new Promise<void>((resolve) => {
			open = resolve;
		});
		return { wait, open };
	}

	it("drops a slow older batch's publish once a newer batch has published", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const x = writeSource("x.ts", ["./b.js"]);
		const gate = makeGate();
		let spawns = 0;

		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "--version") return VERSION_OK;
			spawns++;
			if (spawns === 1) {
				// The OLD run: started first, finishes last, reports a cycle.
				await gate.wait;
				return {
					status: 0,
					error: null,
					stdout: JSON.stringify([[x, path.join(tmp, "b.ts")]]),
					stderr: "",
				};
			}
			// The NEW run, against the edited imports: no cycle.
			return { status: 0, error: null, stdout: "[]", stderr: "" };
		});

		const checker = new DependencyChecker();
		const stale = checker.checkFilesBatch([x], tmp);
		await vi.waitFor(() => expect(spawns).toBe(1));

		// x's imports change while the first batch is still spawning.
		fs.writeFileSync(
			x,
			'import { b } from "./b.js";\nimport { c } from "./c.js";\nexport const v = 1;\n',
		);
		const fresh = await checker.checkFilesBatch([x], tmp);

		gate.open();
		const staleResult = await stale;

		// Changed content re-runs madge — the guard adds no result cache (#533).
		expect(spawns).toBe(2);
		expect(fresh.results.get(x)?.hasCircular).toBe(false);
		// Each batch's own returned result still comes from its own spawn...
		expect(staleResult.results.get(x)?.hasCircular).toBe(true);
		// ...but the older classification cannot overwrite the newer publish.
		expect(checker.isInCircular(x)).toBe(false);
		expect(checker.getCircularForFile(x)).toEqual([]);
	});

	it("lets an older publish land when the newer batch learned nothing", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const x = writeSource("x.ts", ["./b.js"]);
		const unchanged = writeSource("h.ts", ["./k.js"]);
		const gate = makeGate();
		let spawns = 0;

		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "--version") return VERSION_OK;
			spawns++;
			await gate.wait;
			return {
				status: 0,
				error: null,
				stdout: JSON.stringify([[x, path.join(tmp, "b.ts")]]),
				stderr: "",
			};
		});

		const checker = new DependencyChecker();
		// Seed h.ts's import cache so the later batch is pure cache hits.
		expect(checker.importsChanged(unchanged)).toBe(true);

		const slow = checker.checkFilesBatch([x], tmp);
		await vi.waitFor(() => expect(spawns).toBe(1));

		const idle = await checker.checkFilesBatch([unchanged], tmp);
		expect(idle.stats.spawned).toBe(0);
		expect(idle.stats.cacheHits).toBe(1);

		gate.open();
		await slow;

		// The newer batch folded nothing, so it published nothing and must not
		// have advanced the generation past an older op's legitimate write.
		expect(checker.isInCircular(x)).toBe(true);
	});

	it("makes a slow project scan lose to a newer batch too", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const y = writeSource("y.ts", ["./z.js"]);
		const x = writeSource("x.ts", ["./b.js"]);
		const gate = makeGate();
		let scanStarted = false;

		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "--version") return VERSION_OK;
			if (args[args.length - 1] === tmp) {
				// The whole-project scan: classified first, finishes last.
				scanStarted = true;
				await gate.wait;
				return {
					status: 0,
					error: null,
					stdout: JSON.stringify({ [y]: [path.join(tmp, "z.ts")] }),
					stderr: "",
				};
			}
			return { status: 0, error: null, stdout: "[]", stderr: "" };
		});

		const checker = new DependencyChecker();
		const scan = checker.scanProject(tmp);
		await vi.waitFor(() => expect(scanStarted).toBe(true));

		const fresh = await checker.checkFilesBatch([x], tmp);

		gate.open();
		const scanResult = await scan;

		// The scan still reports its own findings to its own caller...
		expect(scanResult.count).toBe(1);
		expect(fresh.results.get(x)?.hasCircular).toBe(false);
		// ...and leaves the newer batch's published state alone.
		expect(checker.isInCircular(y)).toBe(false);
	});
});
