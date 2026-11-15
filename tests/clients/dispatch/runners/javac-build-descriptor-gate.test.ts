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

async function runJavac(filePath: string, cwd: string, projectRoot?: string) {
	const runner = (await import("../../../../clients/dispatch/runners/javac.js"))
		.default;
	return runner.run(
		makeRunnerCtx(filePath, cwd, { kind: "java", projectRoot }) as never,
	);
}

/**
 * Run javac on the context production builds for a file in a nested module
 * (`runPipeline`): `cwd` is the module's language root, `projectRoot` the
 * workspace (#5631).
 */
async function runJavacOnDispatchContext(
	filePath: string,
	languageRoot: string,
	workspace: string,
) {
	const { createDispatchContext } =
		await import("../../../../clients/dispatch/dispatcher.js");
	const { FactStore } =
		await import("../../../../clients/dispatch/fact-store.js");
	const runner = (await import("../../../../clients/dispatch/runners/javac.js"))
		.default;
	const ctx = createDispatchContext(
		filePath,
		languageRoot,
		{ getFlag: () => undefined } as never,
		new FactStore(),
		false,
		undefined,
		workspace,
	);
	return runner.run(ctx);
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

	it("does not climb past the project root: a pom.xml above it is another project's (#5408)", async () => {
		// Recurrence: the Java descriptor walk was a policy-owned copy with its own
		// ceiling; it is the seam's `ceiling` option now, and this cell is the
		// production caller's contract for it.
		const env = setupTestEnvironment("pi-lens-javac-gate-ceiling-");
		try {
			const project = path.join(env.tmpDir, "work", "app");
			const filePath = path.join(project, "src", "App.java");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "class App {}\n");
			fs.writeFileSync(path.join(env.tmpDir, "pom.xml"), "<project />\n");

			const result = await runJavac(filePath, project, project);

			expect(result.status).not.toBe("skipped");
			expect(safeSpawn).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});

	it("ignores a descriptor above the project when the project root does not contain cwd (#5631)", async () => {
		// Recurrence: #5631 F3. javac asked the config seam with
		// `ctx.projectRoot ?? ctx.cwd`, so a project root that did not contain the
		// file's cwd moved the ceiling out of the project, and a pom.xml above the
		// project marked it as a Maven project. The same question asked through
		// `configCeiling` stops at the cwd here.
		const env = setupTestEnvironment("pi-lens-javac-gate-noncontain-");
		try {
			const project = path.join(env.tmpDir, "work", "app");
			const filePath = path.join(project, "src", "App.java");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "class App {}\n");
			fs.writeFileSync(path.join(env.tmpDir, "pom.xml"), "<project />\n");
			const elsewhere = path.join(env.tmpDir, "elsewhere");
			fs.mkdirSync(elsewhere, { recursive: true });

			const result = await runJavac(filePath, project, elsewhere);

			expect(result.status).not.toBe("skipped");
			expect(safeSpawn).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});

	it("skips a descriptor at cwd when the project root sits below cwd (#5631)", async () => {
		// Recurrence: #5631 F3, the other direction of the non-containing pair.
		// The project root `src` lies below cwd `workspace` and does not contain
		// it, so the shared ceiling stays at cwd and the pom.xml there marks a
		// Maven project. The pre-fix javac expression (`projectRoot ?? cwd`) stops
		// at `src`, misses the pom and spawns javac. The disjoint cell above pins
		// the opposite direction.
		const env = setupTestEnvironment("pi-lens-javac-gate-belowcwd-");
		try {
			const filePath = path.join(env.tmpDir, "src", "App.java");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "class App {}\n");
			fs.writeFileSync(path.join(env.tmpDir, "pom.xml"), "<project />\n");

			const result = await runJavac(
				filePath,
				env.tmpDir,
				path.join(env.tmpDir, "src"),
			);

			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toEqual([]);
			expect(safeSpawn).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("skips an Eclipse module under a Maven workspace on the dispatch context (#5631)", async () => {
		// Recurrence: #5631 F3 on the production shape. `runPipeline` hands javac
		// `cwd` = the module's language root (its `.classpath`) and `projectRoot` =
		// the workspace, whose pom.xml marks the Maven project. A ceiling of
		// `ctx.cwd` (the module) stops the walk below the pom and runs javac on a
		// Maven project. This cell reds under that mutation.
		const env = setupTestEnvironment("pi-lens-javac-gate-eclipse-");
		try {
			const workspace = env.tmpDir;
			const moduleDir = path.join(workspace, "module");
			const filePath = path.join(moduleDir, "src", "App.java");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "class App {}\n");
			fs.writeFileSync(path.join(moduleDir, ".classpath"), "<classpath />\n");
			fs.writeFileSync(path.join(workspace, "pom.xml"), "<project />\n");

			const result = await runJavacOnDispatchContext(
				filePath,
				moduleDir,
				workspace,
			);

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
