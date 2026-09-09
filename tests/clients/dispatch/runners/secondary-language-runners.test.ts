import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();
let availabilityCheck: (command: string) => boolean = () => true;

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: (command: string) => ({
			isAvailable: () => availabilityCheck(command),
			isAvailableAsync: async () => availabilityCheck(command),
			getCommand: () => command,
		}),
	}),
);

function mockRunnerHelpers(
	isAvailable: (command: string) => boolean = () => true,
): void {
	availabilityCheck = isAvailable;
}

function createCtx(
	kind: "dart" | "zig" | "gleam" | "elixir",
	filePath: string,
	cwd: string,
) {
	return makeRunnerCtx(filePath, cwd, { kind });
}

describe("secondary language fallback runners", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		availabilityCheck = () => true;
		mockRunnerHelpers();
	});

	it("surfaces a warning when dart analyze exits non-zero without machine diagnostics", async () => {
		const env = setupTestEnvironment("pi-lens-dart-runner-");
		try {
			const filePath = path.join(env.tmpDir, "lib", "main.dart");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "void main() {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "dart analyze failed unexpectedly",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/dart-analyze.js")
			).default;

			const result = await runner.run(
				createCtx("dart", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.message).toContain("dart analyze failed");
		} finally {
			env.cleanup();
		}
	});

	it("falls back to flutter analyze when dart is unavailable", async () => {
		vi.resetModules();
		mockRunnerHelpers((command) => command === "flutter");

		const env = setupTestEnvironment("pi-lens-dart-flutter-runner-");
		try {
			const filePath = path.join(env.tmpDir, "lib", "main.dart");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "void main() {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: `warning|static_warning|unused_import|${filePath}|2|1|1|Unused import`,
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/dart-analyze.js")
			).default;

			const result = await runner.run(
				createCtx("dart", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("succeeded");
			expect(result.semantic).toBe("warning");
			expect(safeSpawnAsync.mock.calls[0]?.[0]).toBe("flutter");
		} finally {
			env.cleanup();
		}
	});

	it("surfaces a warning when zig exits non-zero without structured diagnostics", async () => {
		const env = setupTestEnvironment("pi-lens-zig-runner-");
		try {
			const filePath = path.join(env.tmpDir, "src", "main.zig");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "pub fn main() void {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "zig failed before emitting diagnostics",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/zig-check.js")
			).default;

			const result = await runner.run(
				createCtx("zig", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.message).toContain("zig failed");
		} finally {
			env.cleanup();
		}
	});

	it("keeps context-free zig compiler diagnostics non-blocking", async () => {
		const env = setupTestEnvironment("pi-lens-zig-contextless-");
		try {
			const filePath = path.join(env.tmpDir, "src", "main.zig");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "pub fn main() void {}\n");
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: `${filePath}:2:1: error: unable to load module`,
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/zig-check.js")
			).default;
			const result = await runner.run(
				createCtx("zig", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.semantic).toBe("warning");
		} finally {
			env.cleanup();
		}
	});

	it("surfaces a blocking diagnostic when gleam exits non-zero without structured output", async () => {
		const env = setupTestEnvironment("pi-lens-gleam-runner-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.gleam");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "pub fn main() { Nil }\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "gleam check failed unexpectedly",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/gleam-check.js")
			).default;

			const result = await runner.run(
				createCtx("gleam", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]?.message).toContain("gleam check failed");
		} finally {
			env.cleanup();
		}
	});

	it("surfaces a blocking diagnostic when elixir compile exits non-zero without structured output", async () => {
		const env = setupTestEnvironment("pi-lens-elixir-runner-");
		try {
			const filePath = path.join(env.tmpDir, "lib", "app.ex");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(
				path.join(env.tmpDir, "mix.exs"),
				"defmodule Demo.MixProject do end\n",
			);
			fs.writeFileSync(filePath, "defmodule App do\n");

			// mix availability is now answered by the mocked createAvailabilityChecker
			// (#120), so only the actual `mix compile` spawn needs mocking here.
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: "",
				stderr: "** (SyntaxError) lib/app.ex:1:1: unexpected end of file",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/elixir-check.js")
			).default;

			const result = await runner.run(
				createCtx("elixir", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]?.tool).toBe("elixir-check");
		} finally {
			env.cleanup();
		}
	});

	it("keeps standalone elixirc diagnostics non-blocking", async () => {
		const env = setupTestEnvironment("pi-lens-elixirc-contextless-");
		try {
			const filePath = path.join(env.tmpDir, "app.ex");
			fs.writeFileSync(filePath, "defmodule App do\n");
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "** (CompileError) app.ex:1:1: module Dependency is not loaded",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/elixir-check.js")
			).default;
			const result = await runner.run(
				createCtx("elixir", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("succeeded");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.semantic).toBe("warning");
		} finally {
			env.cleanup();
		}
	});
});
