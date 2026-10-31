/**
 * #5119: the markdownlint runner lints through markdownlint-cli2's exported
 * `main` when the module sits beside the resolved command, and spawns the CLI
 * only when it does not. A test whose synthetic cli2 output is fed through a
 * mocked spawn drives the spawn branch, which a host with cli2 on PATH (a
 * global install, the real-bytes tool tree) would silently bypass: the bare
 * command name resolves through PATH to the real module. Call this once at
 * module scope to run every case with an empty PATH, so the spawn branch is
 * the one under test on every host. The API branch is driven by
 * markdownlint-api.test.ts and markdownlint-no-fix-real.test.ts.
 */
import { afterEach, beforeEach, vi } from "vitest";

export function pinNoCli2OnPath(): void {
	beforeEach(() => {
		vi.stubEnv("PATH", "");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});
}
