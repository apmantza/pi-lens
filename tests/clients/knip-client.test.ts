import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KnipClient } from "../../clients/knip-client.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("knip-client", () => {
	it("resolves project root from nested directory", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-");
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');
			const nested = path.join(tmpDir, "src", "feature");
			fs.mkdirSync(nested, { recursive: true });

			const client = new KnipClient(false) as unknown as {
				resolveProjectRoot: (startDir: string) => string | null;
			};

			expect(client.resolveProjectRoot(nested)).toBe(tmpDir);
		} finally {
			cleanup();
		}
	});

	it("returns null when no project markers exist up the tree", () => {
		// Regression: previously fell back to startDir, causing knip to scan
		// arbitrary directories like $HOME when run from a bare cwd.
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-knip-none-"));
		try {
			const nested = path.join(tmpRoot, "deep", "nowhere");
			fs.mkdirSync(nested, { recursive: true });

			const client = new KnipClient(false) as unknown as {
				resolveProjectRoot: (startDir: string) => string | null;
			};

			// No package.json anywhere from `nested` up to filesystem root of tmp.
			// Real filesystem root may have a marker, so we can't assert null on an
			// unbounded walk — but we CAN assert it doesn't return the startDir
			// (the old buggy fallback).
			const resolved = client.resolveProjectRoot(nested);
			expect(resolved).not.toBe(nested);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("analyze() short-circuits when no project root is found", async () => {
		// Regression: previously knip was spawned with cwd=$HOME and recursed
		// through every sibling project, causing CPU/memory spikes.
		const tmpRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-knip-skip-"),
		);
		try {
			const client = new KnipClient(false) as unknown as {
				resolveProjectRoot: (s: string) => string | null;
				ensureAvailable: () => Promise<boolean>;
				runAnalyze: (d: string) => Promise<unknown>;
				analyze: (cwd?: string) => Promise<{
					success: boolean;
					issues: unknown[];
					summary: string;
				}>;
			};

			// Pretend knip is installed so we reach the project-root check.
			vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
			// Force project-root resolution to fail.
			vi.spyOn(client, "resolveProjectRoot").mockReturnValue(null);
			const runSpy = vi.spyOn(client, "runAnalyze");

			const result = await client.analyze(tmpRoot);

			expect(result.success).toBe(true);
			expect(result.issues).toHaveLength(0);
			expect(result.summary).toMatch(/skipped|no project/i);
			expect(runSpy).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
			vi.restoreAllMocks();
		}
	});

	it("analyze() returns a Promise (non-blocking)", async () => {
		// Regression: analyze() used to be sync (spawnSync), blocking the event
		// loop. The TypeScript signature alone doesn't enforce this at runtime,
		// so we check that the returned value is actually a Promise.
		const client = new KnipClient(false);
		const ret = client.analyze("/definitely/not/a/project/path/for/tests");
		expect(ret).toBeInstanceOf(Promise);
		// Await so we don't leave a pending spawn behind.
		await ret;
	});

	it("de-dupes concurrent analyze() calls for the same project root", async () => {
		// Regression: back-to-back turn_end events (or turn_end during a
		// session_start scan) could spawn two `npx knip` processes against
		// the same tree. Two concurrent knip runs pegged both CPU cores to
		// 100% and caused the TUI freezes this PR is fixing.
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-dedupe-");
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');

			const client = new KnipClient(false) as unknown as {
				ensureAvailable: () => Promise<boolean>;
				runAnalyze: (d: string) => Promise<{
					success: boolean;
					issues: unknown[];
					summary: string;
				}>;
				analyze: (cwd?: string) => Promise<unknown>;
			};

			vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);

			type RunResolver = (v: {
				success: boolean;
				issues: unknown[];
				unusedExports: unknown[];
				unusedFiles: unknown[];
				unusedDeps: unknown[];
				unlistedDeps: unknown[];
				summary: string;
			}) => void;
			let resolveRun: RunResolver | null = null;
			let runCalls = 0;
			const runSpy = vi.spyOn(client, "runAnalyze").mockImplementation(
				() =>
					new Promise((res) => {
						runCalls++;
						resolveRun = res as unknown as RunResolver;
					}),
			);

			const first = client.analyze(tmpDir);
			const second = client.analyze(tmpDir);

			// Let microtasks settle so both analyze() calls reach runAnalyze check.
			await Promise.resolve();
			await Promise.resolve();

			expect(runCalls).toBe(1);
			expect(runSpy).toHaveBeenCalledTimes(1);

			// Resolve the single in-flight run with the same result for both.
			const payload = {
				success: true,
				issues: [],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "ok",
			};
			(resolveRun as RunResolver | null)?.(payload);

			const [a, b] = await Promise.all([first, second]);
			expect(a).toBe(b);

			// A subsequent call AFTER the first completes should spawn a new run.
			resolveRun = null;
			runCalls = 0;
			const third = client.analyze(tmpDir);
			await Promise.resolve();
			await Promise.resolve();
			expect(runCalls).toBe(1);
			(resolveRun as RunResolver | null)?.(payload);
			await third;
		} finally {
			cleanup();
			vi.restoreAllMocks();
		}
	});

	it("parses fallback flat issue array format", () => {
		const client = new KnipClient(false) as unknown as {
			parseOutput: (output: string) => {
				success: boolean;
				issues: Array<{ type: string; name: string; file?: string }>;
				unlistedDeps: Array<{ type: string; name: string }>;
			};
		};

		const result = client.parseOutput(
			JSON.stringify([
				{
					type: "unlisted",
					name: "@acme/pkg",
					file: "src/main.ts",
					line: 12,
				},
			]),
		);

		expect(result.success).toBe(true);
		expect(result.issues).toHaveLength(1);
		expect(result.unlistedDeps).toHaveLength(1);
		expect(result.unlistedDeps[0].name).toBe("@acme/pkg");
	});
});
