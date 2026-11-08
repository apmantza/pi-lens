/**
 * #5446: `JscpdClient.hasSourceFilesRecursive` gates the whole-project scan
 * with a hand-spelled source regex; an `.mts`/`.cts`-only project bailed at
 * the gate and jscpd never ran — the exact pre-#126 shape, one extension
 * family later. The JS/TS family now answers through the registry seam
 * (`isJstsFactFile`, `clients/file-kinds.ts`); the non-TS tail stays, and
 * the ambient-declaration twins (`.d.ts`, `.d.mts`, `.d.cts`) stay out:
 * a declarations-only root has no copy-paste to find.
 *
 * Harness and availability mocks are the ones `jscpd-client.test.ts` uses;
 * the #126 table below it pins the same "the spawn now happens" evidence.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "./test-utils.js";

const ensureTool = vi.fn();
const findNodeToolBinary = vi.fn();

vi.mock("../../clients/installer/index.js", () => ({
	findManagedToolBinary: vi.fn(async () => undefined),
	ensureTool,
	getInstallAttempt: vi.fn(() => undefined),
	getLastEnsureResolutionSource: vi.fn(() => undefined),
	getToolInstallStrategy: vi.fn(() => undefined),
	resetPathWalkMemo: vi.fn(),
	isSpawnableCommand: vi.fn(async () => true),
}));
vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/package-manager.js")
	>()),
	findNodeToolBinary,
}));
vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync: vi.fn(async () => ({
		error: undefined,
		status: 0,
		stdout: "",
		stderr: "",
	})),
}));

describe("#5446 jscpd walk gate accepts the JS/TS family through the registry", () => {
	beforeEach(async () => {
		const safeSpawnMod = await import("../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockClear();
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
			error: undefined,
			status: 0,
			stdout: "",
			stderr: "",
		});
		ensureTool.mockReset();
		findNodeToolBinary.mockReset();
		const helpers =
			await import("../../clients/dispatch/runners/utils/runner-helpers.js");
		helpers.resetDispatchAvailabilityState();
		findNodeToolBinary.mockResolvedValue(null);
	});

	async function scanFilesNamed(names: string[]): Promise<void> {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const safeSpawnMod = await import("../../clients/safe-spawn.js");
		const { tmpDir } = setupTestEnvironment("pi-lens-5446-jscpd-");
		try {
			for (const name of names) {
				const file = path.join(tmpDir, "src", name);
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, "export const a = 1;\nexport const b = 2;\n");
			}
			const client = new JscpdClient(false) as unknown as {
				scan: (
					cwd: string,
					minLines: number,
					minTokens: number,
					isTsProject: boolean,
				) => Promise<unknown>;
				ensureAvailable: () => Promise<boolean>;
			};
			await client.ensureAvailable();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockClear();

			await client.scan(tmpDir, 5, 50, false);

			// Pre-fix: an .mts/.cts-only project bailed at
			// `hasSourceFilesRecursive` without ever invoking jscpd.
			expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalled();
		} finally {
			await cleanupTestEnvironmentsDrained("pi-lens-5446-jscpd-");
		}
	}

	for (const ext of [".mts", ".cts"]) {
		it(`scans when only ${ext} source files exist`, () =>
			scanFilesNamed([`dup${ext}`]));
	}

	it("does NOT scan a declarations-only root (.d.ts/.d.mts/.d.cts)", async () => {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const safeSpawnMod = await import("../../clients/safe-spawn.js");
		const { tmpDir } = setupTestEnvironment("pi-lens-5446-jscpd-decl-");
		try {
			for (const name of ["types.d.ts", "types.d.mts", "types.d.cts"]) {
				fs.writeFileSync(path.join(tmpDir, name), "export type X = 1;\n");
			}
			const client = new JscpdClient(false) as unknown as {
				scan: (
					cwd: string,
					minLines: number,
					minTokens: number,
					isTsProject: boolean,
				) => Promise<{ success: boolean; clones: unknown[] }>;
				ensureAvailable: () => Promise<boolean>;
			};
			await client.ensureAvailable();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockClear();

			const result = await client.scan(tmpDir, 5, 50, false);

			expect(result.success).toBe(true);
			expect(result.clones).toEqual([]);
			expect(safeSpawnMod.safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			await cleanupTestEnvironmentsDrained("pi-lens-5446-jscpd-decl-");
		}
	});
});
