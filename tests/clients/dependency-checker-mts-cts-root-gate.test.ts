/**
 * #5446: `DependencyChecker.scanProject` gates a whole-project scan on a
 * root readdir with a hand-spelled `/\.(ts|tsx|js|jsx)$/` — an `.mts`-only
 * project never even probed for madge, so circular-dependency analysis
 * silently skipped ESM-module TypeScript roots. The JS/TS family now
 * answers through the registry seam (`isJstsFactFile`,
 * `clients/file-kinds.ts`), and the ambient-declaration gate that already
 * skipped `.d.ts` skips its `.d.mts`/`.d.cts` twins: a declarations-only
 * root is still not a scannable root.
 *
 * The availability/spawn mocks are `dependency-checker-scan-project-cycles
 * .test.ts`'s (process boundaries only: safe-spawn, package-manager,
 * installer); the scan bytes replay the captured madge 8.0.0 fixture so the
 * green side parses through the real `parseMadgeCycles`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

const safeSpawnAsync = vi.fn();
const findNodeToolBinary = vi.fn();
const ensureTool = vi.fn();

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));
vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/package-manager.js")
	>()),
	findNodeToolBinary,
}));
vi.mock("../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/installer/index.js")
	>()),
	findManagedToolBinary: vi.fn(async () => undefined),
	ensureTool,
	getManagedToolsDir: () => path.join(os.tmpdir(), "pilens-fake-home", "tools"),
	isSpawnableCommand: vi.fn(async () => true),
}));

const VERSION_OK = {
	status: 0,
	error: null,
	stdout: "madge 8.0.0",
	stderr: "",
};

/** madge 8.0.0's cycle-array shape (exit 1 BECAUSE a cycle was found). */
const CYCLE_JSON = JSON.stringify([["__ROOT__/index.mts", "__ROOT__/dep.mts"]]);

function writeRootFiles(root: string, names: string[]): void {
	for (const name of names) {
		fs.writeFileSync(path.join(root, name), "export const a = 1;\n");
	}
}

describe("#5446 scanProject root gate answers JS/TS through the registry", () => {
	let tmp: string;

	beforeEach(() => {
		vi.resetAllMocks();
		tmp = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5446-depcheck-")),
		);
		findNodeToolBinary.mockResolvedValue("madge");
		ensureTool.mockResolvedValue(undefined);
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "--version") return VERSION_OK;
			return {
				status: 1,
				error: null,
				stdout: CYCLE_JSON.split("__ROOT__").join(tmp),
				stderr: "",
			};
		});
	});

	afterEach(() => {
		removeTempDirSync(tmp);
	});

	it("scans a root whose only sources are .mts/.cts", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		writeRootFiles(tmp, ["index.mts", "dep.mts", "types.cts"]);

		const result = await new DependencyChecker().scanProject(tmp);

		// Pre-fix: the readdir gate returned {circular: [], count: 0} without
		// ever probing madge, so `analyzed` stayed unset.
		expect(result.analyzed).toBe(true);
		expect(result.count).toBe(1);
	});

	it("still skips a root whose only JS/TS files are ambient declarations", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		writeRootFiles(tmp, ["types.d.ts", "types.d.mts", "types.d.cts"]);

		const result = await new DependencyChecker().scanProject(tmp);

		expect(result.analyzed).toBeFalsy();
		expect(result.count).toBe(0);
		// No scan spawn: only the availability probe may have run, and a
		// gated root must not even pay that.
		expect(
			safeSpawnAsync.mock.calls.filter(
				(c) => (c[1] as string[])[0] !== "--version",
			),
		).toHaveLength(0);
	});
});
