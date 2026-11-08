/**
 * Guard for the #3082 guard.
 *
 * Named recurrence: a test that creates a `*.test.ts` — or any other source
 * file a governance walker enumerates — inside the repo's own `tests/` tree at
 * runtime. `tests/clients/pi-lens-home-hermeticity.test.ts` did exactly that
 * for the length of one assertion and redded four different directory-walking
 * sweeps with ENOENT on rotating runs (#3082/#3092).
 */
// flake-shape: raw-timer-wait — the guard's entire claim is that a REAL filesystem event reaches it; no fake clock delivers an inotify event, and a stubbed watcher would prove only that the stub calls its own callback. The wait is a bounded poll on the guard's own report, not a fixed sleep.
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The live config source, not the stale compiled vitest.config.js the build
// emits at the repo root (allowlisted in
// tests/config/module-instance-coverage.test.ts, same reason as its four
// siblings).
import vitestConfig, { sharedGlobalSetup } from "../../vitest.config.ts";
import { TREE_WALK_TIMEOUT_MS } from "./test-timeout-scale.js";
import {
	installTestsTreeWriteGuard,
	isGuardedTreeEntry,
} from "./tests-tree-write-guard.js";
import {
	isUnderIndex2992Scratch,
	runTestsTreeWriteGuardSetup,
} from "./tests-tree-write-guard-setup.js";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

function fixtureTree(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3082-guard-"));
	scratch.push(root);
	fs.mkdirSync(path.join(root, "clients"), { recursive: true });
	fs.writeFileSync(path.join(root, "clients", "tracked.test.ts"), "// tracked");
	return root;
}

/** No watcher: `record` is fed directly, so every classification case is
 *  deterministic. Real delivery has its own case at the end of this file. */
function offlineGuard(root: string) {
	return installTestsTreeWriteGuard(root, { watch: false });
}

describe("tests-tree write guard (#3082)", () => {
	it(
		"reports a source file created under the watched root",
		() => {
			const root = fixtureTree();
			const guard = offlineGuard(root);
			guard.record("scratch-3050.test.ts");
			expect(guard.report()).toMatch(/scratch-3050\.test\.ts/);
			expect(guard.report()).toMatch(/#3082/);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"reports a file created in a nested directory, the shape a walk recurses into",
		() => {
			const root = fixtureTree();
			const guard = offlineGuard(root);
			guard.record(path.join("clients", "scratch-nested.test.ts"));
			expect(guard.report()).toMatch(/scratch-nested\.test\.ts/);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"stays silent for a file that already existed when the run started",
		() => {
			const root = fixtureTree();
			const guard = offlineGuard(root);
			// An editor save, a `git checkout` of a tracked file: the walk started
			// with this path, so no sweep can be surprised by it.
			guard.record(path.join("clients", "tracked.test.ts"));
			expect(guard.report()).toBeUndefined();
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// #3105: tests/index-2992-integration.test.ts writes two files into its
	// own tests/support/.index-2992-scratch/ dir at runtime — the guard's own
	// producer shape, cleaned up. `allow` is how the setup file excuses that
	// scratch dir (by directory prefix, tests-tree-write-guard-setup.ts's
	// isUnderIndex2992Scratch) without weakening coverage of anything else
	// under the watched root.
	it(
		"the allow option excuses a matched path while leaving every other path covered",
		() => {
			const root = fixtureTree();
			const guard = installTestsTreeWriteGuard(root, {
				watch: false,
				allow: (relative) =>
					relative.startsWith(path.join("scratch") + path.sep),
			});
			guard.record(path.join("scratch", "owned.test.ts"));
			guard.record("unrelated.test.ts");
			expect(guard.report()).toMatch(/unrelated\.test\.ts/);
			expect(guard.report()).not.toMatch(/owned\.test\.ts/);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// #3105: matches by DIRECTORY, not by the two filenames the real producer
	// happens to write today — a look-alike sibling directory or a file
	// directly in `support/` must still be covered.
	it("isUnderIndex2992Scratch matches only inside the named scratch directory, not a look-alike neighbor", () => {
		expect(
			isUnderIndex2992Scratch(
				path.join("support", ".index-2992-scratch", "index-2992-probe.ts"),
			),
		).toBe(true);
		expect(
			isUnderIndex2992Scratch(
				path.join("support", ".index-2992-scratch", "anything-else.ts"),
			),
		).toBe(true);
		expect(
			isUnderIndex2992Scratch(
				path.join(
					"support",
					".index-2992-scratch-other",
					"index-2992-probe.ts",
				),
			),
		).toBe(false);
		expect(
			isUnderIndex2992Scratch(path.join("support", "index-2992-probe.ts")),
		).toBe(false);
		expect(isUnderIndex2992Scratch("index-2992-probe.ts")).toBe(false);
	});

	it(
		"stays silent for file kinds no walker under tests/ enumerates",
		() => {
			const root = fixtureTree();
			const guard = offlineGuard(root);
			guard.record("vi-mock-export-baseline.json");
			guard.record(path.join("fixtures", "workspace", "node_modules", "x.mjs"));
			guard.record(null);
			expect(guard.report()).toBeUndefined();
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("classifies by extension and node_modules position, not by filename", () => {
		expect(isGuardedTreeEntry("a.test.ts")).toBe(true);
		expect(isGuardedTreeEntry("helpers.mts")).toBe(true);
		expect(isGuardedTreeEntry("script.mjs")).toBe(true);
		expect(isGuardedTreeEntry("plain-helper.ts")).toBe(true);
		expect(isGuardedTreeEntry("baseline.json")).toBe(false);
		expect(isGuardedTreeEntry("fixtures/node_modules/pkg/index.mjs")).toBe(
			false,
		);
		expect(isGuardedTreeEntry("fixtures/not_node_modules/a.ts")).toBe(true);
	});

	it(
		"records one entry per distinct path, however many events arrive",
		() => {
			const root = fixtureTree();
			const guard = offlineGuard(root);
			for (let index = 0; index < 50; index++) guard.record("repeat.test.ts");
			const report = guard.report() ?? "";
			expect(report.match(/repeat\.test\.ts/g)).toHaveLength(1);
			expect(report).toMatch(/^#3082: 1 source file/);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"caps the reported list and says how many it dropped",
		() => {
			const root = fixtureTree();
			const guard = offlineGuard(root);
			for (let index = 0; index < 25; index++)
				guard.record(`flood-${index}.test.ts`);
			const report = guard.report() ?? "";
			expect(report).toMatch(/^#3082: 25 source file/);
			expect(report).toMatch(/\.\.\. and 5 more/);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"warns once and stays inert when the platform cannot watch recursively",
		() => {
			const root = fixtureTree();
			const write = vi
				.spyOn(process.stderr, "write")
				.mockImplementation(() => true);
			try {
				const guard = installTestsTreeWriteGuard(root, {
					// SAFETY: The injected callback intentionally throws before returning an FSWatcher to exercise the unavailable-platform path.
					watch: (() => {
						throw new Error("ERR_FEATURE_UNAVAILABLE_ON_PLATFORM");
					}) as unknown as typeof fs.watch,
				});
				expect(write).toHaveBeenCalledTimes(1);
				const message = String(write.mock.calls[0]?.[0]);
				expect(message).toMatch(/will not be caught/);
				expect(message.endsWith("\n")).toBe(true);
				expect(guard.report()).toBeUndefined();
				guard.close();
			} finally {
				write.mockRestore();
			}
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"the setup arm throws the report, and closes the watch on the way out",
		() => {
			const root = fixtureTree();
			const guard = offlineGuard(root);
			let closed = 0;
			const teardown = runTestsTreeWriteGuardSetup(root, {
				...guard,
				close: () => {
					closed += 1;
					guard.close();
				},
			});
			guard.record("scratch-setup.test.ts");
			expect(() => teardown()).toThrow(/scratch-setup\.test\.ts/);
			// The throw must not leak the inotify handle (AGENTS.md shape 4).
			expect(closed).toBe(1);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"the setup arm is silent on a tree nothing created a source file in",
		() => {
			const root = fixtureTree();
			const teardown = runTestsTreeWriteGuardSetup(root);
			fs.writeFileSync(
				path.join(root, "clients", "tracked.test.ts"),
				"// edit",
			);
			expect(() => teardown()).not.toThrow();
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// #3104 review F2: without this case, deleting the guard's row from
	// vitest.config.ts's sharedGlobalSetup leaves all ten cases above green
	// while the guard stops running for the entire suite — the restored #3082
	// producer goes completely uncaught (EXIT=0). Every arm in that list has the
	// same silent-absence property, so the assertion covers the whole list, the
	// shape tests/clients/flake-shape-ratchet.test.ts uses for
	// wallClockBudgetInclude.
	it("every run-level guard is registered in vitest.config.ts, on every project", () => {
		expect(sharedGlobalSetup).toEqual([
			"./tests/support/check-build-freshness.ts",
			"./tests/support/prewarm-grammars.ts",
			"./tests/support/prewarm-tool-home.ts",
			"./tests/support/git-config-guard-setup.ts",
			"./tests/support/tests-tree-write-guard-setup.ts",
		]);

		// Registration in the shared list is only half of it: a project that
		// declares its own globalSetup, or none, runs without every guard above.
		const projects = vitestConfig.test?.projects;
		expect(Array.isArray(projects)).toBe(true);
		const withoutSharedSetup = (
			projects as Array<{ test?: { name?: unknown; globalSetup?: unknown } }>
		)
			.filter((project) => project.test?.globalSetup !== sharedGlobalSetup)
			.map((project) => String(project.test?.name ?? "<unnamed>"));
		expect(withoutSharedSetup).toEqual([]);
	});

	// The one real-watcher case, with no stand-in for `fs.watch`: a source file
	// created and removed inside one synchronous block — the producer's exact
	// shape, and the one no before/after snapshot can see — reaches the guard
	// through a real recursive watch. Without this case, deleting the `record`
	// call from the watch callback leaves every other case above green.
	it(
		"records a file created and removed mid-run, through a real recursive watch",
		{ timeout: TREE_WALK_TIMEOUT_MS },
		async () => {
			const root = fixtureTree();
			const guard = installTestsTreeWriteGuard(root);
			const scratchPath = path.join(
				root,
				"clients",
				"scratch-delivery.test.ts",
			);
			try {
				// The write is RETRIED rather than slept in front of: the loop ends on
				// the guard's own report, not on a guessed settle time. The create and
				// the remove are separated by one event-loop turn of THIS process —
				// see the module docstring's "what it cannot see": a watcher only
				// observes a create if its own loop turns while the file exists, which
				// in the real run it always does (the watcher is in the main process,
				// the producer in a worker fork).
				const deadline = Date.now() + 20_000;
				while (guard.report() === undefined && Date.now() < deadline) {
					fs.writeFileSync(scratchPath, "// scratch");
					await new Promise((resolve) => setTimeout(resolve, 50));
					fs.rmSync(scratchPath, { force: true });
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				expect(guard.report()).toMatch(/scratch-delivery\.test\.ts/);
			} finally {
				guard.close();
				fs.rmSync(scratchPath, { force: true });
			}
		},
	);

	/**
	 * #3179: node's non-native recursive watch (the JS polyfill used on Linux,
	 * where inotify has no recursive primitive — lib/internal/fs/
	 * recursive_watch.js) re-scans a changed subfolder with a synchronous
	 * `readdirSync`. When that subfolder is removed between the change event
	 * and the rescan, `#watchFolder`'s own catch re-emits the failure as an
	 * 'error' event on the FSWatcher. With no listener, that is an unhandled
	 * 'error' event: Node throws it back onto the event loop and, absent a
	 * process-level `uncaughtException` handler, the whole vitest process
	 * died with exit 1 and no failing test (PR #3178 run 35154740539, ENOENT
	 * scandir on `tests/support/.index-2992-scratch`, the exempt scratch
	 * directory `tests/index-2992-integration.test.ts` creates and removes at
	 * runtime).
	 *
	 * A minimal fake FSWatcher (a plain EventEmitter standing in for
	 * `fs.watch`'s return value) drives the installed handler directly, so
	 * the swallow-vs-record-once LOGIC is covered deterministically — no
	 * racing a real removal. The one real-watcher reproduction of the crash
	 * itself lives in the last case below.
	 */
	function fakeWatcher(): fs.FSWatcher & { emitError(error: unknown): void } {
		// SAFETY: EventEmitter supplies the event API; the two assigned methods below supply the FSWatcher methods used by the production seam.
		const emitter = new EventEmitter() as unknown as fs.FSWatcher & {
			emitError(error: unknown): void;
		};
		// SAFETY: The fake watcher intentionally implements only the teardown methods exercised by installTestsTreeWriteGuard.
		(emitter as unknown as { unref(): void }).unref = () => {};
		// SAFETY: The fake watcher intentionally implements only the teardown methods exercised by installTestsTreeWriteGuard.
		(emitter as unknown as { close(): void }).close = () => {};
		// SAFETY: emitError is a test-only convenience that forwards to EventEmitter.emit, matching FSWatcher error delivery.
		(emitter as unknown as { emitError(error: unknown): void }).emitError = (
			error,
		) => emitter.emit("error", error);
		return emitter;
	}

	function enoentAt(root: string, relative: string): NodeJS.ErrnoException {
		const absolute = path.join(root, relative);
		return Object.assign(
			new Error(`ENOENT: no such file or directory, scandir '${absolute}'`),
			{ code: "ENOENT", path: absolute },
		);
	}

	function guardWithFakeWatcher(
		root: string,
		allow?: (relative: string) => boolean,
	) {
		const instances: Array<ReturnType<typeof fakeWatcher>> = [];
		const guard = installTestsTreeWriteGuard(root, {
			// SAFETY: The factory returns the EventEmitter-backed FSWatcher double built above for deterministic error delivery.
			watch: (() => {
				const instance = fakeWatcher();
				instances.push(instance);
				return instance;
			}) as unknown as typeof fs.watch,
			allow,
		});
		return { guard, instance: () => instances[0]! };
	}

	it(
		"swallows an ENOENT fs.watch error for a folder under an allowed prefix (#3179)",
		() => {
			const root = fixtureTree();
			const { guard, instance } = guardWithFakeWatcher(
				root,
				isUnderIndex2992Scratch,
			);
			const write = vi
				.spyOn(process.stderr, "write")
				.mockImplementation(() => true);
			try {
				instance().emitError(
					enoentAt(root, path.join("support", ".index-2992-scratch")),
				);
				expect(write).not.toHaveBeenCalled();
			} finally {
				write.mockRestore();
				guard.close();
			}
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"records an fs.watch error once, never silently, when it is not an allowed ENOENT (#3179)",
		() => {
			const root = fixtureTree();
			const { guard, instance } = guardWithFakeWatcher(
				root,
				isUnderIndex2992Scratch,
			);
			const write = vi
				.spyOn(process.stderr, "write")
				.mockImplementation(() => true);
			try {
				// A path OUTSIDE the allowed prefix — same error code, not excused.
				const outside = enoentAt(root, "clients");
				instance().emitError(outside);
				instance().emitError(outside);
				expect(write).toHaveBeenCalledTimes(1);
				const message = String(write.mock.calls[0]?.[0]);
				expect(message).toContain(root);
				expect(message.endsWith("\n")).toBe(true);
			} finally {
				write.mockRestore();
				guard.close();
			}
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"does not widen the exemption to a non-ENOENT error under an allowed prefix (#3179)",
		() => {
			const root = fixtureTree();
			const { guard, instance } = guardWithFakeWatcher(
				root,
				isUnderIndex2992Scratch,
			);
			const write = vi
				.spyOn(process.stderr, "write")
				.mockImplementation(() => true);
			try {
				const eacces = Object.assign(new Error("EACCES: permission denied"), {
					code: "EACCES",
					path: path.join(root, "support", ".index-2992-scratch"),
				});
				instance().emitError(eacces);
				expect(write).toHaveBeenCalledTimes(1);
			} finally {
				write.mockRestore();
				guard.close();
			}
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// The one real, cross-process reproduction of the #3179 crash (no
	// stand-in for `fs.watch`, no stand-in for the removal) lives in
	// tests/support/tests-tree-write-guard-race.test.ts, a separate file: it
	// needs its own real-process-spawn admission, and admissionHeader only
	// ever reads a file's FIRST `// flake-shape:` header — a second header
	// for a different detector in THIS file would silently misvalidate the
	// raw-timer-wait admission already above.
});
