import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

// #1877: inside a Maven/Gradle project the classpath-less javac fallback
// turns every non-JDK import into a blocking "package does not exist" false
// positive. The runner must skip when a build descriptor walks up from the
// file, and keep compiling standalone files with no descriptor.

const safeSpawn = vi.fn();
const safeSpawnAsync = vi.fn((...args: Parameters<typeof safeSpawn>) =>
	Promise.resolve(safeSpawn(...args)),
);

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn,
	safeSpawnAsync,
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: (command: string) => ({
			isAvailable: () => true,
			isAvailableAsync: async () => true,
			getCommand: () => command,
		}),
	}),
);

async function runJavac(filePath: string, cwd: string) {
	const runner = (await import("../../../../clients/dispatch/runners/javac.js"))
		.default;
	return runner.run(makeRunnerCtx(filePath, cwd, { kind: "java" }) as never);
}

describe("javac build-descriptor gate (#1877)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawn.mockReset();
		safeSpawnAsync.mockReset();
		safeSpawnAsync.mockImplementation((...args: Parameters<typeof safeSpawn>) =>
			Promise.resolve(safeSpawn(...args)),
		);
		// If the gate fails open, javac reports a clean compile — any status
		// other than "skipped" then proves a spawn the gate should have
		// prevented.
		safeSpawn.mockReturnValue({
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		});
	});

	it("skips when a pom.xml sits above the file", async () => {
		const env = setupTestEnvironment("pi-lens-javac-gate-maven-");
		try {
			const filePath = path.join(env.tmpDir, "src", "main", "java", "App.java");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "class App {}\n");
			fs.writeFileSync(path.join(env.tmpDir, "pom.xml"), "<project />\n");

			const result = await runJavac(filePath, env.tmpDir);

			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toEqual([]);
			expect(result.semantic).toBe("none");
			expect(safeSpawn).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("finds a descriptor below the dispatch cwd (multi-module walk starts at the file)", async () => {
		const env = setupTestEnvironment("pi-lens-javac-gate-gradle-");
		try {
			// The walk must start at the FILE's directory, not the cwd: the
			// module descriptor sits below the workspace root.
			const moduleDir = path.join(env.tmpDir, "module-a");
			const filePath = path.join(moduleDir, "src", "App.java");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "class App {}\n");
			fs.writeFileSync(path.join(moduleDir, "build.gradle.kts"), "// module\n");

			const result = await runJavac(filePath, env.tmpDir);

			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toEqual([]);
			expect(safeSpawn).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("still compiles standalone files with no build descriptor", async () => {
		const env = setupTestEnvironment("pi-lens-javac-gate-standalone-");
		try {
			const filePath = path.join(env.tmpDir, "App.java");
			fs.writeFileSync(filePath, "class App {}\n");
			safeSpawn.mockReturnValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: `${filePath}:3: error: cannot find symbol`,
			});

			const result = await runJavac(filePath, env.tmpDir);

			expect(safeSpawn).toHaveBeenCalledTimes(1);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.tool).toBe("javac");
			expect(result.diagnostics[0]?.semantic).toBe("warning");
			expect(result.diagnostics[0]?.line).toBe(3);
		} finally {
			env.cleanup();
		}
	});
});
