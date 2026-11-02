// flake-shape: elapsed-time-assertion — #5173 measures real host exit within 3s of teardown.
// flake-shape: real-process-spawn — #5169 needs a separate event loop to witness natural exit.
/**
 * #5169 real-spawn admission: only a separate Node event loop can prove that
 * the dependency's ref'd partial-message timer stops after transport death.
 * Fake timers in a Vitest worker cannot witness natural process exit.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { pinFixtureHome } from "../test-utils.js";

const run = promisify(execFile);
const host = fileURLToPath(
	new URL("../../fixtures/fake-lsp-server-partial-host.mjs", import.meta.url),
);

for (const mode of ["exit", "shutdown"]) {
	it(`releases the partial-message timer after ${mode} (#5169)`, async () => {
		pinFixtureHome("partial-message-5169");
		// #5169: teardown must not retain the dependency’s pending 10s tick.
		const pending = run(process.execPath, [host, mode], {
			timeout: 16_000,
			killSignal: "SIGKILL",
			maxBuffer: 1024 * 1024,
		});
		let teardownAt = 0;
		pending.child.stdout?.on("data", (data) => {
			if (data.toString().includes(`completed:${mode}:partial-body`)) {
				teardownAt = performance.now();
			}
		});
		const { stdout } = await pending.catch((error) => {
			expect(error.stdout).toContain(`completed:${mode}:partial-body`);
			expect(
				error.killed,
				"host retained a ref’d handle after LSP teardown",
			).toBe(false);
			throw error;
		});
		expect(teardownAt).toBeGreaterThan(0);
		expect(performance.now() - teardownAt).toBeLessThan(3_000);
		expect(stdout).toContain(`completed:${mode}:partial-body`);
		expect(stdout).toContain("natural-exit:no-ref-timer");
	}, 20_000);
}
