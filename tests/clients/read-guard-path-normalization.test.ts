/**
 * Regression: read-guard keyed its reads/edits maps on the raw file path, so a
 * read recorded under one separator/casing form (e.g. the slash-normalized path
 * that LSP-expanded and search-tool reads produce) was invisible to an edit
 * checked under another (the Read tool's OS-native backslashes on Windows). The
 * guard then reported `zero_read` and blocked the edit even though the file had
 * been read — repeatedly, in a real session (see read-guard.log: reads logged
 * with `C:/…` forward slashes, the blocking edit with `C:\\…` backslashes).
 *
 * The fix canonicalizes every map key through `normalizeFilePath`. These tests
 * pin that record and lookup agree regardless of the separator/casing the two
 * call sites happen to use.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createReadGuard, type ReadRecord } from "../../clients/read-guard.js";
import { logReadGuardEvent } from "../../clients/read-guard-logger.js";

vi.mock("../../clients/read-guard-logger.js", () => ({
	logReadGuardEvent: vi.fn(),
	getReadGuardLogPath: vi.fn(() => "/dev/null"),
}));

vi.mock("../../clients/file-time.js", () => ({
	createFileTime: () => ({
		read: vi.fn(),
		hasChanged: vi.fn(() => false),
		assert: vi.fn(),
		get: vi.fn(),
	}),
}));

function rec(
	filePath: string,
	overrides: Partial<ReadRecord> = {},
): ReadRecord {
	return {
		filePath,
		requestedOffset: 1,
		requestedLimit: 100,
		effectiveOffset: 1,
		effectiveLimit: 100,
		expandedByLsp: false,
		turnIndex: 1,
		writeIndex: 1,
		timestamp: Date.now(),
		...overrides,
	};
}

describe("ReadGuard path-key normalization (zero_read false-block regression)", () => {
	it("allows an edit checked with backslashes after a read recorded with forward slashes", () => {
		const guard = createReadGuard("test-session");
		guard.recordRead(rec("/proj/providers/model-fetcher.ts"));

		const verdict = guard.checkEdit("\\proj\\providers\\model-fetcher.ts");

		expect(verdict.action).toBe("allow");
	});

	it("allows the reverse — read recorded with backslashes, edit checked with forward slashes", () => {
		const guard = createReadGuard("test-session");
		guard.recordRead(rec("\\proj\\tests\\kilo.test.ts"));

		const verdict = guard.checkEdit("/proj/tests/kilo.test.ts");

		expect(verdict.action).toBe("allow");
	});

	it("getReadHistory matches across separator forms", () => {
		const guard = createReadGuard("test-session");
		guard.recordRead(rec("/proj/a.ts"));

		expect(guard.getReadHistory("\\proj\\a.ts")).toHaveLength(1);
	});

	it("a once-recorded exemption is honored regardless of separator form", () => {
		const guard = createReadGuard("test-session");
		guard.addExemption("/proj/b.ts");

		expect(guard.checkEdit("\\proj\\b.ts").action).toBe("allow");
	});

	// Path casing folds only on Windows, so this declares itself skipped
	// elsewhere rather than returning early and reporting a PASS (#2089).
	// lane: windows-vitest
	it.skipIf(process.platform !== "win32")(
		"folds Windows path casing so cased read forms match lower-cased edits",
		() => {
			const guard = createReadGuard("test-session");
			guard.recordRead(rec("C:/Proj/Src/Api.ts"));

			expect(guard.checkEdit("c:/proj/src/api.ts").action).toBe("allow");
		},
	);

	it("still blocks a genuinely unread file (guard not weakened)", () => {
		const guard = createReadGuard("test-session");

		const verdict = guard.checkEdit("/proj/never-read.ts");

		expect(verdict.action).toBe("block");
		expect(verdict.reason).toContain("Edit without read");
	});

	// RECURRENCE GUARDED (#3159 review round 2, F2): `checkEdit` rewrites its
	// argument to `this.key(filePath)` (read-guard.ts:931) and renders that KEY
	// into the RETRYABLE instruction — `read path="…"`. The key must therefore
	// always name a path the agent can actually read. #3098's first POSIX
	// casing arm could rewrite a case-variant symlink's basename onto a
	// directory that does not exist (`node_modules/Foo` → `node_modules/foo`),
	// so the block told the agent to read a path that ENOENTs and the edit
	// could never be unblocked — a permanent block, worse than the defect
	// #3098 set out to fix. Runs on EVERY filesystem and needs no skip: the
	// assertion is that the quoted path EXISTS, which holds on a case-sensitive
	// one (the key stays `Foo`) and on a case-insensitive one (`foo` and `Foo`
	// name the same file, so the rewritten key exists too). #3159 round 3
	// deleted the skip it used to carry — its probe ran before the symlink
	// existed, so it answered "no aliasing" on every platform and guarded
	// nothing.
	it("the retryable block names a path that exists, under a case-variant symlinked package", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rg-case-"));
		try {
			fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
			fs.mkdirSync(path.join(tmpDir, "pkgs", "foo"), { recursive: true });
			const target = path.join(tmpDir, "pkgs", "foo", "i.ts");
			fs.writeFileSync(target, "export const i = 1;\n");
			fs.symlinkSync(
				path.join("..", "pkgs", "foo"),
				path.join(tmpDir, "node_modules", "Foo"),
				"dir",
			);
			const held = path.join(tmpDir, "node_modules", "Foo", "i.ts");

			const verdict = createReadGuard("test-session").checkEdit(held);

			expect(verdict.action).toBe("block");
			const quoted = /read path="([^"]+)"/.exec(verdict.reason ?? "")?.[1];
			expect(quoted).toBeDefined();
			expect(fs.existsSync(quoted as string)).toBe(true);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
		}
	});
});

/**
 * Whether the filesystem backing `os.tmpdir()` folds case, probed ONCE before
 * any fixture creates case-variant siblings (#3159 round 3: a probe that runs
 * AFTER the variants exist answers "no aliasing" everywhere and guards
 * nothing). Case-variant siblings cannot coexist on a folding filesystem
 * (macOS APFS), so the POSIX fixtures below declare themselves skipped there
 * rather than reporting a PASS (#2089).
 */
function tmpdirFoldsCase(): boolean {
	const probeDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-case-probe-"),
	);
	try {
		fs.writeFileSync(path.join(probeDir, "probe.tmp"), "");
		return fs.existsSync(path.join(probeDir, "PROBE.TMP"));
	} finally {
		fs.rmSync(probeDir, { recursive: true, force: true, maxRetries: 5 });
	}
}

const TMPDIR_FOLDS_CASE = tmpdirFoldsCase();

/**
 * Build the fixture the POSIX arm of #3163 needs: a package reachable through
 * TWO case-variant directory entries (`node_modules/Foo` and
 * `node_modules/foo`, both symlinks to the real `pkgs/foo`). That is what makes
 * `normalizeFilePath` answer DIFFERENTLY either side of the file appearing:
 * while `<…>/node_modules/Foo/i.ts` is absent `realpathSync.native` throws and
 * the caller's own spelling is kept, and once it exists the canonical casing
 * (`foo`) is adopted — the rewrite is confirmed against the filesystem
 * (#3159 F1) and here it CONFIRMS, because the lower-cased sibling really does
 * resolve to the same package.
 */
function makeCaseVariantPackage(tmpDir: string): string {
	fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
	fs.mkdirSync(path.join(tmpDir, "pkgs", "foo"), { recursive: true });
	fs.symlinkSync(
		path.join("..", "pkgs", "foo"),
		path.join(tmpDir, "node_modules", "Foo"),
		"dir",
	);
	fs.symlinkSync(
		path.join("..", "pkgs", "foo"),
		path.join(tmpDir, "node_modules", "foo"),
		"dir",
	);
	return path.join(tmpDir, "node_modules", "Foo", "i.ts");
}

/**
 * RECURRENCE GUARDED (#3163, AGENTS.md defect shape 1 — "divergent path keys"):
 * `pendingCreations` was keyed through `this.key()` (`normalizeFilePath`) on
 * BOTH sides of the state change the key derivation itself depends on —
 * `noteCreatedFile` runs while the announced file is still ABSENT (that is its
 * whole purpose) and `recordWritten` looks the entry up after it EXISTS. Every
 * spelling whose key moves when the file appears (win32: a mixed-case basename,
 * lower-cased in the absent branch by `resolveNonExisting`; POSIX since #3098: a
 * parent whose canonical casing is adopted once `realpathSync.native` succeeds)
 * therefore stored one key and looked up another, orphaning the entry — nothing
 * prunes `pendingCreations` — so the creation read was never injected.
 */
describe("ReadGuard pendingCreations key (#3163 existence-straddle)", () => {
	// lane: Unit tests (ubuntu) — the authoritative lane, whose filesystem is
	// case-sensitive. Declared skipped on a folding filesystem (macOS APFS),
	// where the two case-variant entries cannot coexist at all.
	describe.skipIf(TMPDIR_FOLDS_CASE)("POSIX case-variant parent", () => {
		it("injects the creation read for a case-variant announced parent", () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rg-3163-"));
			try {
				const held = makeCaseVariantPackage(tmpDir);
				const authored = "export const i = 1;\nexport const j = 2;\n";
				const guard = createReadGuard("test-session");

				// The pi Write tool's lifecycle: tool_call announces the creation
				// while the file is absent, the tool writes it, tool_result fires
				// recordWritten — which must find the announcement and inject the
				// synthetic read covering everything the agent just authored.
				guard.noteCreatedFile(held, 7, 3);
				fs.writeFileSync(held, authored);
				guard.recordWritten(held);

				const history = guard.getReadHistory(held);
				expect(history).toHaveLength(1);
				expect(history[0].effectiveOffset).toBe(1);
				// Covers the whole file the agent just authored, counted from the
				// fixture rather than re-deriving it from the guard's own split.
				expect(history[0].effectiveLimit).toBe(authored.split("\n").length);
				expect(history[0].turnIndex).toBe(7);
				expect(history[0].writeIndex).toBe(3);
				// The injected read is also the observable one: read-guard.log gets
				// the `read_recorded` row (clients/read-guard.ts:788) carrying the
				// announced turn/write index, which is what a session read back
				// from the log lacked entirely while the entry was orphaned.
				expect(logReadGuardEvent).toHaveBeenCalledWith(
					expect.objectContaining({
						event: "read_recorded",
						filePath: expect.stringContaining("i.ts"),
						metadata: expect.objectContaining({ turnIndex: 7, writeIndex: 3 }),
					}),
				);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
			}
		});

		// The user-visible consequence, end to end. An injected creation read is
		// OUTSTANDING enforcement state, so `touchFile` deliberately arms no idle
		// timer for it (read-guard.ts:685-687) and the file's write record survives
		// idle session. With the entry orphaned there is no read, the idle timer
		// runs and `evictFile` drops `writtenThisSession`, which is exactly what
		// covers FAT32 granularity, NFS clock skew and a formatter that rewinds
		// mtime. Then the follow-up edit of the file the agent itself just
		// created is blocked with `zero_read`.
		it("keeps a just-created file editable across an idle window when mtime is unreliable", () => {
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-rg-3163b-"),
			);
			const previousIdle = process.env.PI_LENS_READ_GUARD_IDLE_EVICT_MS;
			process.env.PI_LENS_READ_GUARD_IDLE_EVICT_MS = "1000";
			vi.useFakeTimers();
			try {
				const held = makeCaseVariantPackage(tmpDir);
				const guard = createReadGuard("test-session");

				guard.noteCreatedFile(held, 7, 3);
				fs.writeFileSync(held, "export const i = 1;\nexport const j = 2;\n");
				guard.recordWritten(held);
				// An external tool rewrites mtime backward after the write.
				const longAgo = new Date("2000-01-01T00:00:00Z");
				fs.utimesSync(held, longAgo, longAgo);

				vi.advanceTimersByTime(5000);

				expect(guard.checkEdit(held, [1, 2]).action).toBe("allow");
			} finally {
				vi.useRealTimers();
				if (previousIdle === undefined)
					delete process.env.PI_LENS_READ_GUARD_IDLE_EVICT_MS;
				else process.env.PI_LENS_READ_GUARD_IDLE_EVICT_MS = previousIdle;
				fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
			}
		});

		// The OTHER half of the pair, and the one that pins the fix's own risk:
		// `noteCreatedFile` fires for EVERY non-edit Write (runtime-tool-call.ts),
		// including an overwrite of a file that already exists, so its key must
		// keep matching `recordWritten` in that state too. Both sides used to be
		// `this.key()` and this case already worked; it reds the moment
		// `noteCreatedFile` is put back on `this.key()` while `recordWritten`
		// looks up the syntactic spelling, which is the half-applied fix.
		it("injects the creation read when the announced file already existed", () => {
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-rg-3163c-"),
			);
			try {
				const held = makeCaseVariantPackage(tmpDir);
				fs.writeFileSync(held, "export const i = 0;\n");
				const guard = createReadGuard("test-session");

				guard.noteCreatedFile(held, 5, 2);
				fs.writeFileSync(held, "export const i = 1;\n");
				guard.recordWritten(held);

				const history = guard.getReadHistory(held);
				expect(history).toHaveLength(1);
				expect(history[0].turnIndex).toBe(5);
				expect(history[0].writeIndex).toBe(2);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
			}
		});
	});

	// The win32 arm is broader than the POSIX one and needs no symlink:
	// `resolveNonExisting` lower-cases the tail of any path that does not exist
	// yet, so EVERY newly created file with an upper-case letter in its basename
	// (`Button.tsx`, `NewModule.ts`) stored a key `realpathSync.native` no
	// longer produces once the file lands. Not expressible on the ubuntu lane: a
	// win32-shaped path can never EXIST on Linux, so both sides of the straddle
	// take the absent branch there and the divergence cannot be produced at all.
	// lane: windows-vitest
	describe.skipIf(process.platform !== "win32")(
		"win32 mixed-case basename",
		() => {
			it("injects the creation read for a mixed-case basename on win32", () => {
				const tmpDir = fs.mkdtempSync(
					path.join(os.tmpdir(), "pi-lens-rg-3163w-"),
				);
				try {
					fs.mkdirSync(path.join(tmpDir, "src"));
					const held = path.join(tmpDir, "src", "NewModule.ts");
					const guard = createReadGuard("test-session");

					guard.noteCreatedFile(held, 2, 1);
					fs.writeFileSync(held, "export const x = 1;\n");
					guard.recordWritten(held);

					const history = guard.getReadHistory(held);
					expect(history).toHaveLength(1);
					expect(history[0].turnIndex).toBe(2);
					expect(history[0].writeIndex).toBe(1);
				} finally {
					fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
				}
			});
		},
	);
});
