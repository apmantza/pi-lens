/**
 * #3428: the whole-project scan read madge's `--circular --json` cycle ARRAY as
 * a dependency GRAPH.
 *
 * `runScanProject` iterated `Object.entries(data)`, so for madge's real output
 * (`[["src/a.ts", "src/b.ts"]]`) the "file" it anchored each finding at was the
 * array INDEX: every `lens_diagnostics mode=full` circular-dependency warning
 * pointed at `<root>/0` — a path that does not exist — and `publishState`
 * seeded the shared circular-file set with it. The cycle COUNT was right by
 * accident (one entry per cycle either way), which is why it went unnoticed.
 *
 * Recurrence these tests prevent: a SECOND reader of one external tool's
 * contract drifting from the first. `runMadgeSpawn` has read the array shape
 * correctly since #766, 340 lines away in the same file; both now go through
 * one `parseMadgeCycles`, and a future divergence has to red here.
 *
 * The bytes are not invented. Both cases replay a fixture captured from madge
 * 8.0.0 — `~/.pi-lens/tools/node_modules/madge`, the managed install
 * `DependencyChecker` itself resolves — driven with `buildMadgeArgs`'s own
 * argv, and each case asserts the client still spawns that argv, so the
 * captured bytes cannot stay evidence for an invocation the client abandoned.
 * See `tests/fixtures/madge-scan/`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { circularDepsToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/madge.js";
import { removeTempDirSync } from "./test-utils.js";

const safeSpawnAsync = vi.fn();
const findNodeToolBinary = vi.fn();
const ensureTool = vi.fn();

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));
vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/package-manager.js")
	>()),
	findNodeToolBinary,
}));
vi.mock("../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/installer/index.js")
	>()),
	// No managed install and no installer work: this suite is about the PARSE,
	// and resolution is pinned by dependency-checker-madge-resolution.test.ts.
	findManagedToolBinary: vi.fn(async () => undefined),
	ensureTool,
	getManagedToolsDir: () => path.join(os.tmpdir(), "pilens-fake-home", "tools"),
	isSpawnableCommand: vi.fn(async () => true),
}));

const FIXTURE_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../fixtures/madge-scan",
);

interface MadgeCapture {
	provenance: { argv: string[] };
	exitCode: number;
	stdout: string;
	stderr: string;
}

function loadCapture(caseName: string): MadgeCapture {
	return JSON.parse(
		fs.readFileSync(
			path.join(FIXTURE_DIR, `${caseName}.captured.json`),
			"utf8",
		),
	);
}

/** The captured argv with the recorded workspace token bound to `root`. */
function recordedArgv(capture: MadgeCapture, root: string): string[] {
	return capture.provenance.argv.map((token) =>
		token.split("__WORKSPACE__").join(root),
	);
}

const VERSION_OK = {
	status: 0,
	error: null,
	stdout: "madge 8.0.0",
	stderr: "",
};

describe("DependencyChecker.scanProject reads madge's cycle array (#3428)", () => {
	let tmp: string;

	beforeEach(() => {
		vi.resetAllMocks();
		tmp = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pilens-madge-scan-")),
		);
		findNodeToolBinary.mockResolvedValue("madge");
		ensureTool.mockResolvedValue(undefined);
	});

	afterEach(() => {
		removeTempDirSync(tmp);
	});

	/**
	 * The workspace the fixtures were captured against: a top-level entry file
	 * plus a nested two-file cycle and one orphan. Nested on purpose — a cycle
	 * at the project root would resolve to the same absolute path whether the
	 * base is the scanned root or the extension host's cwd.
	 */
	function writeCapturedWorkspace(): void {
		fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, "index.ts"),
			'import { a } from "./src/a.js";\nexport const entry = a;\n',
		);
		fs.writeFileSync(
			path.join(tmp, "src", "a.ts"),
			'import { b } from "./b.js";\nexport const a = () => b();\n',
		);
		fs.writeFileSync(
			path.join(tmp, "src", "b.ts"),
			'import { a } from "./a.js";\nexport const b = () => a;\n',
		);
		fs.writeFileSync(
			path.join(tmp, "src", "orphan.ts"),
			"export const orphan = 1;\n",
		);
		fs.writeFileSync(
			path.join(tmp, "tsconfig.json"),
			'{ "compilerOptions": { "module": "nodenext", "target": "es2022" } }\n',
		);
	}

	/** Answer the version probe, then replay the captured scan bytes. */
	function replay(capture: MadgeCapture): void {
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "--version") return VERSION_OK;
			return {
				status: capture.exitCode,
				error: null,
				stdout: capture.stdout,
				stderr: capture.stderr,
			};
		});
	}

	/** The scan spawn's argv, excluding `ensureAvailable`'s version probe. */
	function scanArgv(): string[] {
		const call = safeSpawnAsync.mock.calls.find(
			(c) => (c[1] as string[])[0] !== "--version",
		);
		return (call?.[1] ?? []) as string[];
	}

	it("anchors each cycle at a real file, not the cycle's array index", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		writeCapturedWorkspace();
		const capture = loadCapture("circular-two-file");
		// madge exits 1 precisely BECAUSE it found a cycle (bin/cli.js:266-267),
		// so the findings have to survive a nonzero exit: neither reader looks at
		// `status`, only at `result.error`.
		expect(capture.exitCode).toBe(1);
		replay(capture);

		const checker = new DependencyChecker();
		const result = await checker.scanProject(tmp);

		// The captured bytes are evidence about THIS client only while it still
		// asks madge for them the same way.
		expect(scanArgv()).toEqual(recordedArgv(capture, tmp));

		const a = path.join(tmp, "src", "a.ts");
		const b = path.join(tmp, "src", "b.ts");
		expect(result.count).toBe(1);
		expect(result.analyzed).toBe(true);
		expect(result.circular).toEqual([{ file: a, path: [a, b] }]);

		// The published shared state the issue named: `publishState` used to seed
		// the circular-file set with `<root>/0`.
		expect(checker.isInCircular(a)).toBe(true);
		expect(checker.isInCircular(b)).toBe(true);
		expect(checker.isInCircular(path.join(tmp, "0"))).toBe(false);

		// The user-visible effect, through the same adapter `mode=full` uses.
		// Every anchored file must EXIST — the pre-fix `<root>/0` did not.
		const diags = circularDepsToProjectDiagnostics(tmp, result.circular);
		expect(diags.map((d) => d.filePath).sort()).toEqual([a, b]);
		expect(diags.filter((d) => !fs.existsSync(d.filePath))).toEqual([]);
		expect(diags.map((d) => d.message)).toEqual([
			"Part of circular dependency: a.ts → b.ts → a.ts",
			"Part of circular dependency: a.ts → b.ts → a.ts",
		]);
	});

	it("resolves cycle members against the scanned root, not the host's cwd", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		writeCapturedWorkspace();
		const capture = loadCapture("circular-two-file");
		replay(capture);

		const result = await new DependencyChecker().scanProject(tmp);

		// madge prints cycle members relative to its TARGET directory (measured:
		// `src/a.ts` for `--json <root>`), and the scan's target is the root it
		// was asked to scan — never the extension host's `process.cwd()`, which
		// is where `path.resolve(file)` would have put them.
		expect(
			result.circular.flatMap((dep) =>
				dep.path.map((f) => path.relative(tmp, f).split(path.sep).join("/")),
			),
		).toEqual(["src/a.ts", "src/b.ts"]);
		expect(result.circular.every((dep) => path.isAbsolute(dep.file))).toBe(
			true,
		);
	});

	it("reports no cycles for graph-shaped output, and still counts as analysed", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		writeCapturedWorkspace();
		const capture = loadCapture("graph-without-circular");
		replay(capture);

		// The graph object is what `--json` prints WITHOUT `--circular`; no argv
		// `buildMadgeArgs` can build yields it. A reader that treats it as a
		// cycle array must still hand back an ANALYSED empty result, because
		// `mode=full` reads a non-analysed madge result as a cold lane (#2154),
		// not as "no cycles".
		const result = await new DependencyChecker().scanProject(tmp);
		expect(result.count).toBe(0);
		expect(result.circular).toEqual([]);
		expect(result.analyzed).toBe(true);
	});

	it("treats empty stdout as a completed scan with no cycles", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		writeCapturedWorkspace();
		// Not red pre-fix: both readers already defaulted empty stdout to a
		// parseable literal. It pins the `stdout || "[]"` fallback the fold now
		// owns for BOTH callers — without it `JSON.parse("")` throws and a
		// completed scan degrades into a cold madge lane.
		replay({
			provenance: { argv: [] },
			exitCode: 0,
			stdout: "",
			stderr: "",
		});

		const result = await new DependencyChecker().scanProject(tmp);
		expect(result.count).toBe(0);
		expect(result.analyzed).toBe(true);
	});

	it("leaves a malformed-JSON scan unanalysed rather than calling it cycle-free", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		writeCapturedWorkspace();
		// The other direction of the same fallback: bytes that are not JSON must
		// stay a FAILED scan (#2154 — `analyzed !== true` is a cold lane), so the
		// shared reader must keep throwing instead of swallowing the parse error.
		replay({
			provenance: { argv: [] },
			exitCode: 0,
			stdout: "Cannot find module 'madge'\n",
			stderr: "",
		});

		const result = await new DependencyChecker().scanProject(tmp);
		expect(result.count).toBe(0);
		expect(result.analyzed).toBeUndefined();
	});

	// #3600: the widget's stale gate judges a folded madge row against the time
	// the scan READ the import graph. `runScanProject` stamps at its top, before
	// the spawn; advancing the faked clock inside the scan spawn proves the stamp
	// is the pre-spawn read time, not the parse/return-site clock.
	it("stamps scannedAt at the run body, before madge reads the graph (#3600)", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		writeCapturedWorkspace();
		const capture = loadCapture("circular-two-file");
		const T0 = 1_900_000_000_000;
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T0);
		try {
			safeSpawnAsync.mockImplementation(
				async (_cmd: string, args: string[]) => {
					if (args[0] === "--version") return VERSION_OK;
					// The scan has now read; a stamp taken after this would be later.
					vi.setSystemTime(T0 + 2_000);
					return {
						status: capture.exitCode,
						error: null,
						stdout: capture.stdout,
						stderr: capture.stderr,
					};
				},
			);

			const result = await new DependencyChecker().scanProject(tmp);

			expect(result.analyzed).toBe(true);
			expect(result.scannedAt).toBe(new Date(T0).toISOString());
		} finally {
			vi.useRealTimers();
		}
	});
});

/**
 * #5446: the `scanProject` root gate answered "does this root hold source
 * madge reads?" with its own hand-spelled `/\.(ts|tsx|js|jsx)$/`, a second
 * list beside `buildMadgeArgs`'s `--extensions`. Widening the gate to
 * `.mts`/`.cts` (round 1) made it admit roots madge 8.0.0 cannot read: a
 * genuine `a.mts` <-> `b.mts` cycle came back `{circular: [], count: 0,
 * analyzed: true}`, a false clean that retires saved madge findings
 * (project-diagnostics/fresh-fetch.ts). One `MADGE_EXTENSIONS` constant now
 * feeds both the argv and the gate; this suite pins that the gate admits
 * exactly the extensions the argv hands madge, and that declarations stay
 * out. Shares this file's availability/spawn mocks (process boundaries
 * only); the gate itself is the real `scanProject`.
 */
describe("DependencyChecker.scanProject root gate admits exactly what madge reads (#5446)", () => {
	let tmp: string;

	beforeEach(() => {
		vi.resetAllMocks();
		tmp = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5446-root-gate-")),
		);
		findNodeToolBinary.mockResolvedValue("madge");
		ensureTool.mockResolvedValue(undefined);
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "--version") return VERSION_OK;
			return { status: 0, error: null, stdout: "[]", stderr: "" };
		});
	});

	afterEach(() => {
		removeTempDirSync(tmp);
	});

	function writeRootFiles(names: string[]): void {
		for (const name of names) {
			fs.writeFileSync(path.join(tmp, name), "export const a = 1;\n");
		}
	}

	function scanSpawns(): unknown[] {
		return safeSpawnAsync.mock.calls.filter(
			(c) => (c[1] as string[])[0] !== "--version",
		);
	}

	it("does NOT analyse a root whose only sources are .mts/.cts (#5446)", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		writeRootFiles(["index.mts", "dep.mts", "types.cts"]);

		const result = await new DependencyChecker().scanProject(tmp);

		// madge 8.0.0 finds no cycle in .mts/.cts, so `analyzed: true` would
		// be a false clean. The gate returns the un-analysed empty shape and
		// never pays the probe or the scan.
		expect(result.analyzed).toBeFalsy();
		expect(result.count).toBe(0);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});

	it("analyses a root whose only source is .mjs (#5446)", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		writeRootFiles(["index.mjs", "dep.mjs"]);

		const result = await new DependencyChecker().scanProject(tmp);

		expect(result.analyzed).toBe(true);
		expect(scanSpawns()).toHaveLength(1);
	});

	it("gate admits every extension buildMadgeArgs hands madge, and nothing else (#5446)", async () => {
		const { DependencyChecker, buildMadgeArgs } =
			await import("../../clients/dependency-checker.js");
		const argv = buildMadgeArgs(tmp, tmp);
		const handed = argv[argv.indexOf("--extensions") + 1].split(",");
		expect(handed.length).toBeGreaterThan(0);

		for (const ext of new Set([...handed, "mjs", "cjs", "mts", "cts", "py"])) {
			safeSpawnAsync.mockClear();
			const root = path.join(tmp, `root-${ext}`);
			fs.mkdirSync(root);
			fs.writeFileSync(path.join(root, `index.${ext}`), "x\n");
			const result = await new DependencyChecker().scanProject(root);
			expect(result.analyzed === true, `.${ext}`).toBe(handed.includes(ext));
		}
	});

	it("skips a root whose only JS/TS files are ambient declarations (#5446)", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		writeRootFiles(["types.d.ts", "types.d.mts", "types.d.cts"]);

		const result = await new DependencyChecker().scanProject(tmp);

		expect(result.analyzed).toBeFalsy();
		expect(result.count).toBe(0);
		// No scan spawn: a gated root must not even pay the probe.
		expect(scanSpawns()).toHaveLength(0);
	});
});
