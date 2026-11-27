/**
 * review helpers: rebuild-script selection (pure) and the fresh-worker fork
 * plumbing. The fork tests point at tiny stub workers so they exercise the
 * spawn/parse/error paths deterministically without the heavy real pipeline.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	analyzeFileFresh,
	resolveRebuildScript,
	summarizeScan,
} from "../../../clients/mcp/review.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "../../../clients/spawn-output-cap.js";
import { spawnAbortScope } from "../../../clients/safe-spawn.js";
import { removeTempDirSync } from "../test-utils.js";

describe("resolveRebuildScript", () => {
	it("selects build:dist for a server running from a dist layout", () => {
		expect(resolveRebuildScript("/repo/dist/mcp/server.js")).toBe("build:dist");
		expect(resolveRebuildScript("C:\\repo\\dist\\mcp\\server.js")).toBe(
			"build:dist",
		);
	});

	it("selects build for an in-place dev layout", () => {
		expect(resolveRebuildScript("/repo/mcp/server.js")).toBe("build");
		expect(resolveRebuildScript("C:\\repo\\mcp\\server.js")).toBe("build");
	});
});

describe("summarizeScan", () => {
	it("dedupes by file:line:column:rule and aggregates by rule and file", () => {
		const dupe = {
			filePath: "/x/a.ts",
			line: 1,
			column: 2,
			rule: "ts-path-traversal",
			runner: "tree-sitter",
		};
		const { deduped, byRule, byFile } = summarizeScan([
			dupe,
			{ ...dupe }, // exact duplicate → dropped
			{ filePath: "/x/a.ts", line: 5, rule: "deep-nesting" },
			{ filePath: "/x/b.ts", line: 1, rule: "ts-path-traversal" },
		]);

		expect(deduped).toHaveLength(3);
		expect(byRule).toEqual({ "ts-path-traversal": 2, "deep-nesting": 1 });
		expect(byFile).toEqual({ "/x/a.ts": 2, "/x/b.ts": 1 });
	});

	it("falls back to runner/tool/unknown when no rule is present", () => {
		const { byRule } = summarizeScan([
			{ filePath: "/x/a.ts", line: 1, runner: "fact-rules" },
			{ filePath: "/x/a.ts", line: 2, tool: "tree-sitter" },
			{ filePath: "/x/a.ts", line: 3 },
		]);
		expect(byRule).toEqual({
			"fact-rules": 1,
			"tree-sitter": 1,
			unknown: 1,
		});
	});
});

describe("analyzeFileFresh", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-fresh-"));
	});
	afterAll(() => {
		removeTempDirSync(tmpDir);
	});

	function writeWorker(name: string, body: string): string {
		const file = path.join(tmpDir, name);
		fs.writeFileSync(file, body);
		return file;
	}

	it("parses the worker's JSON stdout into a result", async () => {
		const fakeResult = {
			filePath: "/x/app.ts",
			cwd: "/x",
			fileKind: "jsts",
			durationMs: 12,
			hasBlockers: false,
			counts: { diagnostics: 0, blockers: 0, warnings: 0, fixed: 0 },
			diagnostics: [],
		};
		const worker = writeWorker(
			"ok.mjs",
			`process.stdout.write(${JSON.stringify(JSON.stringify(fakeResult))});`,
		);

		const outcome = await analyzeFileFresh(worker, "/x/app.ts", "/x");
		expect(outcome.error).toBeUndefined();
		expect(outcome.result).toEqual(fakeResult);
	});

	it("surfaces a non-zero exit with the worker's stderr", async () => {
		const worker = writeWorker(
			"boom.mjs",
			`process.stderr.write("kaboom"); process.exit(2);`,
		);
		const outcome = await analyzeFileFresh(worker, "/x/app.ts", "/x");
		expect(outcome.result).toBeUndefined();
		expect(outcome.error).toContain("worker exited 2");
		expect(outcome.error).toContain("kaboom");
	});

	it("reports invalid JSON output", async () => {
		const worker = writeWorker(
			"garbage.mjs",
			`process.stdout.write("not json");`,
		);
		const outcome = await analyzeFileFresh(worker, "/x/app.ts", "/x");
		expect(outcome.result).toBeUndefined();
		expect(outcome.error).toContain("invalid JSON");
	});

	it("passes flags through as a JSON --flags argument", async () => {
		// Echo the parsed --flags back inside a result-shaped object so we can
		// assert the worker received them verbatim.
		const worker = writeWorker(
			"echo-flags.mjs",
			[
				`const raw = process.argv.find((a) => a.startsWith("--flags="));`,
				`const flags = raw ? JSON.parse(raw.slice("--flags=".length)) : null;`,
				`process.stdout.write(JSON.stringify({ flags }));`,
			].join("\n"),
		);
		const outcome = await analyzeFileFresh(worker, "/x/app.ts", "/x", {
			flags: { "no-lsp": true },
		});
		expect((outcome.result as unknown as { flags: unknown }).flags).toEqual({
			"no-lsp": true,
		});
	});

	// Recurrence: #3383's hand-rolled fork bounded its own pipes but ended a
	// timed-out worker with one SIGTERM, so a worker that ignored it, or a
	// process it had started, outlived the call. The fork now rides the spawn
	// seam, whose teardown signals the whole group and escalates to SIGKILL.
	// lane: Unit tests (ubuntu, macOS); win32 teardown is taskkill, covered by
	// the safe-spawn tests.
	describe.skipIf(process.platform === "win32")("timed-out worker", () => {
		function isLive(pid: number): boolean {
			try {
				process.kill(pid, 0);
			} catch {
				return false;
			}
			try {
				// A container's init may never reap: a zombie is a dead process.
				return !/^State:\s*Z/m.test(
					fs.readFileSync(`/proc/${pid}/status`, "utf8"),
				);
			} catch {
				return true;
			}
		}

		async function runTimedOut(
			name: string,
			body: string,
		): Promise<{ error: string | undefined; live: boolean }> {
			const pidFile = path.join(tmpDir, `${name}.pid`);
			const worker = writeWorker(
				`${name}.mjs`,
				`import { writeFileSync } from "node:fs";\n${body.replaceAll("PIDFILE", JSON.stringify(pidFile))}`,
			);
			const outcome = await analyzeFileFresh(
				worker,
				"/x/app.ts",
				"/x",
				{},
				2_000,
			);
			const pid = Number(fs.readFileSync(pidFile, "utf8"));
			// No cleanup kill here: a worker left alive expires on its own.
			return { error: outcome.error, live: isLive(pid) };
		}

		// The process holds the worker's stdout open, so the call settles only
		// once it is gone or the seam's pipe-idle cap passes: no wait on a timer.
		it("ends a process the worker started", async () => {
			const { error, live } = await runTimedOut(
				"grandchild",
				[
					'import { spawn } from "node:child_process";',
					'const child = spawn("sleep", ["20"], { stdio: ["ignore", "inherit", "inherit"] });',
					"writeFileSync(PIDFILE, String(child.pid));",
					"setInterval(() => {}, 1000);",
				].join("\n"),
			);
			expect(error).toBe("fresh analyze timed out after 2000ms");
			expect(live).toBe(false);
		}, 20_000);

		it("ends a worker that ignores SIGTERM", async () => {
			const { error, live } = await runTimedOut(
				"deaf",
				[
					'process.on("SIGTERM", () => {});',
					"writeFileSync(PIDFILE, String(process.pid));",
					"setTimeout(() => process.exit(0), 20_000);",
				].join("\n"),
			);
			expect(error).toBe("fresh analyze timed out after 2000ms");
			expect(live).toBe(false);
		}, 20_000);
	});

	// Recurrence: #3383 (a worker that writes without end must not reach the
	// host's string limit). The seam now owns the cap; this keeps the verdict
	// and the ledger row the old off-seam test pinned, over a real writer.
	it("bounds a worker that writes without end and records the trip", async () => {
		resetDegradationLedger();
		const worker = writeWorker(
			"endless.mjs",
			[
				'const chunk = "x".repeat(1024 * 1024);',
				"let written = 0;",
				"const pump = () => {",
				"\twhile (written < 80) {",
				"\t\twritten += 1;",
				"\t\tif (!process.stdout.write(chunk)) {",
				'\t\t\tprocess.stdout.once("drain", pump);',
				"\t\t\treturn;",
				"\t\t}",
				"\t}",
				"};",
				"pump();",
				"setInterval(() => {}, 1000);",
			].join("\n"),
		);
		const outcome = await analyzeFileFresh(worker, "/x/app.ts", "/x");
		expect(outcome.result).toBeUndefined();
		expect(outcome.error).toBe(
			`worker output exceeded ${DEFAULT_MAX_OUTPUT_BYTES} bytes`,
		);
		const row = getDegradationSummary().find(
			(entry) => entry.kind === "spawn-output-cap-truncated",
		);
		expect(row?.latestReasons[0]?.subject).toBe("mcp-fresh-analyze");
		expect(row?.latestReasons[0]?.reason).toContain("terminated");
	});

	// Recurrence: the seam's default is to cancel a spawn with the agent turn's
	// Esc; this call never was cancellable, and `ignoreAmbientSignal` keeps it so.
	it("finishes a worker while the agent turn's signal is aborted", async () => {
		const worker = writeWorker("slow-ok.mjs", `process.stdout.write("{}");`);
		const turn = new AbortController();
		turn.abort();
		const outcome = await spawnAbortScope.run(turn.signal, () =>
			analyzeFileFresh(worker, "/x/app.ts", "/x"),
		);
		expect(outcome.error).toBeUndefined();
		expect(outcome.result).toEqual({});
	});

	it("reports a worker that dies on a signal", async () => {
		const worker = writeWorker(
			"killed.mjs",
			'process.kill(process.pid, "SIGKILL");',
		);
		const outcome = await analyzeFileFresh(worker, "/x/app.ts", "/x");
		expect(outcome.result).toBeUndefined();
		expect(outcome.error).toContain("worker exited null");
	});

	it("reports an interpreter that cannot start", async () => {
		const execPath = process.execPath;
		process.execPath = path.join(tmpDir, "no-such-node");
		try {
			const outcome = await analyzeFileFresh("/w/worker.js", "/x/app.ts", "/x");
			expect(outcome.result).toBeUndefined();
			expect(outcome.error).toContain("failed to fork worker: ");
			expect(outcome.error).toContain("no-such-node");
		} finally {
			process.execPath = execPath;
		}
	});
});
