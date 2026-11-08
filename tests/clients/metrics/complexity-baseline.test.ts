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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoundedLruCache } from "../../../clients/bounded-cache.js";
import {
	adviseOnEdit,
	captureComplexityBaseline,
	type ComplexityBaseline,
	complexityBaselineKey,
	type FunctionTable,
	formatComplexityAdvisory,
	MAX_ADVISORY_BYTES,
	readAtDefaultBranch,
	worsenedFunctions,
	type WorsenedFunction,
} from "../../../clients/metrics/complexity-baseline.js";
import {
	gitExecFileSync,
	installGitFixtureEnv,
} from "../../support/git-fixture-env.js";
import { removeTempDirSync } from "../test-utils.js";

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

	it(`stays within ${MAX_ADVISORY_BYTES} bytes and counts what it leaves out`, () => {
		const line = formatComplexityAdvisory(worse(10), "main");
		expect(line).toBeDefined();
		expect(Buffer.byteLength(line ?? "", "utf-8")).toBeLessThanOrEqual(
			MAX_ADVISORY_BYTES,
		);
		expect(line).toMatch(/; \+\d+ more$/);
	});
});

describe("the default-branch baseline in a real repository (#5087)", () => {
	let root: string;
	const git = (...args: string[]) =>
		gitExecFileSync("git", args, { cwd: root, encoding: "utf8" });

	beforeEach(() => {
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
		const baseline = await captureComplexityBaseline(file);
		expect(baseline?.main).toBeUndefined();
		store.set(complexityBaselineKey(file), baseline!);

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
		const baseline = await captureComplexityBaseline(file);
		store.set(complexityBaselineKey(file), baseline!);
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
});
