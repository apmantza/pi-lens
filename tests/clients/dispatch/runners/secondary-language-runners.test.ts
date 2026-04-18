import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
}));

function mockRunnerHelpers(
	isAvailable: (command: string) => boolean = () => true,
): void {
	vi.doMock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
		createAvailabilityChecker: (command: string) => ({
			isAvailable: () => isAvailable(command),
			getCommand: () => command,
		}),
	}));
}

function createCtx(
	kind: "dart" | "zig" | "gleam" | "elixir",
	filePath: string,
	cwd: string,
) {
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

describe("secondary language fallback runners", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
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

			const runner = (await import(
				"../../../../clients/dispatch/runners/dart-analyze.js"
			)).default;

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

			const runner = (await import(
				"../../../../clients/dispatch/runners/dart-analyze.js"
			)).default;

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

			const runner = (await import(
				"../../../../clients/dispatch/runners/zig-check.js"
			)).default;

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

			const runner = (await import(
				"../../../../clients/dispatch/runners/gleam-check.js"
			)).default;

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
			fs.writeFileSync(path.join(env.tmpDir, "mix.exs"), "defmodule Demo.MixProject do end\n");
			fs.writeFileSync(filePath, "defmodule App do\n");

			safeSpawnAsync
				.mockResolvedValueOnce({ error: null, status: 0, stdout: "Mix 1.18.0", stderr: "" })
				.mockResolvedValueOnce({
					error: null,
					status: 1,
					stdout: "",
					stderr: "** (SyntaxError) lib/app.ex:1:1: unexpected end of file",
				});

			const runner = (await import(
				"../../../../clients/dispatch/runners/elixir-check.js"
			)).default;

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
});
