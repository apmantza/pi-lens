// flake-shape: service-double — #5055: a language server cannot be spawned in this lane; the review graph, its name resolver, the cascade compute and the neighbour selection are real, and only the server's answer is a double
/**
 * #5055: a dependent the graph could not resolve is never reported as a leaf.
 *
 * The recurrence: the #5054 review (F2) found that a Java caller with no import
 * statement reaches the cascade through a resolved `references` edge
 * (`neighborCount 1`), and that adding ONE more class defining the same method
 * name leaves the reference unresolved (`resolveDeferredSymbolEdges` keeps a
 * name with 2+ candidates on its `symbol-name:` placeholder). The caller then
 * dropped out of the cascade and the run read `skipReason: "no_neighbors"`, the
 * same verdict a true leaf gets, which `integration.ts` itself calls "the exact
 * silent all-clear". The rule is graph-wide: every kind below reproduced it on
 * master through the real graph and `computeCascadeForFile`.
 *
 * Each case builds the dependent the way the kind really does it without an
 * import edge the graph can follow (a TypeScript barrel re-export, a Ruby
 * autoloaded constant, a Rust `use` of a sibling module, a C forward
 * declaration, a Python builtins-injected name), edits the exporter and asks
 * for the cascade twice: once with a unique definition (resolves, a neighbour)
 * and once with a second same-named definition elsewhere (unresolved).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toPosix } from "../../clients/path-utils.js";
import { setupTestEnvironment } from "./test-utils.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";

interface KindCase {
	kind: string;
	files: Record<string, string>;
	/** The exporter's edit: [file, before, after]. */
	edit: [string, string, string];
	/** The dependent the graph reaches only by name. */
	dependent: string;
	/** The second definition of the same name, which makes the name ambiguous. */
	second: Record<string, string>;
}

const KINDS: KindCase[] = [
	{
		kind: "jsts (barrel re-export)",
		files: {
			"lib.ts": "export function foo(x: number) { return x; }\n",
			"index.ts": 'export * from "./lib";\n',
			"app.ts":
				'import { foo } from "./index";\nexport function run() { return foo(1); }\n',
		},
		edit: ["lib.ts", "foo(x: number)", "foo(x: string)"],
		dependent: "app.ts",
		second: { "other.ts": "export function foo() { return 0; }\n" },
	},
	{
		kind: "python (builtins-injected name)",
		files: {
			"lib.py": "def foo(x):\n    return x\n",
			"app.py": "def run():\n    return foo(1)\n",
		},
		edit: ["lib.py", "def foo(x):", "def foo(x, y):"],
		dependent: "app.py",
		second: { "other.py": "def foo():\n    return 0\n" },
	},
	{
		kind: "ruby (autoloaded constant)",
		files: {
			"lib.rb": "class Lib\n  def self.foo(x)\n    x\n  end\nend\n",
			"app.rb": "class App\n  def run\n    Lib.foo(1)\n  end\nend\n",
		},
		edit: ["lib.rb", "def self.foo(x)", "def self.foo(x, y)"],
		dependent: "app.rb",
		second: { "other.rb": "class Other\n  def self.foo\n    0\n  end\nend\n" },
	},
	{
		kind: "rust (use of a sibling module)",
		files: {
			"Cargo.toml": '[package]\nname = "ex"\nversion = "0.1.0"\n',
			"src/main.rs": "mod lib;\nmod app;\nfn main() {}\n",
			"src/lib.rs": "pub fn foo(x: i32) -> i32 { x }\n",
			"src/app.rs": "use crate::lib::foo;\npub fn run() -> i32 { foo(1) }\n",
		},
		edit: ["src/lib.rs", "foo(x: i32)", "foo(x: String)"],
		dependent: "src/app.rs",
		second: { "src/other.rs": "pub fn foo() -> i32 { 0 }\n" },
	},
	{
		kind: "cxx (forward declaration)",
		files: {
			"lib.cpp": "int foo(int x) { return x; }\n",
			"app.cpp": "int foo(int x);\nint run() { return foo(1); }\n",
		},
		edit: ["lib.cpp", "int foo(int x) {", "int foo(int x, int y) {"],
		dependent: "app.cpp",
		second: { "other.cpp": "int foo() { return 0; }\n" },
	},
	{
		// The issue's own repro (#5054 review F2): a same-package caller needs no
		// import statement, so only the name reaches the exporter.
		kind: "java (same-package caller, no import)",
		files: {
			"src/p/Lib.java":
				"package p;\n\npublic class Lib {\n  public static int foo(int x) { return x; }\n}\n",
			"src/p/App.java":
				"package p;\n\npublic class App {\n  int run() { return Lib.foo(1); }\n}\n",
		},
		edit: ["src/p/Lib.java", "int foo(int x)", "int foo(int x, int y)"],
		dependent: "src/p/App.java",
		second: {
			"src/p/Other.java":
				"package p;\n\npublic class Other {\n  public static int foo() { return 0; }\n}\n",
		},
	},
];

async function cascadeAfterEdit(
	c: KindCase,
	extra: Record<string, string>,
	without: string[] = [],
	/** Runs before the exporter's edit, with a way to ask for another file's cascade. */
	beforeEdit?: (
		cascade: (file: string) => Promise<unknown>,
		dir: string,
	) => Promise<void>,
	/** The runtime's seq state; with it the graph build can take the seq fast path. */
	seqState?: { projectSeq: () => number; getFilesChangedSince: () => string[] },
) {
	const env = setupTestEnvironment("cascade-ambiguous-ref-");
	try {
		const files = { ...c.files, ...extra };
		for (const drop of without) delete files[drop];
		for (const [rel, body] of Object.entries(files)) {
			const p = path.join(env.tmpDir, rel);
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.writeFileSync(p, body);
		}
		const touched: string[] = [];
		await installLspServiceDouble({
			shutdown: vi.fn(async () => {}),
			touchFile: vi.fn(async (file: string) => {
				touched.push(toPosix(path.relative(env.tmpDir, file)));
				return { diags: [] };
			}),
		});
		const { computeCascadeForFile } =
			await import("../../clients/dispatch/integration.js");
		await beforeEdit?.(
			(file) =>
				computeCascadeForFile(file, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
					projectRoot: env.tmpDir,
					seqState,
				}),
			env.tmpDir,
		);
		const [rel, from, to] = c.edit;
		const target = path.join(env.tmpDir, rel);
		fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(from, to));
		const run = await computeCascadeForFile(target, env.tmpDir, {
			turnSeq: 1,
			writeSeq: 1,
			projectRoot: env.tmpDir,
			seqState,
		});
		return { run, touched };
	} finally {
		env.cleanup();
	}
}

describe("a dependent reached by name alone (#5055)", () => {
	beforeEach(async () => {
		vi.resetModules();
		const { resetDispatchBaselines } =
			await import("../../clients/dispatch/integration.js");
		resetDispatchBaselines();
	}, 30_000);

	for (const c of KINDS) {
		describe(c.kind, () => {
			it("control: a unique definition resolves the reference and the dependent is a neighbour", async () => {
				const { run, touched } = await cascadeAfterEdit(c, {});
				expect(run.skipReason).toBe("clean");
				expect(run.neighborCount).toBe(1);
				expect(touched).toEqual([c.dependent]);
			}, 60_000);

			it("a second same-named definition leaves the name ambiguous: the run is indeterminate, never no_neighbors", async () => {
				const { run } = await cascadeAfterEdit(c, c.second);
				expect(run.skipReason).toBe("indeterminate");
				expect(run.indeterminate?.reason).toBe("unresolved_reference");
				expect(run.indeterminate?.unplacedReferrerCount).toBe(1);
				expect(run.indeterminate?.detail).toContain(c.dependent);
				expect(run.neighborCount).toBe(0);
			}, 60_000);

			it("a healthy leaf still reads no_neighbors: the same second definition with no dependent", async () => {
				const { run } = await cascadeAfterEdit(c, c.second, [
					c.dependent,
					// The barrel has no other reader once its only importer is gone.
					...Object.keys(c.files).filter((f) => f === "index.ts"),
				]);
				expect(run.skipReason).toBe("no_neighbors");
				expect(run.indeterminate).toBeUndefined();
			}, 60_000);
		});
	}

	// Recurrence: the over-correction #1023 names. Flagging every unplaced
	// bare-name call on a run that already has neighbours marked 185 of 515
	// files of this repo's own graph (common local names such as `resolve`,
	// `reset`, `run`), so the marker is gated on the run that would read
	// `no_neighbors`. The run below has a resolved neighbour AND an unplaced one.
	it("a run that already has a neighbour does not carry the marker for an unplaced one", async () => {
		const c = KINDS[0];
		const { run, touched } = await cascadeAfterEdit(c, {
			...c.second,
			// Imports the exporter directly: the import hint resolves it.
			"direct.ts":
				'import { foo } from "./lib";\nexport function use() { return foo(1); }\n',
		});
		expect(touched).toEqual(["direct.ts"]);
		expect(run.skipReason).toBe("clean");
		expect(run.indeterminate).toBeUndefined();
	}, 60_000);

	// Recurrence: a referrer edited in the same turn is the cascade's own
	// primary (B10): its dispatch run is the authoritative answer, so naming it
	// as an unproven dependent would double-report a file pi is already checking.
	it("a referrer edited in the same turn is accounted for: the run still reads no_neighbors", async () => {
		const c = KINDS[0];
		const { run } = await cascadeAfterEdit(
			c,
			c.second,
			[],
			async (cascade, dir) => {
				// The agent edited the dependent first; its own cascade run marks it primary.
				await cascade(path.join(dir, c.dependent));
			},
		);
		expect(run.skipReason).toBe("no_neighbors");
		expect(run.indeterminate).toBeUndefined();
	}, 60_000);

	// Recurrence: the exporter's own recursion. Its call to the changed symbol
	// also stays on the name-only placeholder once a second definition exists,
	// and a changed file is never its own dependent.
	it("a changed file's own recursive call is not an unplaced dependent: the run still reads no_neighbors", async () => {
		const c: KindCase = {
			...KINDS[0],
			files: {
				"lib.ts":
					"export function foo(x: number): number { return x > 0 ? foo(x - 1) : 0; }\n",
			},
		};
		const { run } = await cascadeAfterEdit(c, c.second);
		expect(run.skipReason).toBe("no_neighbors");
		expect(run.indeterminate).toBeUndefined();
	}, 60_000);

	// Recurrence: the advisory named only the edited file, so the agent could not
	// act, and logged no count, so the live flip rate was unreadable (#5070
	// review F6). Five unplaced files show the bound: three named, two counted.
	it("names up to three unplaced files and counts the rest", async () => {
		const c = KINDS[0];
		const apps = Object.fromEntries(
			[1, 2, 3, 4, 5].map((n) => [
				`app${n}.ts`,
				'import { foo } from "./index";\nexport function run() { return foo(1); }\n',
			]),
		);
		const { run } = await cascadeAfterEdit(
			{ ...c, files: { ...c.files, ...apps } },
			c.second,
			["app.ts"],
		);
		expect(run.skipReason).toBe("indeterminate");
		expect(run.indeterminate?.unplacedReferrerCount).toBe(5);
		const detail = run.indeterminate?.detail ?? "";
		expect(detail).toContain("app1.ts, app2.ts, app3.ts (+2 more)");
		expect(detail).not.toContain("app4.ts");
	}, 60_000);

	// Recurrence: the lookup is bounded to the CHANGED symbols. Widening it to
	// every symbol of the file flipped a leaf edit on an unrelated name that
	// collides elsewhere (#5070 review F5). The changed-symbol set comes from the
	// dispatch entity diff (`recordEntitySnapshotDiff`), which the cascade alone
	// cannot supply, so this reads the real graph's impact query directly.
	it("the impact query names referrers only of the changed symbols", async () => {
		const env = setupTestEnvironment("cascade-ambiguous-narrow-");
		try {
			const c = KINDS[0];
			const files: Record<string, string> = {
				...c.files,
				...c.second,
				"lib.ts":
					"export function foo(x: number) { return x; }\nexport function bar(x: number) { return x; }\n",
			};
			for (const [rel, body] of Object.entries(files))
				fs.writeFileSync(path.join(env.tmpDir, rel), body);
			const { buildOrUpdateGraph } =
				await import("../../clients/review-graph/builder.js");
			const { computeImpactCascade } =
				await import("../../clients/review-graph/query.js");
			const { FactStore } =
				await import("../../clients/dispatch/fact-store.js");
			const lib = path.join(env.tmpDir, "lib.ts");
			const app = path.join(env.tmpDir, "app.ts");
			const graph = await buildOrUpdateGraph(
				env.tmpDir,
				[lib],
				new FactStore(),
			);
			const key = [...graph.fileNodes.keys()].find((k) =>
				k.endsWith("lib.ts"),
			)!;

			graph.changedSymbolsByFile.set(key, ["bar"]);
			expect(
				computeImpactCascade(graph, lib).nameOnlyReferrers,
			).toBeUndefined();

			graph.changedSymbolsByFile.set(key, ["foo"]);
			expect(
				computeImpactCascade(graph, lib).nameOnlyReferrers?.map((f) =>
					path.resolve(f),
				),
			).toEqual([path.resolve(app)]);
		} finally {
			env.cleanup();
		}
	}, 60_000);

	// Recurrence (#5070 review, bot threads): the placeholder lookup took its
	// names from the symbol nodes that SURVIVE the edit, so a renamed or deleted
	// definition (the issue's own population: its callers lose their target)
	// left its callers unnamed and the run read no_neighbors. The changed names
	// come from the real dispatch diff (`recordEntitySnapshotDiff`), removed
	// names included.
	it.each([
		{ edit: "rename", after: "export function bar(x: number) { return x; }\n" },
		{ edit: "delete", after: "export const unrelated = 1;\n" },
	])(
		"a $edit of an ambiguous definition still names the callers left on its placeholder",
		async ({ after }) => {
			const env = setupTestEnvironment("cascade-ambiguous-removed-");
			try {
				const c = KINDS[0];
				const files: Record<string, string> = {
					...c.files,
					...c.second,
					"third.ts": "export function foo() { return 1; }\n",
				};
				for (const [rel, body] of Object.entries(files))
					fs.writeFileSync(path.join(env.tmpDir, rel), body);
				const { buildOrUpdateGraph } =
					await import("../../clients/review-graph/builder.js");
				const { computeImpactCascade, recordEntitySnapshotDiff } =
					await import("../../clients/review-graph/service.js");
				const { FactStore } =
					await import("../../clients/dispatch/fact-store.js");
				const facts = new FactStore();
				const lib = path.join(env.tmpDir, "lib.ts");
				const app = path.join(env.tmpDir, "app.ts");
				await buildOrUpdateGraph(env.tmpDir, [lib], facts);
				recordEntitySnapshotDiff(
					facts,
					lib,
					new Map([["function:foo:1", "a"]]),
				);
				fs.writeFileSync(lib, after);
				const next = new Map<string, string>(
					after.includes("function bar")
						? [["function:bar:1", "b"]]
						: [["const:unrelated:1", "b"]],
				);
				recordEntitySnapshotDiff(facts, lib, next);
				const graph = await buildOrUpdateGraph(env.tmpDir, [lib], facts);
				expect(
					computeImpactCascade(graph, lib).nameOnlyReferrers?.map((f) =>
						path.resolve(f),
					),
				).toEqual([path.resolve(app)]);
			} finally {
				env.cleanup();
			}
		},
		60_000,
	);

	// Refutation pin for the "deleted caller" bot thread (#5070): the graph holds
	// the dependent when the exporter is first checked, then the dependent is
	// removed outside pi before the exporter's next edit. The graph drops a
	// deleted file on its next build, so no stale caller is named; the control
	// without the removal shows the dependent really was in the graph.
	it.each([
		{ removed: false, skipReason: "indeterminate" },
		{ removed: true, skipReason: "no_neighbors" },
	])(
		"a dependent removed outside pi: removed=$removed reads $skipReason",
		async ({ removed, skipReason }) => {
			const c = KINDS[0];
			const { run } = await cascadeAfterEdit(
				c,
				c.second,
				[],
				async (cascade, dir) => {
					await cascade(path.join(dir, "lib.ts"));
					if (removed) fs.rmSync(path.join(dir, c.dependent));
				},
			);
			expect(run.skipReason).toBe(skipReason);
		},
		60_000,
	);

	// A removal outside pi never bumps projectSeq, so the seq fast path keeps the
	// cached graph (and its edge from the removed dependent) until the periodic
	// re-verify. Without the on-disk check the run would name a file that is gone
	// (#5070 bot thread on integration.ts, "Deleted callers trigger warnings").
	it("does not name a dependent that was removed outside pi on the seq fast path", async () => {
		const c = KINDS[0];
		const seqState = { projectSeq: () => 1, getFilesChangedSince: () => [] };
		const { run } = await cascadeAfterEdit(
			c,
			c.second,
			[],
			async (cascade, dir) => {
				await cascade(path.join(dir, "lib.ts"));
				fs.rmSync(path.join(dir, c.dependent));
			},
			seqState,
		);
		expect(run.skipReason).toBe("no_neighbors");
	}, 60_000);
});
