import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect } from "vitest";

// Windows keeps a file handle inside a just-used temp dir alive briefly after
// a child process/watcher/background scan exits (AV scanning, delayed handle
// release, or — as in #810's runtime-session.test.ts case — a fire-and-forget
// background task the test didn't wait to settle before tearing down). An
// immediate recursive `rm` can race that and throw EPERM/ENOTEMPTY (#793,
// #810). `maxRetries`/`retryDelay` gives Windows a moment to release the
// handle; if it's STILL held after retrying, a leftover temp dir under the
// OS temp root is harmless (the OS reclaims it eventually) while failing the
// whole test run over teardown is not — so the final failure warns instead
// of throwing. This is the ONE shared cleanup helper for test temp dirs
// (#810's pattern-class rule) — route every ad-hoc `fs.rmSync(dir, {
// recursive: true, force: true })` teardown through this instead of
// hand-rolling retries per suite.
export function removeTempDirSync(dir: string): void {
	try {
		fs.rmSync(dir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 200,
		});
	} catch (err) {
		console.warn(
			`[test cleanup] could not remove temp dir ${dir}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

export function setupTestEnvironment(prefix = "pi-lens-test-"): {
	tmpDir: string;
	cleanup: () => void;
} {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	activeTestEnvironments.set(tmpDir, expect.getState().currentTestName);
	return {
		tmpDir,
		cleanup: () => {
			removeTempDirSync(tmpDir);
			// Keep ownership tracked: deferred work can recreate this root after
			// the per-test removal, and the owning suite must sweep it again.
		},
	};
}

// The map is deliberately module-scoped: Vitest gives each worker its own
// module instance, so one worker cannot sweep another worker's live fixture.
// A missing test name means the root was minted by describe/beforeAll setup;
// the file-level afterAll owns that root instead of an individual afterEach.
const activeTestEnvironments = new Map<string, string | undefined>();

export function cleanupTestEnvironments(testName?: string): void {
	for (const [tmpDir, owner] of activeTestEnvironments) {
		if (testName !== undefined && owner !== testName) continue;
		removeTempDirSync(tmpDir);
		activeTestEnvironments.delete(tmpDir);
	}
}

export function createTempFile(
	baseDir: string,
	relativePath: string,
	content: string,
): string {
	const filePath = path.join(baseDir, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	return filePath;
}
