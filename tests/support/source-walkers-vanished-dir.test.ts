import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getWin32GateFiles } from "../../scripts/lib/win32-gate-population.mjs";
import { testSourceFiles } from "./module-instance-scan.js";
import { clientSourceFiles } from "./session-state-scan.js";

/**
 * Named recurrence (#4104, sibling of #4097): a directory that a sibling
 * process removes between its parent's listing and its own `readdirSync`
 * killed any repo walker that did not go through the shared one. `afterList`
 * runs right after the next directory listing returns, so the walker holds a
 * stale entry list exactly as it does when a sibling worker removes its
 * `worker-home-*` mid-walk. `reverse` returns every listing back to front,
 * the order a filesystem is free to use.
 */
const hooks = vi.hoisted(() => ({
	afterList: undefined as (() => void) | undefined,
	reverse: false,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const readdirSync = ((...args: Parameters<typeof actual.readdirSync>) => {
		const listed = actual.readdirSync(...args);
		if (hooks.reverse && Array.isArray(listed)) listed.reverse();
		const hook = hooks.afterList;
		hooks.afterList = undefined;
		hook?.();
		return listed;
	}) as typeof actual.readdirSync;
	return { ...actual, readdirSync, default: { ...actual, readdirSync } };
});

const tmpRoots: string[] = [];
afterAll(() => {
	for (const root of tmpRoots)
		fs.rmSync(root, { recursive: true, force: true });
});

const GATE = `it.skipIf(process.platform !== "win32")("gated", () => {});\n`;

/** Four sibling directories under `<root>/<walked>`, each holding `fileName`. */
function plantSiblings(walked: string, fileName: string, body: string) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4104-walk-"));
	tmpRoots.push(root);
	const walkedRoot = path.join(root, walked);
	const names = ["d0", "d1", "d2", "d3"];
	for (const name of names) {
		fs.mkdirSync(path.join(walkedRoot, name), { recursive: true });
		fs.writeFileSync(path.join(walkedRoot, name, fileName), body);
	}
	return { root, walkedRoot, names };
}

/** Remove every sibling but `d0` right after the walk's next listing. */
function removeSiblingsAfterNextListing(walkedRoot: string, names: string[]) {
	let fired = false;
	hooks.afterList = () => {
		fired = true;
		for (const name of names.slice(1)) {
			fs.rmSync(path.join(walkedRoot, name), { recursive: true });
		}
	};
	return () => fired;
}

function walkWithVanishingSiblings(
	walked: string,
	fileName: string,
	body: string,
	walk: (root: string, walkedRoot: string) => string[],
) {
	const { root, walkedRoot, names } = plantSiblings(walked, fileName, body);
	const write = vi
		.spyOn(process.stderr, "write")
		.mockImplementation(() => true);
	try {
		const fired = removeSiblingsAfterNextListing(walkedRoot, names);
		const found = walk(root, walkedRoot);
		expect(fired()).toBe(true);
		return { found, records: write.mock.calls.map((call) => String(call[0])) };
	} finally {
		write.mockRestore();
		hooks.afterList = undefined;
	}
}

describe("repo walkers tolerate a directory that vanished mid-walk (#4104)", () => {
	it("testSourceFiles skips it and records each vanished directory", () => {
		const { found, records } = walkWithVanishingSiblings(
			"tests",
			"a.test.ts",
			"",
			(_root, walkedRoot) => testSourceFiles(walkedRoot),
		);
		expect(found).toHaveLength(1);
		expect(records).toHaveLength(3);
		expect(records[0]).toMatch(/vanished between the walk and its descent/);
	});

	it("the win32 gate population skips it and records each vanished directory", () => {
		const { found, records } = walkWithVanishingSiblings(
			"tests",
			"gated.test.ts",
			GATE,
			(root) => getWin32GateFiles(root),
		);
		expect(found).toHaveLength(1);
		expect(records).toHaveLength(3);
		expect(records[0]).toMatch(
			/\[win32-gate-population\].*vanished between the walk and its descent/,
		);
	});
});

describe("folded walkers keep their populations (#4104)", () => {
	function plant(files: Record<string, string>) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4104-pop-"));
		tmpRoots.push(root);
		for (const [file, body] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			fs.writeFileSync(path.join(root, file), body);
		}
		return root;
	}
	const posix = (root: string, files: string[]) =>
		files.map((file) => path.relative(root, file).split(path.sep).join("/"));

	it("testSourceFiles keeps .ts, .mts and declarations, minus the top-level non-repo trees", () => {
		const tests = plant({
			"a.ts": "",
			"b.mts": "",
			"c.d.mts": "",
			"nested/d.test.ts": "",
			"nested/fixtures/z.ts": "",
			"n.js": "",
			"fixtures/x.ts": "",
			"native-ts7-live-1/y.ts": "",
			"native-ts7-live-2.ts": "",
			"nested/node_modules/m.ts": "",
		});
		expect(posix(tests, testSourceFiles(tests))).toEqual([
			"a.ts",
			"b.mts",
			"c.d.mts",
			"nested/d.test.ts",
			"nested/fixtures/z.ts",
		]);
	});

	it("the win32 gate population reads real .test.ts files only, outside scratch trees", () => {
		const root = plant({
			"tests/a.test.ts": GATE,
			"tests/b.test.mts": GATE,
			"tests/node_modules/n.test.ts": GATE,
			"tests/fixtures/f.test.ts": GATE,
		});
		expect(getWin32GateFiles(root)).toEqual(["tests/a.test.ts"]);
	});

	it("clientSourceFiles (the atomic-write scan's walker) keeps .ts, drops declarations and tests", () => {
		const clients = plant({
			"a.ts": "",
			"b.d.ts": "",
			"c.test.ts": "",
			"nested/d.ts": "",
			"nested/e.mjs": "",
		});
		expect(posix(clients, clientSourceFiles(clients))).toEqual([
			"a.ts",
			"nested/d.ts",
		]);
	});

	it("every folded walker returns sorted paths whatever order the filesystem lists", () => {
		const tests = plant({
			"b.ts": "",
			"a/z.ts": "",
			"a/y.ts": "",
			"c.ts": "",
		});
		const gates = plant({
			"tests/b.test.ts": GATE,
			"tests/a/z.test.ts": GATE,
			"tests/c.test.ts": GATE,
		});
		hooks.reverse = true;
		try {
			expect(posix(tests, testSourceFiles(tests))).toEqual([
				"a/y.ts",
				"a/z.ts",
				"b.ts",
				"c.ts",
			]);
			expect(posix(tests, clientSourceFiles(tests))).toEqual([
				"a/y.ts",
				"a/z.ts",
				"b.ts",
				"c.ts",
			]);
			expect(getWin32GateFiles(gates)).toEqual([
				"tests/a/z.test.ts",
				"tests/b.test.ts",
				"tests/c.test.ts",
			]);
		} finally {
			hooks.reverse = false;
		}
	});

	it.skipIf(process.platform === "win32")(
		"the win32 gate population skips a symlink named like a test file",
		() => {
			const root = plant({ "tests/a.test.ts": GATE });
			fs.symlinkSync(
				path.join(root, "tests/a.test.ts"),
				path.join(root, "tests/link.test.ts"),
			);
			expect(getWin32GateFiles(root)).toEqual(["tests/a.test.ts"]);
		},
	);
});
