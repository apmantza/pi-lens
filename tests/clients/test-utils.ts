import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, vi } from "vitest";
import {
	getTmpRootRegistry,
	registerTmpRoot,
} from "../support/tmp-root-registry.js";

// A just-used temp dir can still be written to after the owning test is done:
// a Windows file handle held briefly after a child/watcher/background scan
// exits (AV scanning, delayed handle release, #793, #810), or — measured on
// Linux, #4081 — a grandchild of a SIGKILLed real child still writing under
// the scratch home. An immediate recursive `rm` then throws EPERM/ENOTEMPTY.
// Node's in-call `maxRetries` does not recover that on Node 22 (it stalls
// ~3 s and still throws), so this loops over FRESH `rmSync` calls, each one
// re-walking the directory, for at most REMOVE_BUDGET_MS in total. If the dir
// is STILL there, a leftover temp dir under the OS temp root is harmless (the
// OS reclaims it eventually) while failing the whole test run over teardown
// is not — so the final failure warns instead of throwing. This is the ONE
// shared cleanup helper for test temp dirs (#810's pattern-class rule) —
// route every ad-hoc `fs.rmSync(dir, { recursive: true, force: true })`
// teardown through this instead of hand-rolling retries per suite.
const REMOVE_BUDGET_MS = 2_000;
const REMOVE_RETRY_MS = 50;
// The errnos Node's own `maxRetries` retries; anything else is not transient.
const RETRYABLE_REMOVE_CODES = new Set([
	"EBUSY",
	"EMFILE",
	"ENFILE",
	"ENOTEMPTY",
	"EPERM",
]);
export function removeTempDirSync(dir: string): void {
	const deadline = Date.now() + REMOVE_BUDGET_MS;
	for (;;) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (
				code === undefined ||
				!RETRYABLE_REMOVE_CODES.has(code) ||
				Date.now() >= deadline
			) {
				process.stderr.write(
					`[test cleanup] could not remove temp dir ${dir}: ${
						err instanceof Error ? err.message : String(err)
					}\n`,
				);
				return;
			}
			Atomics.wait(
				new Int32Array(new SharedArrayBuffer(4)),
				0,
				0,
				REMOVE_RETRY_MS,
			);
		}
	}
}

export function setupTestEnvironment(prefix = "pi-lens-test-"): {
	tmpDir: string;
	cleanup: () => void;
} {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	activeTestEnvironments.add(tmpDir);
	// #2912: the shared setup removes this root at file teardown and on SIGTERM,
	// so a timeout or a failed assertion before `cleanup()` cannot leak it.
	registerTmpRoot(getTmpRootRegistry(), tmpDir, "registered");
	return {
		tmpDir,
		cleanup: () => {
			removeTempDirSync(tmpDir);
			// Keep the root tracked: deferred work can recreate it before the
			// owning family's cleanup sweep runs.
		},
	};
}

const activeTestEnvironments = new Set<string>();

export function cleanupTestEnvironments(
	prefix: string,
	options: { untrack?: boolean } = {},
): void {
	for (const tmpDir of activeTestEnvironments) {
		if (!path.basename(tmpDir).startsWith(prefix)) continue;
		removeTempDirSync(tmpDir);
		if (options.untrack !== false && !fs.existsSync(tmpDir)) {
			activeTestEnvironments.delete(tmpDir);
		}
	}
}

type WriterModule = Record<string, unknown>;

/**
 * Every copy of a writer module a drain has reached, keyed by subsystem. A
 * test that calls `vi.resetModules()` can leave queued writes on an earlier
 * copy (the one its top-level import holds) or on a later one (the one it
 * re-imported), so a drain waits on each copy it has seen, not only the
 * current one.
 */
const seenWriterModules = new Map<string, Set<WriterModule>>();

async function drainWriter(
	name: string,
	load: () => Promise<WriterModule>,
	hooks: readonly string[],
): Promise<void> {
	let copies = seenWriterModules.get(name);
	if (!copies) {
		copies = new Set();
		seenWriterModules.set(name, copies);
	}
	try {
		copies.add(await load());
	} catch {
		// The module failed to load under this file's mocks: nothing new to add.
	}
	for (const mod of copies) {
		for (const hook of hooks) {
			try {
				const fn = mod[hook];
				if (typeof fn === "function") await fn();
			} catch {
				// Mocked without the hook, or the hook failed: nothing to drain.
			}
		}
	}
}

/**
 * Wait for every known background writer that can recreate a fixture root
 * after its test removed it: review-graph persists, project-snapshot body
 * persists, and extension-log appends. Each costs nothing when idle.
 *
 * The modules are loaded here, at call time, never at the top of this file,
 * so a file that never touched a writer pays only the import. Skipped under
 * fake timers; restore real timers first.
 *
 * Gap: a copy is only seen once a drain runs while it is the current copy. A
 * file that resets modules before its first drain, while its top-level import
 * still has writes queued, must drain that copy itself.
 */
export async function drainBackgroundWritesForTests(): Promise<void> {
	// The waits poll on `setTimeout`, which never fires under fake timers.
	if (vi.isFakeTimers()) return;
	await drainWriter(
		"review-graph",
		() => import("../../clients/review-graph/builder.js"),
		["flushReviewGraphPersistsForTests", "waitForReviewGraphPersistsForTests"],
	);
	await drainWriter(
		"project-snapshot",
		() => import("../../clients/project-snapshot.js"),
		["waitForProjectSnapshotPersistsForTests"],
	);
	await drainWriter(
		"extension-log",
		() => import("../../clients/extension-log.js"),
		["flushExtensionLog"],
	);
}

/**
 * Drain in-flight jscpd scans started by the resident analyzer bootstrap before
 * a test removes its fixture roots (#4133). A session-start jscpd scan is
 * fire-and-forget; if the test file ends while one is still running, Vitest
 * SIGTERMs the worker before the scan's `finally` removes its report directory
 * and the `pi-lens-jscpd-*` entry is stranded in the shared tmpdir. The
 * `JscpdClient.shutdown()` barrier (#3338) waits for it. `peek` resolves the
 * already-loaded client without forcing a load, and the method is optional so a
 * stub bootstrap double is a no-op rather than a crash.
 */
export async function drainResidentJscpdScans(): Promise<void> {
	const { peekBootstrapClients } = await import("../../clients/bootstrap.js");
	const client = peekBootstrapClients()?.jscpdClient as
		| { shutdown?: () => Promise<void> }
		| undefined;
	await client?.shutdown?.();
}

/**
 * Drain deferred fixture producers before the final cleanup pass. Keeping
 * roots tracked until the last tick preserves the hygiene sweep's handle.
 * The known background writers are drained first unless `drainWrites` is
 * false.
 */
export async function cleanupTestEnvironmentsDrained(
	prefix: string,
	options: {
		beforeDrain?: () => Promise<void>;
		drainWrites?: boolean;
	} = {},
): Promise<void> {
	await options.beforeDrain?.();
	if (options.drainWrites !== false) await drainBackgroundWritesForTests();
	for (let tick = 0; tick < 3; tick++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (tick === 2) {
			// The final producer turn can be queued by the preceding drain.
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		cleanupTestEnvironments(prefix, { untrack: tick === 2 });
	}
}

/**
 * Register an `afterEach` that drains and removes every root created through
 * `setupTestEnvironment` with one of `prefixes`. Call it at file or describe
 * scope, and create the file's temp roots with `setupTestEnvironment`.
 */
export function useTrackedTempDirs(...prefixes: string[]): void {
	afterEach(async () => {
		// The drain below parks on `setImmediate`, which a fake-timer test has
		// replaced. Vitest runs `afterEach` hooks in reverse registration order, so
		// this hook runs BEFORE the file's own `vi.useRealTimers()` teardown and
		// hung to the 10 s hook timeout, failing the faking test and every test
		// after it (launch.test.ts on Windows, #4019). Restore the real clock first.
		vi.useRealTimers();
		for (const prefix of prefixes) await cleanupTestEnvironmentsDrained(prefix);
	});
}

/**
 * A file reachable under TWO spellings that differ only in case, where the
 * kernel reports the on-disk spelling for both — the exact contract
 * `normalizeFilePath`'s POSIX arm depends on (#3098, the live half of #1024:
 * a raw mis-cased `lens_diagnostic_mark` write and a `normalizeMapKey` read
 * deriving two anchors for one file, so the agent's own mark never applies).
 *
 * Built natively where the filesystem is case-insensitive (macOS APFS/HFS+,
 * Windows, `nocase` vfat/ntfs3/cifs). On a case-sensitive filesystem — the
 * ubuntu Unit tests lane — the same observable contract is manufactured with a
 * case-variant symlink (`SUB` → `sub`): `existsSync(SUB/a.ts)` is true and
 * `realpathSync.native` returns `sub/a.ts`, byte-identical to what APFS
 * answers, so the seam under test cannot tell the two fixtures apart and the
 * guard runs on EVERY lane instead of skipping on the one CI actually has.
 *
 * `skipReason` is set — and the case cases must skip visibly — only where the
 * kernel cannot supply that contract: a Linux ext4/tmpfs casefold directory
 * aliases the spellings but `realpath(3)` returns the QUERIED casing (measured
 * in #3154), so there is nothing for the normalizer to canonicalize toward.
 */
export function createCaseAliasFixture(
	baseDir: string,
	options: { dirName?: string; fileName?: string; content?: string } = {},
): {
	/** Mis-cased spelling, as a raw `path.resolve(cwd, arg)` would carry it. */
	rawMisCased: string;
	/** The spelling really on disk. */
	onDisk: string;
	/** Set when this filesystem cannot report on-disk casing (see above). */
	skipReason?: string;
} {
	const dirName = options.dirName ?? "sub";
	const fileName = options.fileName ?? "a.ts";
	const onDiskDir = path.join(baseDir, dirName);
	fs.mkdirSync(onDiskDir, { recursive: true });
	const onDisk = path.join(onDiskDir, fileName);
	fs.writeFileSync(onDisk, options.content ?? "const target = bad();\n");

	const misCasedDir = path.join(baseDir, dirName.toUpperCase());
	const rawMisCased = path.join(misCasedDir, fileName);
	if (!fs.existsSync(rawMisCased)) {
		try {
			fs.symlinkSync(dirName, misCasedDir, "dir");
		} catch (err) {
			return {
				rawMisCased,
				onDisk,
				skipReason: `cannot alias ${dirName} as ${dirName.toUpperCase()}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			};
		}
	}
	let canonical: string | undefined;
	try {
		canonical = fs.realpathSync.native(rawMisCased);
	} catch {
		canonical = undefined;
	}
	return canonical === undefined || canonical === rawMisCased
		? {
				rawMisCased,
				onDisk,
				skipReason:
					"filesystem aliases the two spellings but reports the QUERIED casing, " +
					"not the on-disk one (Linux casefold directory) — refs #3154",
			}
		: { rawMisCased, onDisk };
}

export function createTempFile(
	baseDir: string,
	relativePath: string,
	content: string,
): string {
	const filePath = path.join(baseDir, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	return filePath;
}
