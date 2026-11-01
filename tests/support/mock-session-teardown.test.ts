import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../clients/test-utils.js";
import {
	astGrepLspChildrenOwnedHere,
	newAstGrepLspChildren,
} from "./mock-session-teardown.js";

/**
 * The census behind `endMockSessions` (#5146), run over a fixture `/proc`.
 * Recurrence prevented: the census was a bare read of the live `/proc` with no
 * committed control, so a mutation of its parent, state or argv test, or of the
 * "created in this case" filter, left every other test green: only a real
 * `ast-grep lsp` child could red it, and none runs in CI (the s7 orphan red on
 * PR #5161 shard 5, job 124892873231, was the only sighting).
 */
const WORKER = 4242;

describe("the ast-grep lsp census over a fixture /proc (#5146)", () => {
	let proc: string;

	function entry(
		pid: string,
		opts: { ppid?: number; state?: string; argv?: string[]; comm?: string },
	): void {
		const dir = path.join(proc, pid);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "stat"),
			`${pid} (${opts.comm ?? "ast-grep"}) ${opts.state ?? "S"} ${opts.ppid ?? WORKER} 0 0\n`,
		);
		fs.writeFileSync(
			path.join(dir, "cmdline"),
			`${(opts.argv ?? ["ast-grep", "lsp"]).join("\0")}\0`,
		);
	}

	function fresh(): void {
		proc = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5146-proc-"));
	}

	afterEach(() => {
		removeTempDirSync(proc);
	});

	it("counts a live ast-grep lsp child of the worker, by bare or absolute argv0", () => {
		fresh();
		entry("11", {});
		entry("12", { argv: ["/opt/bin/ast-grep", "lsp"] });
		expect(astGrepLspChildrenOwnedHere(proc, WORKER)).toEqual(
			expect.arrayContaining([11, 12]),
		);
		expect(astGrepLspChildrenOwnedHere(proc, WORKER)).toHaveLength(2);
	});

	it("does not count a process another parent owns", () => {
		fresh();
		entry("21", { ppid: 1 });
		expect(astGrepLspChildrenOwnedHere(proc, WORKER)).toEqual([]);
	});

	it("does not count a zombie or a dead entry", () => {
		fresh();
		entry("31", { state: "Z" });
		entry("32", { state: "X" });
		expect(astGrepLspChildrenOwnedHere(proc, WORKER)).toEqual([]);
	});

	it("does not count an ast-grep that is not the language server, or another binary's lsp", () => {
		fresh();
		entry("41", { argv: ["ast-grep", "scan"] });
		entry("42", { argv: ["sg", "lsp"] });
		entry("43", { argv: ["ast-grep"] });
		expect(astGrepLspChildrenOwnedHere(proc, WORKER)).toEqual([]);
	});

	it("reads a comm that holds spaces and parentheses, and skips non-pid and half-written entries", () => {
		fresh();
		entry("51", { comm: "a b) (c" });
		fs.mkdirSync(path.join(proc, "self"));
		fs.mkdirSync(path.join(proc, "52"));
		expect(astGrepLspChildrenOwnedHere(proc, WORKER)).toEqual([51]);
	});

	it("charges a case only for the children it created", () => {
		fresh();
		entry("61", {});
		entry("62", {});
		expect(newAstGrepLspChildren(new Set([61]), proc, WORKER)).toEqual([62]);
		expect(newAstGrepLspChildren(new Set([61, 62]), proc, WORKER)).toEqual([]);
	});
});
