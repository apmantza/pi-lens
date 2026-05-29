import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawn = vi.fn();
const safeSpawnAsync = vi.fn((...args: Parameters<typeof safeSpawn>) =>
	Promise.resolve(safeSpawn(...args)),
);

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn,
	safeSpawnAsync,
}));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: (command: string) => ({
		isAvailable: () => true,
		isAvailableAsync: async () => true,
		getCommand: () => command,
	}),
}));

function createCtx(kind: "java" | "csharp", filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind,
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
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

	it("parses javac blocking diagnostics for the edited file", async () => {
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
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]?.tool).toBe("javac");
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
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]?.tool).toBe("cpp-check");
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
