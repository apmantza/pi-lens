/**
 * ESLint runs where its config lives, but looks its binary up in the package
 * the file lives in (#5541, #5543 review F2).
 *
 * A root flat config moves the child's cwd to the config directory. The
 * install lookup is exact-cwd (#2544 r4 F2), so the lookup that moved with the
 * cwd stopped finding a pnpm-style package-only install and let a root install
 * outrank a package pin. Recurrence this file prevents: the spawn cwd and the
 * package-scoped lookup being one value again.
 *
 * The real runner and the real binary ladder run on a real filesystem fixture;
 * only the child-process boundary is doubled, to record the command and cwd of
 * each spawn (an ESLint of the right version is not what is under test).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDispatchAvailabilityState } from "../../../../clients/dispatch/runners/utils/runner-helpers.js";
import { resetProjectLensConfigCache } from "../../../../clients/project-lens-config.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../../clients/project-trust.js";
import { resetWorkspaceTopology } from "../../../../clients/workspace-topology.js";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { createTempFile, setupTestEnvironment } from "../../test-utils.js";

const spawns = vi.hoisted(
	() => [] as Array<{ command: string; args: string[]; cwd?: string }>,
);
// The exit status the double gives `--version`: 0 for an install that works.
const versionProbe = vi.hoisted(() => ({ status: 0 }));

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync: (
		command: string,
		args: string[] = [],
		options?: { cwd?: string },
	) => {
		spawns.push({ command, args, cwd: options?.cwd });
		const isProbe = args.includes("--version");
		return Promise.resolve({
			error: null,
			status: isProbe ? versionProbe.status : 0,
			stdout: isProbe ? "v9.39.5\n" : "[]",
			stderr: "",
		});
	},
}));

function plantEslint(dir: string): string {
	const bin = path.join(dir, "node_modules", ".bin");
	fs.mkdirSync(bin, { recursive: true });
	const file = path.join(
		bin,
		process.platform === "win32" ? "eslint.cmd" : "eslint",
	);
	fs.writeFileSync(file, "#!/bin/sh\n");
	fs.chmodSync(file, 0o755);
	return file;
}

/** A root flat config over `apps/web`, which has its own manifest. */
function rootConfigOverPackage(tmpDir: string): string {
	createTempFile(tmpDir, "package.json", '{"name":"root"}');
	createTempFile(tmpDir, "apps/web/package.json", '{"name":"web"}');
	createTempFile(tmpDir, "eslint.config.mjs", "export default [];\n");
	return createTempFile(tmpDir, "apps/web/src/x.js", "const a = 1;\n");
}

async function runEslint(filePath: string, dispatchRoot: string) {
	const runner = (
		await import("../../../../clients/dispatch/runners/eslint.js")
	).default;
	return runner.run(makeRunnerCtx(filePath, dispatchRoot) as never);
}

const lintSpawns = () =>
	spawns.filter((spawn) => spawn.args.includes("--format"));

describe("eslint runner cwd follows the config, lookup follows the package (#5541)", () => {
	beforeEach(() => {
		spawns.length = 0;
		versionProbe.status = 0;
		setProjectTrustState("trusted");
		resetDispatchAvailabilityState();
		resetProjectLensConfigCache();
		resetWorkspaceTopology();
	});
	afterEach(() => {
		resetProjectTrust();
		resetProjectLensConfigCache();
		resetWorkspaceTopology();
		resetDispatchAvailabilityState();
	});

	it("runs the package's own eslint, in the config directory, when only the package installs it", async () => {
		// Recurrence: #5543 r1 F2/B2 (Qodo C1): `skipped/not-installed` for a
		// pnpm-style install, where the package ran before the anchor.
		const env = setupTestEnvironment("pi-lens-eslint-pkg-only-");
		try {
			const filePath = rootConfigOverPackage(env.tmpDir);
			const shim = plantEslint(path.join(env.tmpDir, "apps", "web"));

			const result = await runEslint(filePath, env.tmpDir);

			expect(result.status).toBe("succeeded");
			expect(lintSpawns()).toHaveLength(1);
			expect(lintSpawns()[0]?.command).toBe(shim);
			expect(lintSpawns()[0]?.cwd).toBe(env.tmpDir);
		} finally {
			env.cleanup();
		}
	});

	it("keeps the package's pinned eslint over a root install", async () => {
		// Recurrence: #5543 r1 F2 ("both" layout): the root install won.
		const env = setupTestEnvironment("pi-lens-eslint-pkg-pin-");
		try {
			const filePath = rootConfigOverPackage(env.tmpDir);
			plantEslint(env.tmpDir);
			const shim = plantEslint(path.join(env.tmpDir, "apps", "web"));

			await runEslint(filePath, env.tmpDir);

			expect(lintSpawns().map((spawn) => spawn.command)).toEqual([shim]);
			expect(lintSpawns()[0]?.cwd).toBe(env.tmpDir);
		} finally {
			env.cleanup();
		}
	});

	it("words a rejected package install from the package's own verdict", async () => {
		// Recurrence: #5543 r1 F1/F2 (`toolAbsentSkip`): the verdict is latched per
		// lookup directory, so asking it at the config directory read "no
		// verdict" and worded a package binary that failed its version probe as
		// not-installed.
		const env = setupTestEnvironment("pi-lens-eslint-pkg-rejected-");
		try {
			const filePath = rootConfigOverPackage(env.tmpDir);
			plantEslint(path.join(env.tmpDir, "apps", "web"));
			versionProbe.status = 1;

			const result = await runEslint(filePath, env.tmpDir);

			expect(result.status).toBe("skipped");
			expect(result.skipReason).toBe("probe-rejected");
			expect(lintSpawns()).toEqual([]);
		} finally {
			env.cleanup();
		}
	});
});
