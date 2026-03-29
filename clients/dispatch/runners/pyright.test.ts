import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { DispatchContext } from "../types.js";

function createMockContext(filePath: string): DispatchContext {
	return {
		filePath,
		cwd: process.cwd(),
		kind: "python" as any,
		autofix: false,
		deltaMode: false,
		baselines: { get: () => [], add: () => {}, save: () => {} } as any,
		pi: {} as any,
		hasTool: async () => false,
		log: () => {},
	};
}

describe("pyright runner", () => {
	const require = createRequire(import.meta.url);

	it("should have correct runner definition", async () => {
		const pyrightModule = await import("./pyright.js");
		const runner = pyrightModule.default;

		expect(runner.id).toBe("pyright");
		expect(runner.appliesTo).toEqual(["python"]);
		expect(runner.priority).toBe(5); // Higher priority than ruff
		expect(runner.enabledByDefault).toBe(true);
	});

	it("should detect pyright availability", () => {
		const { spawnSync } =
			require("node:child_process") as typeof import("node:child_process");
		const result = spawnSync("npx", ["pyright", "--version"], {
			encoding: "utf-8",
			timeout: 10000,
			shell: true,
		});
		expect(
			result.error || result.status !== 0 ? "not available" : "available",
		).toBe("available");
	});

	it("should type-check Python files and find errors", async () => {
		const tmpFile = path.join(
			process.env.TEMP || "/tmp",
			`pyright_test_${Date.now()}.py`,
		);
		fs.writeFileSync(
			tmpFile,
			`def add(x: int, y: int) -> int:
    return x + y

result: str = add(1, 2)

def greet(name: str) -> str:
    return "Hello " + name

greet(123)
`,
		);

		try {
			const pyrightModule = await import("./pyright.js");
			const runner = pyrightModule.default;
			const result = await runner.run(createMockContext(tmpFile));

			expect(result.diagnostics.length).toBeGreaterThanOrEqual(2);
			expect(result.diagnostics.some((d) => d.tool === "pyright")).toBe(true);
			expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
		} finally {
			fs.unlinkSync(tmpFile);
		}
	});

	it("should pass valid Python files", async () => {
		const tmpFile = path.join(
			process.env.TEMP || "/tmp",
			`pyright_test_ok_${Date.now()}.py`,
		);
		fs.writeFileSync(
			tmpFile,
			`def add(x: int, y: int) -> int:
    return x + y

result: str = str(add(1, 2))

def greet(name: str) -> str:
    return "Hello " + name

greet("world")
`,
		);

		try {
			const pyrightModule = await import("./pyright.js");
			const runner = pyrightModule.default;
			const result = await runner.run(createMockContext(tmpFile));

			expect(result.status).toBe("succeeded");
			expect(result.diagnostics.length).toBe(0);
		} finally {
			fs.unlinkSync(tmpFile);
		}
	});
});
