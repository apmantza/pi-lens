/**
 * A nested checkout's failed test must not monopolise the parent's failed-first
 * selection after an unrelated edit. Drive real execution/result recording and
 * selection; fake only the external runner and global binary lookup.
 */
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// The latency writer captures its path at import time, including through
// transitive imports. A per-case PI_LENS_HOME cannot isolate its clears.
const logHome = await vi.hoisted(async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const home = mkdtempSync(join(tmpdir(), "pi-lens-checkout-isolation-log-"));
	vi.stubEnv("PI_LENS_HOME", home);
	return home;
});

import { CacheManager } from "../../clients/cache-manager.js";
import { DependencyChecker } from "../../clients/dependency-checker.js";
import { KnipClient } from "../../clients/knip-client.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import type {
	SafeSpawnOptions,
	SpawnResult,
} from "../../clients/safe-spawn.js";

const { safeSpawnAsync, findGlobalBinary } = vi.hoisted(() => ({
	safeSpawnAsync:
		vi.fn<
			(
				command: string,
				args: string[],
				options?: SafeSpawnOptions,
			) => Promise<SpawnResult>
		>(),
	findGlobalBinary: vi.fn(async () => undefined),
}));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal()),
	safeSpawnAsync,
}));
vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal()),
	findGlobalBinary,
}));

import { resetBoundedTelemetry } from "../../clients/bounded-telemetry.js";
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import {
	RUNNERS,
	TestRunnerClient,
	isExcludedTestTarget,
} from "../../clients/test-runner-client.js";
import { removeTempDirSync } from "./test-utils.js";

let root: string;
beforeEach(async () => {
	root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-test-checkout-isolation-"),
	);
	// Isolate per-case machine state; the log sink already belongs to logHome.
	vi.stubEnv("PI_LENS_HOME", path.join(root, "machine"));
	vi.stubEnv("PI_LENS_TEST_MODE", "0");
	vi.stubEnv("VIRTUAL_ENV", "");
	vi.stubEnv("CONDA_PREFIX", "");
	vi.stubEnv("UV_PROJECT_ENVIRONMENT", "");
	safeSpawnAsync.mockReset();
	findGlobalBinary.mockClear();
	resetBoundedTelemetry();
	resetDegradationLedger();
	clearLatencyLog();
	await flushLatencyLog();
});
afterEach(async () => {
	await flushLatencyLog();
	resetBoundedTelemetry();
	resetDegradationLedger();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	removeTempDirSync(root);
});
afterAll(async () => {
	await flushLatencyLog();
	removeTempDirSync(logHome);
});

it("keeps the captured latency sink private after per-case home changes", () => {
	// #3644: a late home pin let beforeEach erase opaque-mutation's record.
	expect(getLatencyLogPath()).toBe(path.join(logHome, "latency.log"));
});

function write(directory: string, relative: string, text = "\n"): string {
	const file = path.join(directory, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

function markCheckout(directory: string, shape: "file" | "directory"): void {
	if (shape === "directory") {
		write(directory, ".git/HEAD", "ref: refs/heads/main\n");
	} else {
		// The marker is filesystem evidence only; no Git process follows it.
		const gitDir = path.join(root, "git-metadata", "topic");
		write(gitDir, "HEAD", "ref: refs/heads/topic\n");
		write(directory, ".git", `gitdir: ${gitDir}\n`);
	}
}

function linkTest(
	target: string,
	alias: string,
	shape: "file" | "directory",
): string {
	fs.mkdirSync(path.dirname(alias), { recursive: true });
	if (shape === "file") {
		fs.symlinkSync(target, alias, "file");
		return alias;
	}
	fs.symlinkSync(
		path.dirname(target),
		alias,
		process.platform === "win32" ? "junction" : "dir",
	);
	return path.join(alias, path.basename(target));
}

/** R3: fault actual marker I/O, not the ownership predicate or store. */
function denyMarkerOnce(
	directory: string,
	component: "marker-stat" | "head-stat" | "marker-read",
	skip: number,
): () => void {
	const marker = path.join(directory, ".git");
	const denied = component === "head-stat" ? path.join(marker, "HEAD") : marker;
	const error = () =>
		Object.assign(new Error("marker access denied"), { code: "EACCES" });
	const restorers: Array<() => void> = [];
	let visits = 0;
	if (component === "marker-read") {
		const read = fs.readFileSync;
		const spy = vi
			.spyOn(fs, "readFileSync")
			.mockImplementation((file, options) => {
				if (String(file) === denied && visits++ === skip) throw error();
				return read(file, options);
			});
		restorers.push(() => spy.mockRestore());
	} else {
		const stat = fs.statSync;
		const spy = vi.spyOn(fs, "statSync").mockImplementation((file, options) => {
			if (String(file) === denied && visits++ === skip) throw error();
			return stat(file, options);
		});
		restorers.push(() => spy.mockRestore());
		if (component === "head-stat") {
			// The old HEAD existsSync hides the same EACCES as false. Model both
			// APIs' real error semantics so the pre-fix test exercises the fault too.
			const exists = fs.existsSync;
			let existsVisits = 0;
			const existsSpy = vi
				.spyOn(fs, "existsSync")
				.mockImplementation((file) => {
					if (String(file) === denied && existsVisits++ === skip) return false;
					return exists(file);
				});
			restorers.push(() => existsSpy.mockRestore());
		}
	}
	syncBuiltinESMExports();
	return () => {
		for (const restore of restorers) restore();
		syncBuiltinESMExports();
	};
}

const runners = [
	{
		runner: "pytest",
		config: "pytest.ini",
		content: "[pytest]\n",
		source: "widget.py",
		test: "tests/test_widget.py",
		failed: "test_broken.py",
		output: "1 failed in 0.01s\n",
	},
	{
		runner: "go",
		config: "go.mod",
		content: "module example.com/fixture\n",
		source: "widget.go",
		test: "widget_test.go",
		failed: "broken_test.go",
		output: "--- FAIL: TestBroken\n",
	},
] as const;

for (const row of runners) {
	function fixture() {
		const project = path.join(root, "main");
		// Not a .worktrees naming heuristic: any real nested checkout is foreign.
		const nested = path.join(project, "checkouts", "topic");
		markCheckout(project, "directory");
		for (const directory of [project, nested])
			write(directory, row.config, row.content);
		const source = write(project, row.source);
		const companion = write(project, row.test);
		const parentFailure = write(project, row.failed);
		const nestedSource = write(nested, row.source);
		const foreignFailure = write(nested, row.failed);
		safeSpawnAsync.mockResolvedValue({
			stdout: row.output,
			stderr: "",
			status: 1,
		});
		return {
			project,
			nested,
			source,
			companion,
			parentFailure,
			nestedSource,
			foreignFailure,
		};
	}

	describe(`${row.runner} failed-first checkout ownership`, () => {
		for (const shape of ["file", "directory"] as const) {
			it(`rejects a nested .git ${shape} at admission without losing the explicit result`, async () => {
				const f = fixture();
				markCheckout(f.nested, shape);
				const client = new TestRunnerClient(false);
				for (let attempt = 0; attempt < 2; attempt++) {
					const result = await client.runTestFileAsync(
						f.foreignFailure,
						f.project,
						row.runner,
						RUNNERS[row.runner],
					);
					expect(result.failed).toBe(1);
				}
				// Remove the boundary before selection: this distinguishes rejecting
				// insertion from merely concealing an entry at the later spawn gate.
				fs.rmSync(path.join(f.nested, ".git"), { recursive: true });
				expect(client.getTestRunTarget(f.source, f.project)).toMatchObject({
					testFile: f.companion,
					strategy: "related",
				});
				await flushLatencyLog();
				const log = fs.readFileSync(getLatencyLogPath(), "utf8");
				expect(log.match(/"outcome":"rejected-nested-checkout"/g)).toHaveLength(
					1,
				);
				expect(log).toContain('"phase":"test_runner_failed_target_state"');
			});

			it(`retires cached failures after a .git ${shape} appears, without starving parent failures`, async () => {
				const f = fixture();
				const client = new TestRunnerClient(false);
				// Populate via real runner results before the nested checkout exists.
				for (const target of [f.foreignFailure, f.parentFailure]) {
					expect(
						(
							await client.runTestFileAsync(
								target,
								f.project,
								row.runner,
								RUNNERS[row.runner],
							)
						).failed,
					).toBe(1);
				}
				expect(client.getTestRunTarget(f.source, f.project)?.testFile).toBe(
					f.foreignFailure,
				);
				markCheckout(f.nested, shape);
				expect(client.getTestRunTarget(f.source, f.project)).toMatchObject({
					testFile: f.parentFailure,
					strategy: "failed-first",
				});
				fs.rmSync(path.join(f.nested, ".git"), { recursive: true });
				expect(client.getTestRunTarget(f.source, f.project)?.testFile).toBe(
					f.parentFailure,
				);
				await flushLatencyLog();
				const log = fs.readFileSync(getLatencyLogPath(), "utf8");
				expect(log.match(/"outcome":"retired-nested-checkout"/g)).toHaveLength(
					1,
				);
				expect(log).toContain('"phase":"test_runner_failed_target_state"');
			});
		}

		it("retires a deleted failed-first target as retired-missing without an identity record", async () => {
			// Recurrence (#3691 F1): an ordinary deletion recorded
			// test-checkout-identity-unavailable through foreignGitRoot's realpath
			// catch, on top of the retired-missing outcome that already owns it.
			const f = fixture();
			const client = new TestRunnerClient(false);
			await client.runTestFileAsync(
				f.parentFailure,
				f.project,
				row.runner,
				RUNNERS[row.runner],
			);
			fs.rmSync(f.parentFailure);
			expect(client.getTestRunTarget(f.source, f.project)).toMatchObject({
				testFile: f.companion,
				strategy: "related",
			});
			await flushLatencyLog();
			const log = fs.readFileSync(getLatencyLogPath(), "utf8");
			expect(log).toContain('"outcome":"retired-missing"');
			expect(log).not.toContain('"kind":"test-checkout-identity-unavailable"');
		});

		it.each(["ENOENT", "ENOTDIR"] as const)(
			"keeps a real identity failure visible after many ordinary %s lookups",
			async (code) => {
				// Recurrence (#3691 F1): 20 ordinary rows filled the per-kind cap, so the
				// next EACCES was counted but never reached the durable log.
				const f = fixture();
				for (let index = 0; index < 25; index++) {
					// A missing leaf gives ENOENT; a path below a regular file, ENOTDIR.
					const candidate =
						code === "ENOENT"
							? path.join(f.project, `gone-${index}-${row.failed}`)
							: path.join(f.source, `below-${index}-${row.failed}`);
					expect(isExcludedTestTarget(candidate, f.project)).toBe(false);
				}
				const native = vi.spyOn(fs.realpathSync, "native");
				native.mockImplementationOnce(() => {
					throw Object.assign(new Error("ownership lookup denied"), {
						code: "EACCES",
					});
				});
				try {
					expect(isExcludedTestTarget(f.parentFailure, f.project)).toBe(false);
				} finally {
					native.mockRestore();
				}
				await flushLatencyLog();
				const log = fs.readFileSync(getLatencyLogPath(), "utf8");
				expect(
					log.match(/"kind":"test-checkout-identity-unavailable"/g),
				).toHaveLength(1);
				expect(log).toContain('"errorCode":"EACCES"');
			},
		);

		it("keeps a nested checkout's own failures eligible and rejects only the parent's copy", async () => {
			const f = fixture();
			markCheckout(f.nested, "file");
			const client = new TestRunnerClient(false);
			for (const dispatch of [f.nested, f.project]) {
				await client.runTestFileAsync(
					f.foreignFailure,
					dispatch,
					row.runner,
					RUNNERS[row.runner],
				);
			}
			expect(client.getTestRunTarget(f.nestedSource, f.nested)).toMatchObject({
				testFile: f.foreignFailure,
				strategy: "failed-first",
			});
			expect(client.getTestRunTarget(f.source, f.project)).toMatchObject({
				testFile: f.companion,
				strategy: "related",
			});
			expect(isExcludedTestTarget(f.foreignFailure, f.nested)).toBe(false);
			expect(isExcludedTestTarget(f.foreignFailure, f.project)).toBe(true);
		});

		it.each(["absent", "invalid-file", "invalid-directory"] as const)(
			"keeps a nested package eligible with an %s Git marker",
			async (marker) => {
				const f = fixture();
				if (marker === "invalid-file")
					write(f.nested, ".git", "not Git metadata\n");
				if (marker === "invalid-directory")
					fs.mkdirSync(path.join(f.nested, ".git"));
				const client = new TestRunnerClient(false);
				await client.runTestFileAsync(
					f.foreignFailure,
					f.project,
					row.runner,
					RUNNERS[row.runner],
				);
				expect(client.getTestRunTarget(f.source, f.project)).toMatchObject({
					testFile: f.foreignFailure,
					strategy: "failed-first",
				});
				expect(isExcludedTestTarget(f.foreignFailure, f.project)).toBe(false);
			},
		);

		it("recognises the checkout itself through a symlinked dispatch root", async () => {
			const f = fixture();
			markCheckout(f.nested, "file");
			const alias = path.join(root, "topic-alias");
			fs.symlinkSync(
				f.nested,
				alias,
				process.platform === "win32" ? "junction" : "dir",
			);
			const client = new TestRunnerClient(false);
			await client.runTestFileAsync(
				f.foreignFailure,
				alias,
				row.runner,
				RUNNERS[row.runner],
			);
			expect(client.getTestRunTarget(f.nestedSource, alias)).toMatchObject({
				testFile: f.foreignFailure,
				strategy: "failed-first",
			});
			expect(isExcludedTestTarget(path.join(alias, row.failed), alias)).toBe(
				false,
			);
		});

		for (const shape of ["file", "directory"] as const) {
			it(`rejects a ${shape} alias below a foreign Git root before cache admission`, async () => {
				// R1: lexical parents of the alias hide the target's .git ancestor.
				const f = fixture();
				markCheckout(f.nested, "file");
				const foreign = write(f.nested, `suite/${row.failed}`);
				const alias = linkTest(
					foreign,
					path.join(
						f.project,
						"borrowed",
						...(shape === "file" ? [row.failed] : []),
					),
					shape,
				);
				const client = new TestRunnerClient(false);
				expect(
					(
						await client.runTestFileAsync(
							alias,
							f.project,
							row.runner,
							RUNNERS[row.runner],
						)
					).failed,
				).toBe(1);
				expect(isExcludedTestTarget(alias, f.project)).toBe(true);
				// Prove admission, not just concealment by the reader or spawn gate.
				fs.rmSync(path.join(f.nested, ".git"));
				expect(client.getTestRunTarget(f.source, f.project)).toMatchObject({
					testFile: f.companion,
					strategy: "related",
				});
				await flushLatencyLog();
				expect(fs.readFileSync(getLatencyLogPath(), "utf8")).toContain(
					'"outcome":"rejected-nested-checkout"',
				);
			});

			it(`retires a cached ${shape} alias when a Git boundary appears behind it`, async () => {
				const f = fixture();
				const foreign = write(f.nested, `suite/${row.failed}`);
				const alias = linkTest(
					foreign,
					path.join(
						f.project,
						"borrowed",
						...(shape === "file" ? [row.failed] : []),
					),
					shape,
				);
				const client = new TestRunnerClient(false);
				for (const target of [alias, f.parentFailure]) {
					await client.runTestFileAsync(
						target,
						f.project,
						row.runner,
						RUNNERS[row.runner],
					);
				}
				expect(client.getTestRunTarget(f.source, f.project)?.testFile).toBe(
					alias,
				);
				markCheckout(f.nested, "directory");
				expect(client.getTestRunTarget(f.source, f.project)?.testFile).toBe(
					f.parentFailure,
				);
				fs.rmSync(path.join(f.nested, ".git"), { recursive: true });
				expect(client.getTestRunTarget(f.source, f.project)?.testFile).toBe(
					f.parentFailure,
				);
				await flushLatencyLog();
				expect(fs.readFileSync(getLatencyLogPath(), "utf8")).toContain(
					'"outcome":"retired-nested-checkout"',
				);
			});
		}

		it.each(["sibling", "enclosing"] as const)(
			"rejects an alias into the %s checkout rather than relying on root containment",
			async (position) => {
				const f = fixture();
				markCheckout(f.nested, "file");
				const dispatch = position === "enclosing" ? f.nested : f.project;
				const owner =
					position === "enclosing" ? f.project : path.join(root, "sibling");
				if (position === "sibling") markCheckout(owner, "directory");
				const source = write(dispatch, row.source);
				const companion = write(dispatch, row.test);
				const foreign = write(owner, `suite/${row.failed}`);
				const alias = linkTest(
					foreign,
					path.join(dispatch, "borrowed", row.failed),
					"file",
				);
				const client = new TestRunnerClient(false);
				expect(isExcludedTestTarget(alias, dispatch)).toBe(true);
				expect(
					(
						await client.runTestFileAsync(
							alias,
							dispatch,
							row.runner,
							RUNNERS[row.runner],
						)
					).failed,
				).toBe(1);
				fs.rmSync(path.join(owner, ".git"), { recursive: true });
				expect(client.getTestRunTarget(source, dispatch)).toMatchObject({
					testFile: companion,
					strategy: "related",
				});
			},
		);

		it("keeps real and aliased spellings of its own package below a Git root eligible", async () => {
			const f = fixture();
			const dispatch = path.join(f.project, "packages", "worker");
			write(dispatch, row.config, row.content);
			const source = write(dispatch, row.source);
			const failure = write(dispatch, row.failed);
			const alias = path.join(root, "worker-alias");
			fs.symlinkSync(
				dispatch,
				alias,
				process.platform === "win32" ? "junction" : "dir",
			);
			const client = new TestRunnerClient(false);
			await client.runTestFileAsync(
				failure,
				alias,
				row.runner,
				RUNNERS[row.runner],
			);
			expect(client.getTestRunTarget(source, alias)).toMatchObject({
				testFile: failure,
				strategy: "failed-first",
			});
			expect(isExcludedTestTarget(failure, alias)).toBe(false);
			expect(isExcludedTestTarget(path.join(alias, row.failed), dispatch)).toBe(
				false,
			);
		});

		for (const component of [
			"marker-stat",
			"head-stat",
			"marker-read",
		] as const) {
			for (const [side, skip] of [
				["target-root", 0],
				["dispatch-root", 1],
			] as const) {
				it(`keeps own failures after ${side} ${component} uncertainty and records it once`, async () => {
					// R3: two successful realpaths do not prove either ownership walk.
					const f = fixture();
					markCheckout(
						f.nested,
						component === "marker-read" ? "file" : "directory",
					);
					const client = new TestRunnerClient(false);
					await client.runTestFileAsync(
						f.foreignFailure,
						f.nested,
						row.runner,
						RUNNERS[row.runner],
					);
					for (let attempt = 0; attempt < 2; attempt++) {
						const restore = denyMarkerOnce(f.nested, component, skip);
						try {
							client.getTestRunTarget(f.foreignFailure, f.nested);
						} finally {
							restore();
						}
						// Observe the retained cache through an unrelated edit after recovery,
						// rather than the self fallback concealing an erroneous retirement.
						expect(
							client.getTestRunTarget(f.nestedSource, f.nested),
						).toMatchObject({
							testFile: f.foreignFailure,
							strategy: "failed-first",
						});
					}
					await flushLatencyLog();
					const log = fs.readFileSync(getLatencyLogPath(), "utf8");
					expect(log).not.toContain('"outcome":"retired-nested-checkout"');
					expect(
						log.match(/"kind":"test-checkout-identity-unavailable"/g),
					).toHaveLength(1);
					expect(log).toContain(`"lookup":"${side}"`);
					expect(log).toContain('"detail":"marker-error"');
					expect(log).toContain('"errorCode":"EACCES"');
					expect(log).toContain(
						`"markerPath":${JSON.stringify(path.join(f.nested, ".git"))}`,
					);
				});

				it(`does not exclude its own test on ${side} ${component} uncertainty`, () => {
					const f = fixture();
					markCheckout(
						f.nested,
						component === "marker-read" ? "file" : "directory",
					);
					const restore = denyMarkerOnce(f.nested, component, skip);
					try {
						expect(isExcludedTestTarget(f.foreignFailure, f.nested)).toBe(
							false,
						);
					} finally {
						restore();
					}
				});
			}
		}

		it("admits an own failed result when marker evidence becomes unreadable after execution", async () => {
			const f = fixture();
			markCheckout(f.nested, "directory");
			const client = new TestRunnerClient(false);
			let restore = () => {};
			safeSpawnAsync.mockImplementationOnce(async () => {
				// Install after the process boundary, so the fault reaches admission,
				// not a tool-cwd lookup while preparing the explicitly requested run.
				restore = denyMarkerOnce(f.nested, "marker-stat", 0);
				return { stdout: row.output, stderr: "", status: 1 };
			});
			try {
				expect(
					(
						await client.runTestFileAsync(
							f.foreignFailure,
							f.nested,
							row.runner,
							RUNNERS[row.runner],
						)
					).failed,
				).toBe(1);
			} finally {
				restore();
			}
			expect(client.getTestRunTarget(f.nestedSource, f.nested)).toMatchObject({
				testFile: f.foreignFailure,
				strategy: "failed-first",
			});
		});

		it("keeps the own companion and records uncertainty rather than a foreign discovery verdict", async () => {
			const f = fixture();
			markCheckout(f.nested, "directory");
			const companion = write(f.nested, row.test);
			const client = new TestRunnerClient(false);
			client.detectRunner(f.nested, f.nestedSource);
			const restore = denyMarkerOnce(f.nested, "marker-stat", 0);
			try {
				expect(client.getTestRunTarget(f.nestedSource, f.nested)).toMatchObject(
					{ testFile: companion, strategy: "related" },
				);
			} finally {
				restore();
			}
			// Python can rediscover the same candidate through another pattern after
			// a transient false rejection; the returned file alone concealed that bug.
			await flushLatencyLog();
			const log = fs.readFileSync(getLatencyLogPath(), "utf8");
			expect(log).not.toContain('"kind":"test-discovery-foreign-checkout"');
			expect(log).toContain('"kind":"test-checkout-identity-unavailable"');
			expect(log).toContain('"lookup":"target-root"');
			expect(log).toContain('"detail":"marker-error"');
		});

		it("records a bounded target walk without collapsing distinct long-prefix candidates", async () => {
			// R5: a capped target walk used to be indistinguishable from Gitless absence.
			const f = fixture();
			const directory = path.join(f.project, ...Array<string>(65).fill("d"));
			const targets = [
				write(directory, row.failed),
				write(directory, `other-${row.failed}`),
			];
			const cwd = f.project + `${path.sep}.`.repeat(120);
			for (let attempt = 0; attempt < 2; attempt++) {
				for (const candidate of targets)
					expect(isExcludedTestTarget(candidate, cwd)).toBe(false);
			}
			await flushLatencyLog();
			const log = fs.existsSync(getLatencyLogPath())
				? fs.readFileSync(getLatencyLogPath(), "utf8")
				: "";
			expect(
				log.match(/"kind":"test-checkout-identity-unavailable"/g) ?? [],
			).toHaveLength(2);
			expect(log).toContain('"lookup":"target-root"');
			expect(log).toContain('"detail":"depth-limit"');
			expect(log).not.toContain('"errorCode"');
		});

		it("does not record ordinary Gitless absence as a capped or unreadable walk", async () => {
			const f = fixture();
			fs.rmSync(path.join(f.project, ".git"), { recursive: true });
			expect(isExcludedTestTarget(f.parentFailure, f.project)).toBe(false);
			await flushLatencyLog();
			const log = fs.existsSync(getLatencyLogPath())
				? fs.readFileSync(getLatencyLogPath(), "utf8")
				: "";
			expect(log).not.toContain('"kind":"test-checkout-identity-unavailable"');
		});

		it.each(["EACCES", undefined])(
			"preserves a filesystem lookup record with code %s without changing eligibility",
			async (code) => {
				// refs #3644: the metadata type must admit an unknown error code
				// without adding an errorCode field to ordinary bounded walk misses.
				const f = fixture();
				const native = vi.spyOn(fs.realpathSync, "native");
				native.mockImplementationOnce(() => {
					throw Object.assign(new Error("ownership lookup denied"), { code });
				});
				try {
					expect(isExcludedTestTarget(f.parentFailure, f.project)).toBe(false);
				} finally {
					native.mockRestore();
				}
				await flushLatencyLog();
				const log = fs.readFileSync(getLatencyLogPath(), "utf8");
				expect(log).toContain('"kind":"test-checkout-identity-unavailable"');
				expect(log).toContain('"lookup":"filesystem"');
				expect(log).toContain('"detail":"realpath"');
				expect(log).toContain(`"errorCode":"${code ?? "unknown"}"`);
			},
		);

		it.each(["cwd", "target"] as const)(
			"does not invent foreign ownership when %s identity is unavailable and records the gap once",
			async (role) => {
				const f = fixture();
				markCheckout(f.nested, "file");
				// Long spellings must not merge distinct failures when the ledger clips
				// its subject. Dot components avoid requiring long physical directories.
				const cwd = f.project + `${path.sep}.`.repeat(120);
				// A real filesystem boundary failure, not an in-process policy double.
				const realpathNative = fs.realpathSync.native;
				const native = vi.spyOn(fs.realpathSync, "native");
				for (let attempt = 0; attempt < 2; attempt++) {
					for (const candidate of [f.foreignFailure, f.parentFailure]) {
						if (role === "target")
							native.mockImplementationOnce((input) => realpathNative(input));
						native.mockImplementationOnce(() => {
							throw Object.assign(new Error("ownership lookup denied"), {
								code: "EACCES",
							});
						});
						let excluded: boolean | undefined;
						expect(() => {
							excluded = isExcludedTestTarget(candidate, cwd);
						}).not.toThrow();
						expect(excluded).toBe(false);
					}
				}
				native.mockRestore();
				await flushLatencyLog();
				const log = fs.readFileSync(getLatencyLogPath(), "utf8");
				expect(
					log.match(/"kind":"test-checkout-identity-unavailable"/g),
				).toHaveLength(2);
				expect(log).toContain('"lookup":"filesystem"');
				expect(log).toContain('"detail":"realpath"');
				expect(log).toContain('"errorCode":"EACCES"');
			},
		);

		it("retains eligibility when the dispatch marker walk cannot prove ownership beneath the target's ancestor", async () => {
			const f = fixture();
			// The real walk is capped at 64 climbs. A shallow, own-checkout test
			// remains valid when reached from a package below that walk's horizon.
			const dispatch = path.join(f.project, ...Array<string>(65).fill("d"));
			fs.mkdirSync(dispatch, { recursive: true });
			const alias = linkTest(
				f.parentFailure,
				path.join(dispatch, row.failed),
				"file",
			);
			const second = linkTest(
				write(f.project, `second-${row.failed}`),
				path.join(dispatch, `second-${row.failed}`),
				"file",
			);
			for (let attempt = 0; attempt < 2; attempt++) {
				for (const candidate of [alias, second]) {
					expect(isExcludedTestTarget(candidate, dispatch)).toBe(false);
				}
			}
			await flushLatencyLog();
			expect(fs.existsSync(getLatencyLogPath())).toBe(true);
			const log = fs.readFileSync(getLatencyLogPath(), "utf8");
			expect(
				log.match(/"kind":"test-checkout-identity-unavailable"/g),
			).toHaveLength(2);
			expect(log).toContain('"lookup":"dispatch-root"');
			expect(log).not.toContain('"errorCode"');
		});

		it.each([
			["posix", path.posix],
			["win32", path.win32],
		] as const)(
			"preserves checkout ownership under %s relative-path semantics",
			(_name, pathApi) => {
				// Exercise both separator/dot-segment spellings on every host; the real
				// filesystem still supplies identity, rather than a fake normaliser.
				const f = fixture();
				markCheckout(f.nested, "file");
				const foreign = write(f.nested, `suite/${row.failed}`);
				linkTest(foreign, path.join(f.project, "borrowed"), "directory");
				write(f.project, `packages/worker/${row.failed}`);
				for (const relative of [
					pathApi.join("checkouts", "topic", row.failed),
					["checkouts", "unused", "..", "topic", row.failed].join(pathApi.sep),
					pathApi.join("borrowed", row.failed),
				]) {
					expect(isExcludedTestTarget(relative, f.project)).toBe(true);
				}
				expect(
					isExcludedTestTarget(
						pathApi.join("packages", "worker", row.failed),
						f.project,
					),
				).toBe(false);
			},
		);

		it("rejects a nested checkout beneath a dispatch directory without its own Git marker", async () => {
			const f = fixture();
			fs.rmSync(path.join(f.project, ".git"), { recursive: true });
			markCheckout(f.nested, "file");
			const client = new TestRunnerClient(false);
			expect(isExcludedTestTarget(f.foreignFailure, f.project)).toBe(true);
			await client.runTestFileAsync(
				f.foreignFailure,
				f.project,
				row.runner,
				RUNNERS[row.runner],
			);
			fs.rmSync(path.join(f.nested, ".git"));
			expect(client.getTestRunTarget(f.source, f.project)?.testFile).toBe(
				f.companion,
			);
		});

		it("a successful explicit run clears an aliased failure even across a temporary Git boundary", async () => {
			const f = fixture();
			const foreign = write(f.nested, `suite/${row.failed}`);
			const alias = linkTest(
				foreign,
				path.join(f.project, "borrowed", row.failed),
				"file",
			);
			const client = new TestRunnerClient(false);
			await client.runTestFileAsync(
				alias,
				f.project,
				row.runner,
				RUNNERS[row.runner],
			);
			markCheckout(f.nested, "file");
			safeSpawnAsync.mockResolvedValue({
				stdout:
					row.runner === "pytest"
						? "1 passed in 0.01s\n"
						: "ok example.com/fixture 0.01s\n",
				stderr: "",
				status: 0,
			});
			expect(
				(
					await client.runTestFileAsync(
						alias,
						f.project,
						row.runner,
						RUNNERS[row.runner],
					)
				).failed,
			).toBe(0);
			fs.rmSync(path.join(f.nested, ".git"));
			expect(client.getTestRunTarget(f.source, f.project)).toMatchObject({
				testFile: f.companion,
				strategy: "related",
			});
		});

		it("retires at most eight newly foreign entries per selection and falls back to the parent companion", async () => {
			const f = fixture();
			const client = new TestRunnerClient(false);
			for (let index = 0; index < 10; index++) {
				const target = write(f.nested, `${index}/${row.failed}`);
				await client.runTestFileAsync(
					target,
					f.project,
					row.runner,
					RUNNERS[row.runner],
				);
			}
			markCheckout(f.nested, "file");
			for (const [turn, expectedRetirements] of [
				[1, 8],
				[2, 10],
				[3, 10],
			]) {
				expect(
					client.getTestRunTarget(f.source, f.project, turn),
				).toMatchObject({ testFile: f.companion, strategy: "related" });
				await flushLatencyLog();
				const log = fs.readFileSync(getLatencyLogPath(), "utf8");
				expect(log.match(/"outcome":"retired-nested-checkout"/g)).toHaveLength(
					expectedRetirements,
				);
			}
			fs.rmSync(path.join(f.nested, ".git"));
			expect(client.getTestRunTarget(f.source, f.project)?.strategy).toBe(
				"related",
			);
		});
	});
}

describe("R4/R6 real turn-end policy after checkout selection", () => {
	for (const route of ["fresh", "deferred"] as const) {
		it.each([
			["unit.test.ts", true],
			["tests/integration/unit.test.ts", false],
			["tests/E2E/unit.test.ts", false],
			["unit.integration.test.ts", false],
			["unit.E2E.test.ts", false],
		] as const)(
			`${route} preserves alias policy for %s`,
			async (name, eligible) => {
				// R4: ../own/... is not a valid glob coordinate after physical containment.
				// An integration-named ancestor OUTSIDE dispatch must not exclude its unit.
				const project = path.join(root, "integration", "own");
				markCheckout(project, "directory");
				write(project, "vitest.config.ts", "export default {};\n");
				const alias = path.join(root, "alias");
				fs.symlinkSync(
					project,
					alias,
					process.platform === "win32" ? "junction" : "dir",
				);
				const target = write(project, name, "export {};\n");
				const source = write(alias, "widget.ts", "export {};\n");
				const runtime = new RuntimeCoordinator();
				const cacheManager = new CacheManager(false);
				const client = new TestRunnerClient(false);
				// #5270: vitest reports to the `--outputFile` the runner passes (a
				// stdout report is no longer read), as the real CLI does.
				safeSpawnAsync.mockImplementation(async (_command, args) => {
					const flag = (args as string[]).find((arg) =>
						arg.startsWith("--outputFile="),
					);
					fs.writeFileSync(
						flag!.slice("--outputFile=".length),
						JSON.stringify({
							numPassedTests: 0,
							numFailedTests: 1,
							testResults: [],
						}),
					);
					return { stdout: "", stderr: "", status: 1 };
				});
				if (route === "fresh") {
					expect(
						(
							await client.runTestFileAsync(
								target,
								alias,
								"vitest",
								RUNNERS.vitest,
							)
						).failed,
					).toBe(1);
					expect(client.getTestRunTarget(source, alias)).toMatchObject({
						testFile: target,
						strategy: "failed-first",
					});
				} else {
					// No failed-first duplicate: this witness must use the deferred gate.
					expect(client.getTestRunTarget(source, alias)).toBeNull();
					cacheManager.writeCache(
						"test-runner-findings",
						{
							content: "deferred",
							deferredTargets: [
								{
									testFile: target,
									sourceFile: source,
									runner: "vitest",
									attempts: 1,
									sessionId: runtime.telemetrySessionId,
								},
							],
						},
						alias,
					);
				}
				const executed: string[] = [];
				vi.spyOn(client, "runTestFileAsync").mockImplementation(
					async (file) => {
						executed.push(file);
						return {
							file,
							sourceFile: source,
							runner: "vitest",
							passed: 1,
							failed: 0,
							skipped: 0,
							failures: [],
						};
					},
				);
				cacheManager.addModifiedRange(
					source,
					{ start: 1, end: 1 },
					false,
					alias,
					runtime.telemetrySessionId,
				);
				await handleTurnEnd({
					ctxCwd: alias,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager,
					knipClient: new KnipClient(false),
					deadCodeClients: [],
					depChecker: new DependencyChecker(false),
					testRunnerClient: client,
					resetLSPService: () => {},
					resetFormatService: () => {},
				});
				expect(executed).toEqual(eligible ? [target] : []);
			},
		);

		it(`${route} records foreign final rejections with dbg disabled, without clipping identities`, async () => {
			// R6: self and deferred paths can bypass both discovery and cache records.
			const project = path.join(root, "own");
			markCheckout(project, "directory");
			write(project, "vitest.config.ts", "export default {};\n");
			const foreign = path.join(project, "other");
			markCheckout(foreign, "file");
			const targets = [
				write(foreign, "first.test.ts"),
				write(foreign, "second.test.ts"),
			];
			const cwd = project + `${path.sep}.`.repeat(120);
			const edited =
				route === "fresh"
					? targets
					: [write(project, "tick.ts", "export {};\n")];
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const client = new TestRunnerClient(false);
			const run = vi.spyOn(client, "runTestFileAsync");
			for (let attempt = 0; attempt < 2; attempt++) {
				if (route === "deferred") {
					cacheManager.writeCache(
						"test-runner-findings",
						{
							content: "deferred",
							deferredTargets: targets.map((testFile) => ({
								testFile,
								runner: "vitest",
								attempts: 1,
								sessionId: runtime.telemetrySessionId,
							})),
						},
						cwd,
					);
				}
				for (const target of edited)
					cacheManager.addModifiedRange(
						target,
						{ start: 1, end: 1 },
						false,
						cwd,
						runtime.telemetrySessionId,
					);
				await handleTurnEnd({
					ctxCwd: cwd,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager,
					knipClient: new KnipClient(false),
					deadCodeClients: [],
					depChecker: new DependencyChecker(false),
					testRunnerClient: client,
					resetLSPService: () => {},
					resetFormatService: () => {},
				});
			}
			expect(run).not.toHaveBeenCalled();
			await flushLatencyLog();
			const log = fs.existsSync(getLatencyLogPath())
				? fs.readFileSync(getLatencyLogPath(), "utf8")
				: "";
			const records = log
				.split("\n")
				.filter((line) =>
					line.includes('"kind":"test-target-foreign-checkout"'),
				);
			expect(records).toHaveLength(2);
			expect(records.join("\n")).toContain("first.test.ts");
			expect(records.join("\n")).toContain("second.test.ts");
		});
	}
});

it("keeps import discovery filename and eligibility checks ahead of file reads", () => {
	// refs #3644: combining the skip guards must not admit or read an earlier
	// non-test/rejected candidate, or return an eligible file without an import.
	const project = path.join(root, "main");
	const source = write(project, "widget.ts");
	const imported = 'import "../widget.js";\n';
	const note = write(project, "tests/notes.txt", imported);
	const rejected = write(project, "tests/rejected.test.ts", imported);
	const noImport = write(project, "tests/accepted.test.ts", "export {};\n");
	// A second search directory fixes traversal order without mocking readdir.
	const eligible = write(project, "__tests__/accepted.test.ts", imported);
	const visited: string[] = [];
	const read = vi.spyOn(fs, "readFileSync");
	syncBuiltinESMExports();
	try {
		const client = new TestRunnerClient(false);
		expect(
			client.findTestFile(source, project, "vitest", (candidate) => {
				visited.push(candidate);
				return candidate !== rejected;
			}),
		).toEqual({ testFile: eligible, runner: "vitest" });
		expect(visited).toEqual(
			expect.arrayContaining([rejected, noImport, eligible]),
		);
		expect(visited).not.toContain(note);
		expect(visited.at(-1)).toBe(eligible);
		const filesRead = read.mock.calls.map(([file]) => file);
		expect(filesRead).toEqual(expect.arrayContaining([noImport, eligible]));
		expect(filesRead).not.toContain(note);
		expect(filesRead).not.toContain(rejected);
	} finally {
		read.mockRestore();
		syncBuiltinESMExports();
	}
});

const discoveryRows = [
	{
		name: "flat Python",
		runner: "pytest",
		config: "pytest.ini",
		source: "widget.py",
		content: "[pytest]\n",
	},
	{
		name: "recursive Python",
		runner: "pytest",
		config: "pytest.ini",
		source: "widget.py",
		content: "[pytest]\n",
	},
	{
		name: "conventional Go",
		runner: "go",
		config: "go.mod",
		source: "widget.go",
		content: "module example.com/fixture\n",
	},
	{
		name: "import fallback",
		runner: "vitest",
		config: "vitest.config.ts",
		source: "widget.ts",
		content: "export default {};\n",
	},
] as const;

for (const row of discoveryRows) {
	function fixture(multipleForeign = false) {
		const project = path.join(root, "main");
		const nested = path.join(
			project,
			row.name === "recursive Python" ? "tests/a-checkout" : "checkouts/topic",
		);
		markCheckout(project, "directory");
		markCheckout(nested, "file");
		write(project, row.config, row.content);
		const source = write(project, row.source);
		let foreign: string;
		let eligible: string;
		switch (row.name) {
			case "flat Python":
				foreign = linkTest(
					write(nested, "test_widget.py"),
					path.join(project, "tests/test_widget.py"),
					"file",
				);
				if (multipleForeign)
					linkTest(
						write(nested, "test_other_widget.py"),
						path.join(project, "tests/test_yyy_widget.py"),
						"file",
					);
				eligible = write(project, "tests/test_zzz_widget.py");
				break;
			case "recursive Python":
				foreign = write(nested, "test_widget.py");
				if (multipleForeign) write(nested, "test_yyy_widget.py");
				eligible = write(project, "tests/z-parent/test_widget.py");
				break;
			case "conventional Go":
				foreign = linkTest(
					write(nested, "widget_test.go"),
					path.join(project, "widget_test.go"),
					"file",
				);
				if (multipleForeign)
					linkTest(
						write(nested, "other/widget_test.go"),
						path.join(project, "__tests__/widget_test.go"),
						"file",
					);
				eligible = write(project, "tests/widget_test.go");
				break;
			case "import fallback": {
				const content = 'import { widget } from "../widget.js";\n';
				foreign = linkTest(
					write(nested, "a.test.ts", content),
					path.join(project, "tests/a.test.ts"),
					"file",
				);
				if (multipleForeign)
					linkTest(
						write(nested, "b.test.ts", content),
						path.join(project, "tests/b.test.ts"),
						"file",
					);
				eligible = write(project, "tests/z.test.ts", content);
				break;
			}
		}
		return { project, nested, source, foreign, eligible };
	}

	describe(`${row.name} automatic discovery checkout eligibility`, () => {
		it("skips the first foreign match without changing unfiltered discovery or suggestions", async () => {
			// R2: each first-match exit must apply admission before discarding alternatives.
			const f = fixture();
			const client = new TestRunnerClient(false);
			expect(client.findTestFile(f.source, f.project)?.testFile).toBe(
				f.foreign,
			);
			for (let attempt = 0; attempt < 2; attempt++) {
				expect(client.getTestRunTarget(f.source, f.project)).toMatchObject({
					testFile: f.eligible,
					strategy: "related",
					runner: row.runner,
				});
			}
			expect(client.findTestFile(f.source, f.project)?.testFile).toBe(
				f.foreign,
			);
			expect(client.hasTestFile(f.source, f.project)).toBe(true);
			expect(client.suggestTestFiles([f.source], f.project)[0]?.testFile).toBe(
				f.foreign,
			);
			await flushLatencyLog();
			const log = fs.readFileSync(getLatencyLogPath(), "utf8");
			expect(
				log.match(/"kind":"test-discovery-foreign-checkout"/g),
			).toHaveLength(1);
			// #3691 F4: the row must name everything needed to find the exclusion.
			const [excluded] = log
				.split("\n")
				.filter((line) =>
					line.includes('"kind":"test-discovery-foreign-checkout"'),
				)
				.map((line) => JSON.parse(line));
			expect(excluded.metadata).toMatchObject({
				cwd: f.project,
				candidate: f.foreign,
				checkoutRoot: fs.realpathSync.native(f.nested),
				runner: row.runner,
			});
		});

		it("keeps distinct discovery exclusions when their cwd spelling exceeds the ledger field bound", async () => {
			const f = fixture(true);
			// A long spelling, not a long physical directory, keeps this portable.
			const cwd = f.project + `${path.sep}.`.repeat(120);
			const client = new TestRunnerClient(false);
			for (let attempt = 0; attempt < 2; attempt++) {
				expect(client.getTestRunTarget(f.source, cwd)?.testFile).toBe(
					f.eligible,
				);
			}
			await flushLatencyLog();
			const log = fs.readFileSync(getLatencyLogPath(), "utf8");
			expect(
				log.match(/"kind":"test-discovery-foreign-checkout"/g),
			).toHaveLength(2);
		});

		it("reports exclusion when every matching test belongs to another checkout", async () => {
			const f = fixture();
			fs.rmSync(f.eligible);
			const client = new TestRunnerClient(false);
			expect(client.getTestRunTarget(f.source, f.project)).toBeNull();
			expect(client.findTestFile(f.source, f.project)?.testFile).toBe(
				f.foreign,
			);
			await flushLatencyLog();
			expect(fs.readFileSync(getLatencyLogPath(), "utf8")).toContain(
				'"kind":"test-discovery-foreign-checkout"',
			);
		});
	});
}
