// Swift + C++ callback rule slices, in their OWN file on purpose.
//
// The Swift and C++ tree-sitter grammars are heavy, and loading many grammars
// into a single worker tips web-tree-sitter over (the #255 multi-grammar
// instability — `module_report.test.ts` already loads 6). Keeping these two in a
// dedicated file means the worker that runs them loads only the swift/cpp
// grammars, well under the tipping point.

import { afterEach, describe, expect, it } from "vitest";
import { moduleReport } from "../../clients/module-report.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function makeEnv() {
	const env = setupTestEnvironment("pi-lens-modreport-native-");
	cleanups.push(env.cleanup);
	return env;
}

describe("module_report — native-grammar callback slices (Swift/C++)", () => {
	it("flags Swift strong vs weak self capture in closures", async () => {
		const env = makeEnv();
		const sw = createTempFile(
			env.tmpDir,
			"lifecycle.swift",
			[
				"class C {",
				"  func run() {",
				"    DispatchQueue.main.async {",
				"      self.refresh()",
				"    }",
				"  }",
				"  func safe() { api.fetch { [weak self] in self?.done() } }",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(sw, env.tmpDir);
		expect(report.callbackSupport).toBe("tuned");
		// Strong self capture across an async boundary = retain-cycle risk.
		expect(
			report.callbacks.find((c) => c.flags?.includes("captures self")),
		).toBeDefined();
		// The [weak self] closure is the safe variant.
		expect(
			report.callbacks.find((c) => c.flags?.includes("weak self")),
		).toBeDefined();
	});

	it("flags C++ by-reference lambda capture and thread launches", async () => {
		const env = makeEnv();
		const cc = createTempFile(
			env.tmpDir,
			"lifecycle.cpp",
			[
				"void run() {",
				"  auto f = [&]() { handle(); };",
				"  std::thread([=]() { work(); });",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(cc, env.tmpDir);
		expect(report.callbackSupport).toBe("tuned");
		// [&] default capture can dangle once the scope returns.
		expect(
			report.callbacks.find((c) => c.flags?.includes("captures by reference")),
		).toBeDefined();
		const task = report.callbacks.find((c) => c.kind === "task");
		expect(task?.flags).toContain("spawned");
	});
});
