import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
const logExtension = vi.hoisted(() => vi.fn());
vi.mock("../../clients/extension-log.js", () => ({ logExtension }));
import {
	classifySpawnFailure,
	resetSafeSpawnWindowsCommandCache,
	safeSpawnAsync,
} from "../../clients/safe-spawn.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { removeTempDirSync } from "./test-utils.js";

describe("safe-spawn typed failure taxonomy", () => {
	beforeEach(() => {
		logExtension.mockClear();
		resetDegradationLedger();
		resetSafeSpawnWindowsCommandCache();
	});
	it("distinguishes an unresolvable cwd from a missing present tool", async () => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-spawn-cwd-"));
		const missingCwd = path.join(parent, "gone");
		try {
			const result = await safeSpawnAsync(process.execPath, ["--version"], {
				cwd: missingCwd,
				timeout: 5_000,
			});

			expect(result.failure).toBe("spawn");
			expect(result.spawnFailure?.kind).toBe("cwd-unresolvable");
			expect(
				(result.spawnFailure?.cause as NodeJS.ErrnoException | undefined)?.code,
			).toBe("ENOENT");
		} finally {
			removeTempDirSync(parent);
		}
	});

	it("a genuinely missing tool classifies tool-not-found even under a broken cwd (#1340 review)", async () => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-spawn-cwd-"));
		const missingCwd = path.join(parent, "gone");
		try {
			const result = await safeSpawnAsync(
				"pi-lens-definitely-not-a-real-tool-1340",
				["--version"],
				{ cwd: missingCwd, timeout: 5_000 },
			);

			expect(result.failure).toBe("spawn");
			// The cwd probe must NOT shadow the missing executable: reinstall is
			// the correct repair here, and it keys on tool-not-found only.
			expect(result.spawnFailure?.kind).toBe("tool-not-found");
		} finally {
			removeTempDirSync(parent);
		}
	});

	it("classifies errno intent while preserving the original Error as cause", async () => {
		const missing = Object.assign(new Error("spawn missing ENOENT"), {
			code: "ENOENT",
		});
		const denied = Object.assign(new Error("spawn denied EACCES"), {
			code: "EACCES",
		});
		const other = Object.assign(new Error("spawn busy EBUSY"), {
			code: "EBUSY",
		});

		const missingFailure = await classifySpawnFailure(missing, {
			command: "missing",
		});
		const deniedFailure = await classifySpawnFailure(denied, {
			command: "denied",
		});
		const otherFailure = await classifySpawnFailure(other, { command: "busy" });

		expect(missingFailure.kind).toBe("tool-not-found");
		expect(missingFailure.cause).toBe(missing);
		expect(deniedFailure.kind).toBe("permission-denied");
		expect(deniedFailure.cause).toBe(denied);
		expect(otherFailure.kind).toBe("spawn-failed");
		expect((otherFailure.cause as NodeJS.ErrnoException).code).toBe("EBUSY");
		expect(logExtension).toHaveBeenCalledTimes(3);
		expect(logExtension).toHaveBeenCalledWith(
			expect.objectContaining({
				level: "debug",
				metadata: {
					kind: "permission-denied",
					command: "denied",
					cwd: undefined,
				},
			}),
		);
		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({ kind: "spawn-failure", count: 2 }),
		]);
	});

	it("logs only once per command and bucket while tallying each failure", async () => {
		const denied = Object.assign(new Error("denied"), { code: "EACCES" });
		await classifySpawnFailure(denied, { command: "same", cwd: "/work" });
		await classifySpawnFailure(denied, { command: "same", cwd: "/else" });
		expect(logExtension).toHaveBeenCalledTimes(1);
		expect(getDegradationSummary()[0].count).toBe(2);
	});

	it("exposes timeout and killed as typed process-control failures", async () => {
		const timeout = await safeSpawnAsync(process.execPath, ["--version"], {
			timeout: 0,
		});
		const controller = new AbortController();
		controller.abort();
		const killed = await safeSpawnAsync(process.execPath, ["--version"], {
			signal: controller.signal,
		});

		expect(timeout.spawnFailure?.kind).toBe("timeout");
		expect(timeout.spawnFailure?.cause).toBe(timeout.error);
		expect(killed.spawnFailure?.kind).toBe("killed");
		expect(killed.spawnFailure?.cause).toBe(killed.error);
	});
});
// flake-shape: real-process-spawn — the real child failure boundary is the taxonomy contention under test
