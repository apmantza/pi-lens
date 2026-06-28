// Kotlin + C# callback rule slices, isolated for the #255 multi-grammar wall.
//
// Both are HEAVY tree-sitter grammars. Co-loading several heavy grammars in one
// worker exhausts V8 zone memory (a hard `Fatal process out of memory: Zone`),
// so each heavy-grammar group gets its own small file. Swift/C++ live in
// `module-report-native-callbacks.test.ts`; Java rides `module_report.test.ts`.

import { afterEach, describe, expect, it } from "vitest";
import { moduleReport } from "../../clients/module-report.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function makeEnv() {
	const env = setupTestEnvironment("pi-lens-modreport-kc-");
	cleanups.push(env.cleanup);
	return env;
}

describe("module_report — callback slices (Kotlin/C#)", () => {
	it("flags Kotlin coroutine builders", async () => {
		const env = makeEnv();
		const kt = createTempFile(
			env.tmpDir,
			"lifecycle.kt",
			"fun run() {\n  scope.launch {\n    refresh()\n  }\n}\n",
		);

		const report = await moduleReport(kt, env.tmpDir);
		expect(report.callbackSupport).toBe("tuned");
		const coroutine = report.callbacks.find((c) => c.kind === "coroutine");
		expect(coroutine).toBeDefined();
		expect(coroutine?.flags).toContain("coroutine");
	});

	it("flags Kotlin suspend functions as async", async () => {
		const env = makeEnv();
		const kt = createTempFile(
			env.tmpDir,
			"suspend.kt",
			"suspend fun load() {}\nfun plain() {}\n",
		);
		const report = await moduleReport(kt, env.tmpDir);
		const entries = [...report.api, ...report.internal];
		expect(entries.find((s) => s.name === "load")?.flags).toContain("async");
		expect(entries.find((s) => s.name === "plain")?.flags ?? []).not.toContain(
			"async",
		);
	});

	it("flags C# Task.Run and event += handlers", async () => {
		const env = makeEnv();
		const cs = createTempFile(
			env.tmpDir,
			"Lifecycle.cs",
			[
				"class C {",
				"  void Run() {",
				"    Task.Run(() => Work());",
				"    btn.Click += (s, e) => Handle();",
				"  }",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(cs, env.tmpDir);
		expect(report.callbackSupport).toBe("tuned");
		expect(report.callbacks.find((c) => c.kind === "task")).toBeDefined();
		const event = report.callbacks.find((c) => c.kind === "event_handler");
		expect(event?.flags).toContain("event +=");
	});
});
