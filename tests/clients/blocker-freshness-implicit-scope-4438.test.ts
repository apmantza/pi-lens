/**
 * #4438: the inline-blocker freshness sweep judged an LSP blocker by its own
 * file and its static imports only, so a fix that landed in a file F depends
 * on with no import statement left the blocker authoritative. The #4430
 * review drove the production sweep with a real RuntimeCoordinator and kept
 * three of four blockers after their fixes landed: a Go package peer, an
 * ambient `.d.ts` and a dynamic-import target.
 *
 * The sweep now asks the diagnostics cache's implicit scope
 * (`clients/lsp/implicit-scope.ts`): the Go package clock for a Go file, the
 * mutation receipts whose file feeds the global scope for a JS/TS file, and
 * the import query also captures `import("x")` and `require("x")`.
 *
 * Every case runs the production sweep, its default resolver (real
 * tree-sitter) and a real RuntimeCoordinator. Red on base ff67dd428.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepInlineBlockerFreshness } from "../../clients/blocker-freshness.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function project(prefix: string, files: Record<string, string>): string {
	const env = setupTestEnvironment(`pi-lens-blocker-implicit-${prefix}-`);
	cleanups.push(env.cleanup);
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(env.tmpDir, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
	return env.tmpDir;
}

/** A later write: one minute past every baseline, clear of the tolerance. */
function later(target: string): void {
	const future = new Date(Date.now() + 60_000);
	fs.utimesSync(target, future, future);
}

/**
 * Record a blocker through the production seam with the content baseline the
 * pipeline captures, so the own file is judged by its bytes.
 */
function block(
	runtime: RuntimeCoordinator,
	filePath: string,
	sources: readonly string[] = ["lsp"],
	recordedAtMs?: number,
): void {
	const content = fs.readFileSync(filePath);
	const at = runtime.recordInlineBlockers(
		filePath,
		"🔴 L1: probe blocker",
		1,
		sources,
		undefined,
		{
			size: content.byteLength,
			sha256: createHash("sha256").update(content).digest("hex"),
		},
		undefined,
		undefined,
		recordedAtMs,
	);
	if (at === undefined) throw new Error("record superseded");
}

function stale(runtime: RuntimeCoordinator): boolean | undefined {
	return runtime.getInlineBlockersSnapshot()[0]?.stale;
}

/**
 * A module whose text does not decide its role (no line opens with
 * `import` or `export`), so classifying it costs a parse from the budget.
 */
function parsedModule(i: number): string {
	return `const m${i} = 1; export { m${i} };\n`;
}

describe("inline-blocker sweep: Go package peers (#4438)", () => {
	const verdictAgo = (): number => Date.now() - 10_000;

	/** A write pi-lens recorded, as every write tool and bash recovery does. */
	function write(
		runtime: RuntimeCoordinator,
		file: string,
		content: string,
	): void {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		runtime.recordProjectMutation({ filePath: file, source: "agent-edit" });
	}

	it("demotes a Go blocker when a package peer is edited", async () => {
		const dir = project("go-edit", {
			"a.go": "package p\n\nvar X = Y\n",
			"b.go": "package p\n\nconst Z = 1\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "a.go"), ["lsp"], verdictAgo());
		write(runtime, path.join(dir, "b.go"), "package p\n\nconst Y = 1\n");

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(1);
		expect(stale(runtime)).toBe(true);
	});

	it("demotes a Go blocker when a package peer is created", async () => {
		const dir = project("go-create", { "a.go": "package p\n\nvar X = Y\n" });
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "a.go"), ["lsp"], verdictAgo());
		write(runtime, path.join(dir, "c.go"), "package p\n\nconst Y = 1\n");

		expect((await sweepInlineBlockerFreshness(runtime, dir)).revalidated).toBe(
			1,
		);
		expect(stale(runtime)).toBe(true);
	});

	// #4438 r2 (F2): a demotion needs a peer pi-lens saw written. A deleted
	// peer has no package clause left to read, so the blocker stays, as the
	// import axis keeps a deleted dependency (#1631). Round 1 demoted on the
	// directory's mtime.
	it("keeps a Go blocker when a package peer is deleted", async () => {
		const dir = project("go-delete", {
			"a.go": "package p\n\nvar X = Y\n",
			"b.go": "package p\n\nconst Y = 1\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "a.go"), ["lsp"], verdictAgo());
		fs.rmSync(path.join(dir, "b.go"));
		runtime.recordProjectMutation({
			filePath: path.join(dir, "b.go"),
			source: "agent-edit",
		});
		later(dir);

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
	});

	it("keeps a Go blocker recorded after the peer write", async () => {
		const dir = project("go-older", {
			"a.go": "package p\n\nvar X = Y\n",
			"b.go": "package p\n\nconst Z = 1\n",
		});
		const runtime = new RuntimeCoordinator();
		write(runtime, path.join(dir, "b.go"), "package p\n\nconst Y = 1\n");
		block(runtime, path.join(dir, "a.go"), ["lsp"], Date.now() + 1_000);

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
	});

	// Recurrence: the own file's write is the content axis's, so a `touch`
	// of the blocker's own Go file must not demote a verdict whose bytes the
	// content axis just confirmed unchanged.
	it("keeps a Go blocker when only its own file is touched", async () => {
		const dir = project("go-touch", {
			"a.go": "package p\n\nvar X = Y\n",
			"b.go": "package p\n\nconst Z = 1\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "a.go"), ["lsp"], verdictAgo());
		later(path.join(dir, "a.go"));
		runtime.recordProjectMutation({
			filePath: path.join(dir, "a.go"),
			source: "agent-edit",
		});

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(1);
		expect(stale(runtime)).toBe(false);
	});

	// #4438 r2 (F2, review S7): an atomic save rewrites the own file through
	// a temp file and a rename; the bytes are the same and the directory's
	// mtime moves. Round 1 demoted on that directory mtime.
	it("keeps a Go blocker when its own file is saved byte-identical through a rename", async () => {
		const dir = project("go-rename", {
			"a.go": "package p\n\nvar X = Y\n",
			"b.go": "package p\n\nconst Z = 1\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "a.go"), ["lsp"], verdictAgo());
		const temp = path.join(dir, ".a.go.tmp");
		fs.writeFileSync(temp, fs.readFileSync(path.join(dir, "a.go")));
		fs.renameSync(temp, path.join(dir, "a.go"));
		later(dir);
		runtime.recordProjectMutation({
			filePath: path.join(dir, "a.go"),
			source: "agent-edit",
		});

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
	});

	// #4438 r2 (F2, review S4): a file that is not Go source is no peer.
	it("keeps a Go blocker when a non-Go file is created in its directory", async () => {
		const dir = project("go-notes", { "a.go": "package p\n\nvar X = Y\n" });
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "a.go"), ["lsp"], verdictAgo());
		write(runtime, path.join(dir, "NOTES.md"), "notes\n");
		later(dir);

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
	});

	// #4438 r2 (F2, review S5): an external test package imports the package
	// it tests; its edit cannot change the package's own diagnostics.
	it("keeps a Go blocker when an external test package file is edited", async () => {
		const dir = project("go-xtest", { "a.go": "package p\n\nvar X = Y\n" });
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "a.go"), ["lsp"], verdictAgo());
		write(
			runtime,
			path.join(dir, "a_test.go"),
			'package p_test\n\nimport "testing"\n\nfunc TestX(t *testing.T) {}\n',
		);

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
	});

	// #4438 r2 (F2): an in-package test file is compiled only into the test
	// variant, so it does not change a non-test file's verdict either.
	it("keeps a Go blocker when an in-package test file is edited", async () => {
		const dir = project("go-itest", { "a.go": "package p\n\nvar X = Y\n" });
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "a.go"), ["lsp"], verdictAgo());
		write(runtime, path.join(dir, "b_test.go"), "package p\n\nconst Y = 1\n");

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
	});

	it("keeps a Go blocker when a file of another package clause is edited", async () => {
		const dir = project("go-clause", { "a.go": "package p\n\nvar X = Y\n" });
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "a.go"), ["lsp"], verdictAgo());
		write(runtime, path.join(dir, "gen.go"), "package q\n\nconst Y = 1\n");

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
	});

	// #4438 r2 (F2, review S6): a peer built only for another OS is not in
	// the host's package build. The tag is never the host's.
	const otherOs = process.platform === "win32" ? "darwin" : "windows";

	it("keeps a Go blocker when a peer whose build line excludes the host is edited", async () => {
		const dir = project("go-build-line", {
			"a.go": "package p\n\nvar X = Y\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "a.go"), ["lsp"], verdictAgo());
		write(
			runtime,
			path.join(dir, "b.go"),
			`//go:build ${otherOs}\n\npackage p\n\nconst Y = 1\n`,
		);

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
	});

	it("keeps a Go blocker when a peer whose file name excludes the host is edited", async () => {
		const dir = project("go-build-name", {
			"a.go": "package p\n\nvar X = Y\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "a.go"), ["lsp"], verdictAgo());
		write(
			runtime,
			path.join(dir, `b_${otherOs}.go`),
			"package p\n\nconst Y = 1\n",
		);

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
	});

	it("keeps a Go blocker when a Go file in another package is edited", async () => {
		const dir = project("go-other", {
			"p/a.go": "package p\n\nvar X = 1\n",
			"q/b.go": "package q\n\nconst Y = 1\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "p", "a.go"), ["lsp"], verdictAgo());
		write(runtime, path.join(dir, "q", "b.go"), "package q\n\nconst Y = 2\n");

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
	});

	it("keeps a tree-sitter blocker on a Go file when a peer is edited", async () => {
		const dir = project("go-self-axis", {
			"a.go": "package p\n\nvar X = 1\n",
			"b.go": "package p\n\nconst Y = 1\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "a.go"), ["tree-sitter"], verdictAgo());
		write(runtime, path.join(dir, "b.go"), "package p\n\nconst Y = 2\n");

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
		expect(stale(runtime)).toBe(false);
	});

	// #4438 r3: the host build is read from `GOOS`/`GOARCH` when set, so each
	// case pins the host and runs the same on every platform. Each case names
	// the `goBuildExcludesHost` branch it pins (review V1, V2).
	describe("build constraints on a pinned host", () => {
		const saved = { GOOS: process.env.GOOS, GOARCH: process.env.GOARCH };
		beforeEach(() => {
			process.env.GOOS = "linux";
			process.env.GOARCH = "amd64";
		});
		afterEach(() => {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		});

		/** Sweep counts after a recorded write of `peer` beside `blocker`. */
		async function sweepAfterPeerWrite(
			peer: string,
			content: string,
			blocker = "a.go",
		): Promise<{ revalidated: number; kept: number }> {
			const dir = project("go-build-pinned", {
				[blocker]: "package p\n\nvar X = Y\n",
			});
			const runtime = new RuntimeCoordinator();
			block(runtime, path.join(dir, blocker), ["lsp"], verdictAgo());
			write(runtime, path.join(dir, peer), content);
			const { revalidated, kept } = await sweepInlineBlockerFreshness(
				runtime,
				dir,
			);
			return { revalidated, kept };
		}
		const kept = { revalidated: 0, kept: 1 };
		const demoted = { revalidated: 1, kept: 0 };
		const peerBody = "package p\n\nconst Y = 1\n";

		// The arch suffix: a peer built for another architecture.
		it("keeps a Go blocker when a peer named for another architecture is edited", async () => {
			expect(await sweepAfterPeerWrite("b_linux_arm64.go", peerBody)).toEqual(
				kept,
			);
		});

		// The OS of an OS_arch pair: the arch matches, the OS does not.
		it("keeps a Go blocker when a peer named for another OS and the host architecture is edited", async () => {
			expect(await sweepAfterPeerWrite("b_windows_amd64.go", peerBody)).toEqual(
				kept,
			);
		});

		// `!` negation of the host's OS.
		it("keeps a Go blocker when a peer whose build line negates the host is edited", async () => {
			expect(
				await sweepAfterPeerWrite("b.go", `//go:build !linux\n\n${peerBody}`),
			).toEqual(kept);
		});

		// The `_test` strip: the OS suffix before `_test` still excludes.
		it("keeps a Go test blocker when a test peer named for another OS is edited", async () => {
			expect(
				await sweepAfterPeerWrite("b_windows_test.go", peerBody, "a_test.go"),
			).toEqual(kept);
		});

		// The base-name rule: in `linux_amd64.go`, `linux` is the base name,
		// not an OS constraint, so only the arch suffix applies.
		it("demotes a Go blocker when a peer whose base name is an OS is edited", async () => {
			process.env.GOOS = "windows";
			expect(await sweepAfterPeerWrite("linux_amd64.go", peerBody)).toEqual(
				demoted,
			);
		});

		// The `unix` tag holds on every Unix-like OS.
		it("demotes a Go blocker when a peer whose build line is unix is edited", async () => {
			expect(
				await sweepAfterPeerWrite("b.go", `//go:build unix\n\n${peerBody}`),
			).toEqual(demoted);
		});

		// A one-term line that names the host is positive evidence.
		it("demotes a Go blocker when a peer whose build line names the host is edited", async () => {
			expect(
				await sweepAfterPeerWrite("b.go", `//go:build linux\n\n${peerBody}`),
			).toEqual(demoted);
		});

		// Review V2 (G14): a compound line is not evaluated, so it is no
		// evidence that the peer is built.
		it("keeps a Go blocker when a peer whose build line is compound is edited", async () => {
			expect(
				await sweepAfterPeerWrite(
					"b.go",
					`//go:build windows && amd64\n\n${peerBody}`,
				),
			).toEqual(kept);
		});

		// Review V2 (G11): a legacy `// +build` line is not evaluated either.
		it("keeps a Go blocker when a peer with a legacy build line is edited", async () => {
			expect(
				await sweepAfterPeerWrite("b.go", `// +build windows\n\n${peerBody}`),
			).toEqual(kept);
		});

		// Review V2 (G16): a tag that names no OS or architecture (`ignore`)
		// cannot be decided.
		it("keeps a Go blocker when a peer whose build line names an unknown tag is edited", async () => {
			expect(
				await sweepAfterPeerWrite("b.go", `//go:build ignore\n\n${peerBody}`),
			).toEqual(kept);
		});
	});
});

describe("inline-blocker sweep: ambient files (#4438)", () => {
	const verdictAgo = (): number => Date.now() - 10_000;

	it("demotes a JS/TS blocker when an ambient declaration file is written after it", async () => {
		const dir = project("ambient-create", {
			"use.ts": "export const u: number = FOO;\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		const globals = path.join(dir, "globals.d.ts");
		fs.writeFileSync(globals, "declare const FOO: number;\n");
		runtime.recordProjectMutation({ filePath: globals, source: "agent-write" });

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(1);
		expect(stale(runtime)).toBe(true);
	});

	it("demotes a JS/TS blocker when a global script is edited after it", async () => {
		const dir = project("ambient-edit", {
			"use.ts": "export const u: number = FOO;\n",
			"globals.ts": "declare const BAR: number;\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		const globals = path.join(dir, "globals.ts");
		fs.writeFileSync(globals, "declare const FOO: number;\n");
		runtime.recordProjectMutation({ filePath: globals, source: "agent-edit" });

		expect((await sweepInlineBlockerFreshness(runtime, dir)).revalidated).toBe(
			1,
		);
	});

	it("keeps a JS/TS blocker when the file written after it is a module", async () => {
		const dir = project("ambient-module", {
			"use.ts": "export const u: number = FOO;\n",
			"mod.ts": "export const m = 1;\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		runtime.recordProjectMutation({
			filePath: path.join(dir, "mod.ts"),
			source: "agent-edit",
		});

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
	});

	it("keeps a JS/TS blocker recorded after the ambient write", async () => {
		const dir = project("ambient-older", {
			"use.ts": "export const u: number = FOO;\n",
			"globals.d.ts": "declare const FOO: number;\n",
		});
		const runtime = new RuntimeCoordinator();
		runtime.recordProjectMutation({
			filePath: path.join(dir, "globals.d.ts"),
			source: "agent-write",
		});
		block(runtime, path.join(dir, "use.ts"));

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
	});

	// #4438 r2: JS/TS entries share one scan per sweep; each is still judged
	// against its own verdict.
	it("demotes only the blocker recorded before the ambient write", async () => {
		const dir = project("ambient-two-verdicts", {
			"early.ts": "export const e: number = FOO;\n",
			"late.ts": "export const l: number = FOO;\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "early.ts"), ["lsp"], verdictAgo());
		const globals = path.join(dir, "globals.d.ts");
		fs.writeFileSync(globals, "declare const FOO: number;\n");
		runtime.recordProjectMutation({ filePath: globals, source: "agent-write" });
		block(runtime, path.join(dir, "late.ts"), ["lsp"], Date.now() + 1_000);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(1);
		expect(counts.kept).toBe(1);
		const byFile = new Map(
			runtime
				.getInlineBlockersSnapshot()
				.map((entry) => [path.basename(entry.filePath), entry.stale]),
		);
		expect(byFile.get("early.ts")).toBe(true);
		expect(byFile.get("late.ts")).toBe(false);
	});

	it("keeps a Python blocker when an ambient file is written after it", async () => {
		const dir = project("ambient-python", {
			"app.py": "x = FOO\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "app.py"), ["lsp"], verdictAgo());
		const globals = path.join(dir, "globals.d.ts");
		fs.writeFileSync(globals, "declare const FOO: number;\n");
		runtime.recordProjectMutation({ filePath: globals, source: "agent-write" });

		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
	});

	// The bound on the per-turn parse work: the receipts are read newest first,
	// and past the budget an older receipt is not read, so the blocker is left
	// as it is and the sweep counts the cut.
	it("leaves a blocker alone and counts the cut once the parse budget is spent", async () => {
		const files: Record<string, string> = {
			"use.ts": "export const u: number = FOO;\n",
			"globals.ts": "declare const FOO: number;\n",
		};
		for (let i = 0; i < 40; i++) {
			files[`m${i}.ts`] = parsedModule(i);
		}
		const dir = project("ambient-budget", files);
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		runtime.recordProjectMutation({
			filePath: path.join(dir, "globals.ts"),
			source: "agent-edit",
		});
		for (let i = 0; i < 40; i++) {
			runtime.recordProjectMutation({
				filePath: path.join(dir, `m${i}.ts`),
				source: "agent-edit",
			});
		}

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(1);
		expect(counts.truncatedImports).toBe(1);
	});

	// #4438 r2 (F1, review S1): a receipt whose file is gone is no evidence.
	// Round 1 asked the cache's fail-closed classifier, which answers "feeds"
	// for an unreadable file, and demoted every earlier JS/TS blocker.
	it("keeps a JS/TS blocker when the file written after it is deleted", async () => {
		const dir = project("ambient-deleted", {
			"use.ts": "export const u: number = FOO;\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		const helper = path.join(dir, "helper.ts");
		fs.writeFileSync(helper, "export const h = 1;\n");
		runtime.recordProjectMutation({ filePath: helper, source: "agent-write" });
		fs.rmSync(helper);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(1);
		expect(counts.truncatedImports).toBe(0);
		expect(stale(runtime)).toBe(false);
	});

	// #4438 r2 (F1, review S1b): the same after a sweep classified the file.
	it("keeps a JS/TS blocker when a module a sweep classified is deleted", async () => {
		const dir = project("ambient-deleted-later", {
			"use.ts": "export const u: number = FOO;\n",
			"helper.ts": "export const h = 1;\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		const helper = path.join(dir, "helper.ts");
		runtime.recordProjectMutation({ filePath: helper, source: "agent-edit" });
		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);

		fs.rmSync(helper);
		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);
		expect(stale(runtime)).toBe(false);
	});

	// #4438 r2 (F1, review S9): a module over the LSP sync limits (a copy of
	// `clients/lsp/index.ts`, 9,729 lines, in the review) is no evidence.
	// Round 1 asked the cache's fail-closed classifier, which answers "feeds"
	// past the limits, so each edit of one of pi-lens's five oversized files
	// demoted every earlier TS blocker. Its text now says module.
	it("keeps a JS/TS blocker when the module written after it is over the sync limits", async () => {
		const lines = ["import * as fs from 'node:fs';"];
		for (let i = 0; i < 5_100; i++) lines.push(`export const v${i} = ${i};`);
		const dir = project("ambient-oversized", {
			"use.ts": "export const u: number = FOO;\n",
			"big.ts": `${lines.join("\n")}\n`,
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		runtime.recordProjectMutation({
			filePath: path.join(dir, "big.ts"),
			source: "agent-edit",
		});

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(1);
		expect(stale(runtime)).toBe(false);
	});

	// #4438 r2 (F1): a file neither its name nor its text decides, and no
	// parse may read (over the LSP sync limits), has an unknown role: a cut,
	// not a demotion.
	it("keeps a JS/TS blocker and counts the cut when the file written after it cannot be classified", async () => {
		const lines: string[] = [];
		for (let i = 0; i < 5_100; i++) lines.push(`const v${i} = ${i};`);
		const dir = project("ambient-unknown", {
			"use.ts": "export const u: number = FOO;\n",
			"big.ts": `${lines.join("\n")}\n`,
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		runtime.recordProjectMutation({
			filePath: path.join(dir, "big.ts"),
			source: "agent-edit",
		});

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(1);
		expect(counts.truncatedImports).toBe(1);
		expect(stale(runtime)).toBe(false);
	});

	// #4438 r2: most modules open a line with `import` or `export`; their
	// text decides the role, so they cost no parse and spend no budget.
	it("reads past modules its text decides without spending the parse budget", async () => {
		const files: Record<string, string> = {
			"use.ts": "export const u: number = FOO;\n",
			"globals.ts": "declare const FOO: number;\n",
		};
		for (let i = 0; i < 40; i++)
			files[`e${i}.ts`] = `export const e${i} = 1;\n`;
		const dir = project("ambient-by-text", files);
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		runtime.recordProjectMutation({
			filePath: path.join(dir, "globals.ts"),
			source: "agent-edit",
		});
		for (let i = 0; i < 40; i++) {
			runtime.recordProjectMutation({
				filePath: path.join(dir, `e${i}.ts`),
				source: "agent-edit",
			});
		}

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(1);
		expect(counts.truncatedImports).toBe(0);
	});

	// #4438 r2: the text rule leaves an ambient declaration in a module to
	// the parse.
	it("demotes a JS/TS blocker when a module that declares a global is written after it", async () => {
		const dir = project("ambient-declare-global", {
			"use.ts": "export const u: number = FOO;\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		const globals = path.join(dir, "globals.ts");
		fs.writeFileSync(
			globals,
			"export {};\ndeclare global {\n\tconst FOO: number;\n}\n",
		);
		runtime.recordProjectMutation({ filePath: globals, source: "agent-edit" });

		expect((await sweepInlineBlockerFreshness(runtime, dir)).revalidated).toBe(
			1,
		);
	});

	// #4438 r2 (F3, review S2): receipts are session-wide, and a linked
	// worktree records its own; an ambient file outside the sweep's root is
	// not in the blocker's scope.
	it("keeps a JS/TS blocker when the ambient file written after it is outside the root", async () => {
		const dir = project("ambient-root", {
			"app/use.ts": "export const u: number = FOO;\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "app", "use.ts"), ["lsp"], verdictAgo());
		const outside = path.join(dir, "other", "globals.d.ts");
		fs.mkdirSync(path.dirname(outside), { recursive: true });
		fs.writeFileSync(outside, "declare const FOO: number;\n");
		runtime.recordProjectMutation({ filePath: outside, source: "agent-write" });

		const counts = await sweepInlineBlockerFreshness(
			runtime,
			path.join(dir, "app"),
		);
		expect(counts.kept).toBe(1);
		expect(stale(runtime)).toBe(false);
	});

	// Recurrence: AGENTS.md shape 83. The sweep's `inRoot` spelled the
	// containment rule itself beside `isWithinForm`, its owner; a copy is where
	// the directory boundary drifts. `<dir>/app-two` shares the text `<dir>/app`
	// but is another directory, so its ambient write is outside the sweep's root.
	it("keeps a JS/TS blocker when the ambient file written after it sits in a sibling that shares the root's text prefix", async () => {
		const dir = project("ambient-root-text-prefix", {
			"app/use.ts": "export const u: number = FOO;\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "app", "use.ts"), ["lsp"], verdictAgo());
		const sibling = path.join(dir, "app-two", "globals.d.ts");
		fs.mkdirSync(path.dirname(sibling), { recursive: true });
		fs.writeFileSync(sibling, "declare const FOO: number;\n");
		runtime.recordProjectMutation({ filePath: sibling, source: "agent-write" });

		const counts = await sweepInlineBlockerFreshness(
			runtime,
			path.join(dir, "app"),
		);
		expect(counts.kept).toBe(1);
		expect(stale(runtime)).toBe(false);
	});

	// #4438 r2 (F4, review U4): a file its name decides (a declaration file,
	// a file that is not JS/TS) costs no parse, so 33 newer `.md` receipts do
	// not spend the budget before the older ambient one is read.
	it("reads past receipts its name decides without spending the parse budget", async () => {
		const files: Record<string, string> = {
			"use.ts": "export const u: number = FOO;\n",
			"globals.d.ts": "declare const FOO: number;\n",
		};
		for (let i = 0; i < 33; i++) files[`n${i}.md`] = `note ${i}\n`;
		const dir = project("ambient-by-name", files);
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		runtime.recordProjectMutation({
			filePath: path.join(dir, "globals.d.ts"),
			source: "agent-write",
		});
		for (let i = 0; i < 33; i++) {
			runtime.recordProjectMutation({
				filePath: path.join(dir, `n${i}.md`),
				source: "agent-edit",
			});
		}

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(1);
		expect(counts.truncatedImports).toBe(0);
	});

	// #4438 r2 (F5): the cut is per entry. A second blocker recorded after
	// every receipt reads none of them and is not counted.
	it("counts the cut only for the entry whose check stopped short", async () => {
		const files: Record<string, string> = {
			"use.ts": "export const u: number = FOO;\n",
			"late.ts": "export const l: number = FOO;\n",
		};
		for (let i = 0; i < 40; i++) files[`m${i}.ts`] = parsedModule(i);
		const dir = project("ambient-cut-per-entry", files);
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		for (let i = 0; i < 40; i++) {
			runtime.recordProjectMutation({
				filePath: path.join(dir, `m${i}.ts`),
				source: "agent-edit",
			});
		}
		block(runtime, path.join(dir, "late.ts"), ["lsp"], Date.now() + 1_000);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(2);
		expect(counts.truncatedImports).toBe(1);
	});

	// The parse memo outlives the sweep: the files the last sweep classified
	// cost no budget, so the next turn reads past them to the older receipt.
	// Without it every turn re-parsed the same 32 files (~23 ms on pi-lens's
	// own files) and never reached the fix.
	it("reads past the files a previous sweep classified", async () => {
		const files: Record<string, string> = {
			"use.ts": "export const u: number = FOO;\n",
			"globals.ts": "declare const FOO: number;\n",
		};
		for (let i = 0; i < 40; i++) {
			files[`m${i}.ts`] = parsedModule(i);
		}
		const dir = project("ambient-memo", files);
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		runtime.recordProjectMutation({
			filePath: path.join(dir, "globals.ts"),
			source: "agent-edit",
		});
		for (let i = 0; i < 40; i++) {
			runtime.recordProjectMutation({
				filePath: path.join(dir, `m${i}.ts`),
				source: "agent-edit",
			});
		}
		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.revalidated).toBe(1);
		expect(stale(runtime)).toBe(true);
	});

	// The memo is keyed by the file's version: a module rewritten into a
	// script feeds the global scope from then on.
	it("classifies a file again once it is rewritten", async () => {
		const dir = project("ambient-rewrite", {
			"use.ts": "export const u: number = FOO;\n",
			"shared.ts": "export const s = 1;\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		const shared = path.join(dir, "shared.ts");
		runtime.recordProjectMutation({ filePath: shared, source: "agent-edit" });
		expect((await sweepInlineBlockerFreshness(runtime, dir)).kept).toBe(1);

		fs.writeFileSync(shared, "declare const FOO: number;\n");
		later(shared);
		runtime.recordProjectMutation({ filePath: shared, source: "agent-edit" });
		expect((await sweepInlineBlockerFreshness(runtime, dir)).revalidated).toBe(
			1,
		);
	});

	// The receipt ring is bounded; a receipt it evicted may be the fix, so a
	// window with evictions after the verdict is counted, not read as clean.
	it("counts the cut when the receipt ring evicted receipts after the verdict", async () => {
		const dir = project("ambient-evicted", {
			"use.ts": "export const u: number = FOO;\n",
			"globals.d.ts": "declare const FOO: number;\n",
			"notes.md": "notes\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"), ["lsp"], verdictAgo());
		runtime.recordProjectMutation({
			filePath: path.join(dir, "globals.d.ts"),
			source: "agent-write",
		});
		for (let i = 0; i < 512; i++) {
			runtime.recordProjectMutation({
				filePath: path.join(dir, "notes.md"),
				source: "agent-edit",
			});
		}
		expect(runtime.droppedMutationReceiptCount).toBe(1);

		const counts = await sweepInlineBlockerFreshness(runtime, dir);
		expect(counts.kept).toBe(1);
		expect(counts.truncatedImports).toBe(1);
	});
});

describe("inline-blocker sweep: dynamic imports (#4438)", () => {
	it("demotes a blocker when a dynamic-import target is edited", async () => {
		const dir = project("dyn-edit", {
			"use.ts": 'export const f = () => import("./dyn");\n',
			"dyn.ts": "export const d = 1;\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"));
		later(path.join(dir, "dyn.ts"));

		expect((await sweepInlineBlockerFreshness(runtime, dir)).revalidated).toBe(
			1,
		);
		expect(stale(runtime)).toBe(true);
	});

	it("demotes a blocker when a dynamic-import target is created", async () => {
		const dir = project("dyn-create", {
			"use.ts": 'export const f = () => import("./dyn");\n',
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.ts"));
		fs.writeFileSync(path.join(dir, "dyn.ts"), "export const d = 1;\n");
		later(path.join(dir, "dyn.ts"));

		expect((await sweepInlineBlockerFreshness(runtime, dir)).revalidated).toBe(
			1,
		);
	});

	it("demotes a blocker when a require target is edited", async () => {
		const dir = project("require-edit", {
			"use.js": 'const r = require("./req");\nmodule.exports = r;\n',
			"req.js": "module.exports = 1;\n",
		});
		const runtime = new RuntimeCoordinator();
		block(runtime, path.join(dir, "use.js"));
		later(path.join(dir, "req.js"));

		expect((await sweepInlineBlockerFreshness(runtime, dir)).revalidated).toBe(
			1,
		);
	});
});
