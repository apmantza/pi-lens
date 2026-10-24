import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

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

function createCtx(kind: "java" | "csharp", filePath: string, cwd: string) {
	return makeRunnerCtx(filePath, cwd, { kind });
}

describe("java/csharp fallback runners", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawn.mockReset();
		safeSpawnAsync.mockReset();
		safeSpawnAsync.mockImplementation((...args: Parameters<typeof safeSpawn>) =>
			Promise.resolve(safeSpawn(...args)),
		);
	});

	it("keeps standalone javac diagnostics non-blocking", async () => {
		const env = setupTestEnvironment("pi-lens-javac-runner-");
		try {
			const filePath = path.join(env.tmpDir, "src", "App.java");
			safeSpawn.mockReturnValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: `${filePath}:7: error: cannot find symbol`,
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/javac.js")
			).default;
			const result = await runner.run(
				createCtx("java", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.tool).toBe("javac");
			expect(result.diagnostics[0]?.semantic).toBe("warning");
			expect(result.diagnostics[0]?.line).toBe(7);
		} finally {
			env.cleanup();
		}
	});

	it("parses dotnet build diagnostics for the edited csharp file", async () => {
		const env = setupTestEnvironment("pi-lens-dotnet-build-runner-");
		try {
			// pi-lens-ignore: ts-path-traversal — test-owned temp directory from setupTestEnvironment
			const projectPath = path.join(env.tmpDir, "LensTool.csproj");
			const filePath = path.join(env.tmpDir, "Program.cs");
			fs.writeFileSync(projectPath, '<Project Sdk="Microsoft.NET.Sdk" />\n');
			safeSpawn.mockImplementation((command: string, args?: string[]) => {
				if (command === "dotnet" && args?.[0] === "--version") {
					return { error: null, status: 0, stdout: "9.0.0", stderr: "" };
				}
				return {
					error: null,
					status: 1,
					stdout: `${filePath}(4,13): error CS0103: The name 'oops' does not exist in the current context [${projectPath}]`,
					stderr: "",
				};
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/dotnet-build.js")
			).default;
			const result = await runner.run(
				createCtx("csharp", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]?.tool).toBe("dotnet-build");
			expect(result.diagnostics[0]?.rule).toBe("CS0103");
			expect(result.diagnostics[0]?.line).toBe(4);
			expect(result.diagnostics[0]?.column).toBe(13);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence guarded (#4806): the runner picked its build target with its own
	// `/\.(sln|slnx)$/i` and `/\.(csproj)$/i` tests, beside the .NET marker seam
	// (`DOTNET_CSHARP_ROOT_MARKERS`, files only). A directory named like a project
	// file was handed to `dotnet build` as the target.
	describe("dotnet build target comes from the .NET marker seam", () => {
		async function buildTarget(
			files: string[],
			dirs: string[] = [],
		): Promise<string | undefined> {
			const env = setupTestEnvironment("pi-lens-dotnet-target-");
			try {
				for (const file of files)
					// pi-lens-ignore: ts-path-traversal — test-owned temp directory from setupTestEnvironment
					fs.writeFileSync(path.join(env.tmpDir, file), "<Project />\n");
				for (const dir of dirs)
					// pi-lens-ignore: ts-path-traversal — test-owned temp directory from setupTestEnvironment
					fs.mkdirSync(path.join(env.tmpDir, dir));
				const filePath = path.join(env.tmpDir, "Program.cs");
				// One build per call: the mock's call list spans the whole case.
				safeSpawn.mockClear();
				safeSpawn.mockReturnValue({
					error: null,
					status: 0,
					stdout: "",
					stderr: "",
				});
				const runner = (
					await import("../../../../clients/dispatch/runners/dotnet-build.js")
				).default;
				await runner.run(createCtx("csharp", filePath, env.tmpDir) as never);
				const build = safeSpawn.mock.calls.find(
					(call) => call[0] === "dotnet" && call[1]?.[0] === "build",
				);
				return build?.[1]?.[1];
			} finally {
				env.cleanup();
			}
		}

		it("prefers a solution over a project, .slnx included", async () => {
			expect(await buildTarget(["App.csproj", "App.slnx"])).toBe("App.slnx");
			expect(await buildTarget(["App.csproj", "App.sln"])).toBe("App.sln");
			expect(await buildTarget(["App.csproj"])).toBe("App.csproj");
		});

		it("skips a directory named like a project file", async () => {
			expect(await buildTarget([], ["Decoy.csproj"])).toBeUndefined();
		});
	});

	it("parses cxx compiler diagnostics for the edited file", async () => {
		const env = setupTestEnvironment("pi-lens-cpp-runner-");
		try {
			const filePath = path.join(env.tmpDir, "main.cpp");

			safeSpawn.mockImplementation((command: string, args?: string[]) => {
				if (command === "clang++" && args?.[0] === "--version") {
					return {
						error: null,
						status: 0,
						stdout: "clang version 17",
						stderr: "",
					};
				}
				return {
					error: null,
					status: 1,
					stdout: "",
					stderr: `${filePath}:4:13: error: use of undeclared identifier 'nope'`,
				};
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/cpp-check.js")
			).default;
			const result = await runner.run({
				...createCtx("java", filePath, env.tmpDir),
				kind: "cxx",
			} as never);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.tool).toBe("cpp-check");
			expect(result.diagnostics[0]?.semantic).toBe("warning");
		} finally {
			env.cleanup();
		}
	});

	it("checks .c files with a C compiler mode instead of clang++", async () => {
		const env = setupTestEnvironment("pi-lens-c-runner-");
		try {
			const filePath = path.join(env.tmpDir, "main.c");

			safeSpawn.mockImplementation((command: string, args?: string[]) => {
				if (command === "clang" && args?.[0] === "--version") {
					return {
						error: null,
						status: 0,
						stdout: "clang version 17",
						stderr: "",
					};
				}
				return {
					error: null,
					status: 1,
					stdout: "",
					stderr: `${filePath}:1:25: error: use of undeclared identifier 'nope'`,
				};
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/cpp-check.js")
			).default;
			const result = await runner.run({
				...createCtx("java", filePath, env.tmpDir),
				kind: "cxx",
			} as never);

			// The --version probe is now encapsulated inside
			// createAvailabilityChecker (mocked above), so the test only
			// asserts the actual syntax check call. clang wins over gcc/cc
			// for .c files because it is first in the candidate order.
			expect(safeSpawn).toHaveBeenCalledWith(
				"clang",
				["-x", "c", "-fsyntax-only", filePath],
				expect.any(Object),
			);
			expect(safeSpawn).not.toHaveBeenCalledWith(
				"clang++",
				expect.any(Array),
				expect.any(Object),
			);
			expect(result.status).toBe("failed");
			expect(result.diagnostics[0]?.tool).toBe("cpp-check");
		} finally {
			env.cleanup();
		}
	});
});
