// flake-shape: real-process-spawn — the default branch is read by real `git for-each-ref` and `git show` against a real repository; a stubbed git cannot show which ref and blob the read resolves.
/**
 * #5087 S2: the per-edit complexity delta against the default branch.
 *
 * The pure half (`worsenedFunctions`, `formatComplexityAdvisory`) is driven
 * with literal tables; the git half (`readAtDefaultBranch`) and the whole
 * judgement (`captureComplexityBaseline` then `adviseOnEdit`) run against a
 * real repository and the shared tree-sitter parser.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The process boundary the default-branch read crosses: every `safeSpawnAsync`
 * call is recorded and delegates to the real spawn, unless a case installs
 * `before` (to act at the moment git is about to run) or `answer` (to stand in
 * for a git that timed out).
 */
const spawnProbe = vi.hoisted(() => ({
	calls: [] as string[][],
	before: undefined as (() => void) | undefined,
	answer: undefined as
		| ((args: readonly string[]) => Record<string, unknown> | undefined)
		| undefined,
}));

vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/safe-spawn.js")>();
	return {
		...actual,
		safeSpawnAsync: ((
			command: string,
			args: readonly string[],
			options: { resourceLabel?: string },
		) => {
			if (command === "git" && options.resourceLabel === "complexity-main") {
				spawnProbe.calls.push([...args]);
				spawnProbe.before?.();
				const answered = spawnProbe.answer?.(args);
				if (answered) return Promise.resolve(answered);
			}
			return (actual.safeSpawnAsync as (...a: unknown[]) => unknown)(
				command,
				args,
				options,
			);
		}) as unknown as typeof actual.safeSpawnAsync,
	};
});
import { BoundedLruCache } from "../../../clients/bounded-cache.js";
import { ComplexityClient } from "../../../clients/complexity-client.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	adviseOnEdit,
	captureComplexityBaseline,
	type ComplexityBaseline,
	complexityBaselineKey,
	type FunctionTable,
	formatComplexityAdvisory,
	MAX_ADVISORY_BYTES,
	measureFunctionTable,
	readAtDefaultBranch,
	worsenedFunctions,
	type WorsenedFunction,
} from "../../../clients/metrics/complexity-baseline.js";
import {
	gitExecFileSync,
	installGitFixtureEnv,
} from "../../support/git-fixture-env.js";
import { removeTempDirSync } from "../test-utils.js";

/**
 * A file's first-touch baseline as the `tool_call` takes it: from the rows the
 * analyzer's own measure keyed (`analyzeFile`'s `measuredFunctions`).
 */
async function firstTouch(file: string) {
	return captureComplexityBaseline(
		(await new ComplexityClient().analyzeFile(file))?.measuredFunctions,
	);
}

const THRESHOLDS = { cyclomatic: 15, nesting: 6 };

function table(
	rows: Array<[string, number, number]>,
): Map<string, { name: string; cyclomatic: number; nesting: number }> {
	return new Map(
		rows.map(([key, cyclomatic, nesting]) => [
			key,
			{ name: key, cyclomatic, nesting },
		]),
	);
}

function onMain(functions: FunctionTable, last?: FunctionTable) {
	return {
		main: { kind: "file", ref: "main", functions },
		last,
	} satisfies ComplexityBaseline;
}

describe("worsenedFunctions (#5087)", () => {
	it("reports a function this edit pushed past the threshold, against main", () => {
		const main = table([["f", 10, 1]]);
		const out = worsenedFunctions(
			onMain(main, main),
			table([["f", 18, 1]]),
			THRESHOLDS,
		);
		expect(out).toEqual([
			{
				key: "f",
				name: "f",
				changes: [
					{ metric: "cyclomatic", before: 10, after: 18, threshold: 15 },
				],
			},
		]);
	});

	it("reports a function already past the threshold that the edit made worse", () => {
		const main = table([["f", 16, 1]]);
		expect(
			worsenedFunctions(onMain(main, main), table([["f", 20, 1]]), THRESHOLDS),
		).toHaveLength(1);
	});

	it("reports nothing below the threshold, unchanged, or improved", () => {
		const main = table([
			["low", 5, 1],
			["same", 30, 7],
			["better", 30, 7],
		]);
		const after = table([
			["low", 9, 1],
			["same", 30, 7],
			["better", 25, 7],
		]);
		expect(worsenedFunctions(onMain(main, main), after, THRESHOLDS)).toEqual(
			[],
		);
	});

	it("leaves a function the edit did not touch alone, however far it sits from main", () => {
		const main = table([["f", 3, 1]]);
		const last = table([["f", 22, 1]]);
		expect(
			worsenedFunctions(onMain(main, last), table([["f", 22, 1]]), THRESHOLDS),
		).toEqual([]);
	});

	it("does not report an edit that lowered a function still worse than main", () => {
		const main = table([["f", 3, 1]]);
		const last = table([["f", 22, 1]]);
		expect(
			worsenedFunctions(onMain(main, last), table([["f", 19, 1]]), THRESHOLDS),
		).toEqual([]);
	});

	it("does not report an edit that raises a function no further than main has it", () => {
		// The branch had simplified it (16); the edit restores part of main's 20.
		const main = table([["f", 20, 1]]);
		const last = table([["f", 16, 1]]);
		expect(
			worsenedFunctions(onMain(main, last), table([["f", 18, 1]]), THRESHOLDS),
		).toEqual([]);
	});

	it("reports a function main does not have as new", () => {
		const out = worsenedFunctions(
			onMain(table([]), table([])),
			table([["g", 22, 2]]),
			THRESHOLDS,
		);
		expect(out[0]?.changes).toEqual([
			{ metric: "cyclomatic", before: undefined, after: 22, threshold: 15 },
		]);
	});

	it("reports nesting on its own threshold", () => {
		const main = table([["f", 2, 3]]);
		const out = worsenedFunctions(
			onMain(main, main),
			table([["f", 2, 6]]),
			THRESHOLDS,
		);
		expect(out[0]?.changes.map((c) => c.metric)).toEqual(["nesting"]);
	});

	it("judges against the session's first table when main is unavailable", () => {
		const last = table([["f", 16, 1]]);
		const baseline: ComplexityBaseline = {
			main: { kind: "unavailable", reason: "not-a-git-repository" },
			last,
		};
		expect(
			worsenedFunctions(baseline, table([["f", 16, 1]]), THRESHOLDS),
		).toEqual([]);
		expect(
			worsenedFunctions(baseline, table([["f", 17, 1]]), THRESHOLDS)[0]
				?.changes[0],
		).toEqual({ metric: "cyclomatic", before: 16, after: 17, threshold: 15 });
	});
});

describe("formatComplexityAdvisory (#5087)", () => {
	const worse = (n: number): WorsenedFunction[] =>
		Array.from({ length: n }, (_, i) => ({
			key: `Service.handleRequestNumber${i}`,
			name: `handleRequestNumber${i}`,
			changes: [
				{ metric: "cyclomatic", before: 10, after: 20 + i, threshold: 15 },
			],
		}));

	it("says nothing when nothing worsened", () => {
		expect(formatComplexityAdvisory([], "main")).toBeUndefined();
	});

	it("names the function, the baseline and the threshold", () => {
		expect(
			formatComplexityAdvisory(
				[
					{
						key: "A.run",
						name: "run",
						changes: [
							{ metric: "cyclomatic", before: 12, after: 19, threshold: 15 },
							{ metric: "nesting", before: undefined, after: 6, threshold: 6 },
						],
					},
				],
				"origin/master",
			),
		).toBe(
			"⚠ complexity vs origin/master: A.run cc 12→19 (≥15), nest new→6 (≥6)",
		);
	});

	it("stays within 240 bytes and counts what it leaves out", () => {
		expect(MAX_ADVISORY_BYTES).toBe(240);
		const line = formatComplexityAdvisory(worse(10), "main");
		expect(line).toBeDefined();
		expect(Buffer.byteLength(line ?? "", "utf-8")).toBeLessThanOrEqual(
			MAX_ADVISORY_BYTES,
		);
		expect(line).toMatch(/; \+\d+ more$/);
	});
});

describe("formatComplexityAdvisory keeps one short line (#5087)", () => {
	const one = (key: string): WorsenedFunction[] => [
		{
			key,
			name: key,
			changes: [{ metric: "cyclomatic", before: 10, after: 21, threshold: 15 }],
		},
	];

	// F9: a computed method name can hold a newline; the advisory is one line.
	it("collapses whitespace in a function's name", () => {
		const line = formatComplexityAdvisory(one("A.[`a\nb\t c`]"), "main");
		expect(line).toBe("⚠ complexity vs main: A.[`a b c`] cc 10→21 (≥15)");
	});

	// A 260-byte branch name used to drop the advisory; a 300-byte name left
	// only "1 function worse".
	it("truncates a long baseline label instead of dropping the advisory", () => {
		const line = formatComplexityAdvisory(
			one("f"),
			`origin/${"b".repeat(260)}`,
		);
		expect(line ?? "").toContain("f cc 10→21 (≥15)");
		expect(line ?? "").toMatch(/^⚠ complexity vs origin\/b+…: f cc/);
		expect(Buffer.byteLength(line ?? "", "utf-8")).toBeLessThanOrEqual(
			MAX_ADVISORY_BYTES,
		);
	});

	it("truncates a long function name instead of reporting a bare count", () => {
		const line = formatComplexityAdvisory(one("g".repeat(300)), "main");
		expect(line ?? "").toMatch(/^⚠ complexity vs main: g+… cc 10→21 \(≥15\)$/);
		expect(Buffer.byteLength(line ?? "", "utf-8")).toBeLessThanOrEqual(
			MAX_ADVISORY_BYTES,
		);
	});

	it("truncates multi-byte names by bytes", () => {
		const line = formatComplexityAdvisory(
			one("é".repeat(300)),
			"ü".repeat(300),
		);
		expect(line ?? "").toContain(" cc 10→21 (≥15)");
		expect(Buffer.byteLength(line ?? "", "utf-8")).toBeLessThanOrEqual(
			MAX_ADVISORY_BYTES,
		);
	});
});

describe("the default-branch baseline in a real repository (#5087)", () => {
	let root: string;
	const git = (...args: string[]) =>
		gitExecFileSync("git", args, { cwd: root, encoding: "utf8" });

	beforeEach(() => {
		spawnProbe.calls.length = 0;
		spawnProbe.before = undefined;
		spawnProbe.answer = undefined;
		resetDegradationLedger();
		root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5087-main-")),
		);
		installGitFixtureEnv(root);
		git("init", "-q", "-b", "main");
		git("config", "user.email", "t@t.local");
		git("config", "user.name", "t");
	});

	afterEach(() => {
		removeTempDirSync(root);
	});

	function write(rel: string, content: string): string {
		const file = path.join(root, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		return file;
	}

	function commit(): void {
		git("add", "-A");
		git("commit", "-q", "-m", "c");
	}

	/** A function of cyclomatic complexity `1 + branches`. */
	function fn(name: string, branches: number): string {
		const body = Array.from(
			{ length: branches },
			(_, i) => `\tif (x === ${i}) return ${i};`,
		).join("\n");
		return `export function ${name}(x: number): number {\n${body}\n\treturn -1;\n}\n`;
	}

	it("reads the file as main holds it, from a branch that changed it", async () => {
		const file = write("src/a.ts", fn("a", 2));
		commit();
		git("checkout", "-q", "-b", "feature");
		write("src/a.ts", fn("a", 9));
		commit();
		const read = await readAtDefaultBranch(file);
		expect(read).toEqual({ kind: "file", ref: "main", content: fn("a", 2) });
	});

	// #4966: a file link answers its target's repository, not the one beside
	// the link.
	it("reads a linked file from its target's repository", async () => {
		write("src/a.ts", fn("a", 2));
		commit();
		const outside = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5087-link-")),
		);
		try {
			const link = path.join(outside, "link.ts");
			fs.symlinkSync(path.join(root, "src", "a.ts"), link);
			expect(await readAtDefaultBranch(link)).toEqual({
				kind: "file",
				ref: "main",
				content: fn("a", 2),
			});
		} finally {
			removeTempDirSync(outside);
		}
	});

	it("prefers origin/HEAD's target over a local main", async () => {
		const file = write("a.ts", fn("a", 1));
		commit();
		git("update-ref", "refs/remotes/origin/trunk", "HEAD");
		git(
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
			"refs/remotes/origin/trunk",
		);
		expect(await readAtDefaultBranch(file)).toMatchObject({
			kind: "file",
			ref: "origin/trunk",
		});
	});

	it("calls a file main lacks absent, and a non-repository unavailable", async () => {
		write("a.ts", fn("a", 1));
		commit();
		const added = write("src/new.ts", fn("n", 1));
		expect(await readAtDefaultBranch(added)).toEqual({
			kind: "absent",
			ref: "main",
		});
		const outside = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5087-nogit-")),
		);
		try {
			fs.writeFileSync(path.join(outside, ".git"), "");
			const loose = path.join(outside, "b.ts");
			fs.writeFileSync(loose, fn("b", 1));
			expect(await readAtDefaultBranch(loose)).toMatchObject({
				kind: "unavailable",
			});
		} finally {
			removeTempDirSync(outside);
		}
	});

	it("advises on an edit worse than main, then stays quiet on an edit that leaves it alone", async () => {
		const file = write("src/svc.ts", fn("handle", 3) + fn("other", 1));
		commit();
		const store = new BoundedLruCache<string, ComplexityBaseline>(4);
		const writes: string[] = [];
		const session = {
			guardedWrite: <T>(subject: string, write: () => T) => {
				writes.push(subject);
				return write();
			},
		};
		// First touch measures the bytes on disk only; main waits for an edit.
		const baseline = await firstTouch(file);
		expect(baseline?.main).toBeUndefined();
		store.set(complexityBaselineKey(file), baseline);

		fs.writeFileSync(file, fn("handle", 17) + fn("other", 1));
		const first = await adviseOnEdit({
			filePath: file,
			store,
			session,
			thresholds: THRESHOLDS,
		});
		expect(first?.advisory).toBe("⚠ complexity vs main: handle cc 4→18 (≥15)");
		expect(store.get(complexityBaselineKey(file))?.main?.kind).toBe("file");

		// The next edit changes another function only: `handle` is still far
		// past main, but this edit did not touch it.
		fs.writeFileSync(file, fn("handle", 17) + fn("other", 2));
		const second = await adviseOnEdit({
			filePath: file,
			store,
			session,
			thresholds: THRESHOLDS,
		});
		expect(second?.advisory).toBeUndefined();
		expect(writes).toEqual([file, file]);
	});

	it("keeps the stored table when the session handle drops the write", async () => {
		const file = write("svc.ts", fn("handle", 3));
		commit();
		const store = new BoundedLruCache<string, ComplexityBaseline>(4);
		const baseline = await firstTouch(file);
		store.set(complexityBaselineKey(file), baseline);
		fs.writeFileSync(file, fn("handle", 17));
		const retired = { guardedWrite: () => undefined };
		await adviseOnEdit({
			filePath: file,
			store,
			session: retired,
			thresholds: THRESHOLDS,
		});
		expect(store.get(complexityBaselineKey(file))).toBe(baseline);
	});

	const writes = {
		guardedWrite: <T>(_subject: string, write: () => T) => write(),
	};

	/** A store holding `file`'s first-touch table, as the `tool_call` leaves it. */
	async function touched(file: string) {
		const store = new BoundedLruCache<string, ComplexityBaseline>(4);
		const baseline = await firstTouch(file);
		store.set(complexityBaselineKey(file), baseline);
		return { store, baseline };
	}

	/** An anonymous route handler of cyclomatic complexity `1 + branches`. */
	function handler(route: string, branches: number): string {
		const body = Array.from(
			{ length: branches },
			(_, i) => `\tif (req === ${i}) return ${i};`,
		).join("\n");
		return `app.get("${route}", (req: number) => {\n${body}\n\treturn -1;\n});\n`;
	}

	// #5087 F2: keys number same-name siblings by source order, so a small
	// anonymous callback inserted above an unchanged cc-20 handler shifts the
	// handler to `<anonymous>#2`, a key main lacks: it read as new and worse.
	it("never names an anonymous callback an edit only shifted", async () => {
		const file = write("src/routes.ts", handler("/a", 19));
		commit();
		const { store } = await touched(file);
		fs.writeFileSync(
			file,
			`app.get("/b", (req: number) => {\n\treturn req;\n});\n${handler("/a", 19)}`,
		);
		const verdict = await adviseOnEdit({
			filePath: file,
			store,
			session: writes,
			thresholds: THRESHOLDS,
		});
		expect(verdict?.advisory).toBeUndefined();
	});

	// #5087 F3: `high-complexity` exempts test-suite organizers (#577); adding
	// one it() to a describe past the threshold must not be named either.
	it("never names a test-suite organizer that grew by one it()", async () => {
		const suite = (its: number) =>
			`describe("suite", () => {\n${Array.from(
				{ length: its },
				(_, i) => `\tit("t${i}", () => {\n\t\tif (a) b();\n\t});`,
			).join("\n")}\n});\n`;
		const file = write("src/suite.test.ts", suite(16));
		commit();
		const { store } = await touched(file);
		fs.writeFileSync(file, suite(17));
		const verdict = await adviseOnEdit({
			filePath: file,
			store,
			session: writes,
			thresholds: THRESHOLDS,
		});
		expect(verdict?.advisory).toBeUndefined();
	});

	// #5087 F11: a file with no stored entry (evicted, or first written by a
	// bash command) has no `last`, so every function past the threshold looked
	// worse than main. The edit stores the table and says nothing.
	it("advises nothing for an edit with no stored entry, then judges the next", async () => {
		const file = write("src/svc.ts", fn("handle", 3));
		commit();
		fs.writeFileSync(file, fn("handle", 17));
		const store = new BoundedLruCache<string, ComplexityBaseline>(4);
		const first = await adviseOnEdit({
			filePath: file,
			store,
			session: writes,
			thresholds: THRESHOLDS,
		});
		expect(first?.advisory).toBeUndefined();
		expect(store.get(complexityBaselineKey(file))?.last?.get("handle")).toEqual(
			{ name: "handle", cyclomatic: 18, nesting: 1 },
		);
		// No git was run for an edit that judged nothing.
		expect(spawnProbe.calls).toEqual([]);
		fs.writeFileSync(file, fn("handle", 18));
		const second = await adviseOnEdit({
			filePath: file,
			store,
			session: writes,
			thresholds: THRESHOLDS,
		});
		expect(second?.advisory).toBe("⚠ complexity vs main: handle cc 4→19 (≥15)");
	});

	// #5087 F7: the once-per-file read of main is the hot-path bound. Two
	// edits of one file run `for-each-ref` and `git show` once between them.
	it("reads main once per file across edits", async () => {
		const file = write("src/svc.ts", fn("handle", 3));
		commit();
		const { store } = await touched(file);
		fs.writeFileSync(file, fn("handle", 17));
		await adviseOnEdit({
			filePath: file,
			store,
			session: writes,
			thresholds: THRESHOLDS,
		});
		expect(spawnProbe.calls.map((c) => c[0])).toEqual(["for-each-ref", "show"]);
		fs.writeFileSync(file, fn("handle", 18));
		await adviseOnEdit({
			filePath: file,
			store,
			session: writes,
			thresholds: THRESHOLDS,
		});
		expect(spawnProbe.calls.map((c) => c[0])).toEqual(["for-each-ref", "show"]);
	});

	// #5087 F7: the table cap, as a literal. 513 functions keep 512, in
	// source order.
	it("keeps the first 512 functions of a table", async () => {
		const source = Array.from(
			{ length: 513 },
			(_, i) => `export function f${i}(): number {\n\treturn ${i};\n}\n`,
		).join("");
		const table = await measureFunctionTable("/virtual/many.ts", source);
		expect(table?.size).toBe(512);
		expect(table?.has("f0")).toBe(true);
		expect(table?.has("f511")).toBe(true);
		expect(table?.has("f512")).toBe(false);
	});

	// #5087 Qodo: keying is superlinear in the function count (dense 26k
	// functions: 256 KiB 430 ms, 512 KiB 1.4 s, 1 MiB 5 s, no event-loop tick),
	// so input over 256 KiB is not measured.
	it("measures a file at the 262144-byte cap and not one byte over", async () => {
		const pad = (bytes: number) => {
			const body = "export function f(): number {\n\treturn 1;\n}\n";
			return `${body}// ${"x".repeat(bytes - body.length - 4)}\n`;
		};
		expect(pad(262144).length).toBe(262144);
		expect(
			(await measureFunctionTable("/virtual/at.ts", pad(262144)))?.size,
		).toBe(1);
		expect(
			await measureFunctionTable("/virtual/over.ts", pad(262145)),
		).toBeUndefined();
	});

	it("records an over-cap file once, and judges nothing", async () => {
		const file = write("src/big.ts", fn("handle", 3));
		commit();
		const { store, baseline } = await touched(file);
		fs.writeFileSync(file, `${fn("handle", 17)}// ${"x".repeat(262144)}\n`);
		for (let i = 0; i < 2; i++) {
			const verdict = await adviseOnEdit({
				filePath: file,
				store,
				session: writes,
				thresholds: THRESHOLDS,
			});
			expect(verdict).toBeUndefined();
		}
		expect(store.get(complexityBaselineKey(file))).toBe(baseline);
		expect(
			getDegradationSummary().filter(
				(entry) => entry.kind === "complexity-delta-failed",
			),
		).toHaveLength(1);
	});

	// #5087 F8: an abort during the git read was cached as
	// `not-a-git-repository`, so the file was judged "vs session start" for the
	// rest of the session and the line still rendered.
	it("stores nothing and says nothing when the edit is aborted during the git read", async () => {
		const file = write("src/svc.ts", fn("handle", 3));
		commit();
		const { store, baseline } = await touched(file);
		fs.writeFileSync(file, fn("handle", 17));
		const controller = new AbortController();
		spawnProbe.before = () => controller.abort();
		const verdict = await adviseOnEdit({
			filePath: file,
			store,
			session: writes,
			thresholds: THRESHOLDS,
			signal: controller.signal,
		});
		expect(verdict).toBeUndefined();
		expect(store.get(complexityBaselineKey(file))).toBe(baseline);
	});

	it("names a git that timed out or could not start, not a missing repository", async () => {
		const file = write("src/svc.ts", fn("handle", 3));
		commit();
		const answer = (failure: string) => () => ({
			stdout: "",
			stderr: "",
			status: null,
			failure,
		});
		spawnProbe.answer = answer("timeout");
		expect(await readAtDefaultBranch(file)).toEqual({
			kind: "unavailable",
			reason: "git-timeout",
		});
		spawnProbe.answer = (args) =>
			args[0] === "show" ? answer("spawn")() : undefined;
		expect(await readAtDefaultBranch(file)).toEqual({
			kind: "unavailable",
			reason: "git-spawn",
		});
	});
});
