/**
 * #5410 slice 2: formatters take their binary from the runner's ladder.
 *
 * The audit's two formatter probes, run through the real formatter entry
 * points (`formatFile` and each formatter's own `resolveCommand`), the real
 * `which` latch, the real checker and the real installer lookups. Only the
 * child process (`safe-spawn`) is doubled: it answers `which`/`where` and a
 * `--version` probe from the files the test planted, and it records every
 * spawn. Installs stay off through the suite's `PI_LENS_DISABLE_TOOL_INSTALL`
 * default.
 *
 * Recurrences pinned:
 * - run-a: `findInVenv` walked up to an ancestor `.venv`, so with
 *   `~/code/.venv/bin/ruff` present and the project `~/code/app` carrying no
 *   venv, the ruff runner skipped (exactly-cwd rule, #2544 r4 F2) and the
 *   formatter ran the parent's ruff.
 * - run-f: the formatter asked `which("shfmt")` and ran whatever it named
 *   (and the same for taplo, ktlint, ktfmt, typstyle and the managed-resolver
 *   family), so a broken PATH shfmt beside a working managed one failed the
 *   formatter while the runner's ladder succeeded.
 * - order (user decision, #5492 r2): a formatter's version decides the bytes
 *   it writes, so a working PATH binary wins over the managed copy. A PATH
 *   binary that fails its version check falls through to managed; a present
 *   tool nothing else replaces reads "failed its version check" with the
 *   probe's stderr, never "executable not found".
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

const { safeSpawnAsync, spawnCalls } = vi.hoisted(() => {
	const spawnCalls: Array<{ cmd: string; args: readonly string[] }> = [];
	const safeSpawnAsync = vi.fn(
		async (cmd: string, args: readonly string[] = []) => {
			spawnCalls.push({ cmd: String(cmd), args });
			const fs = await import("node:fs");
			const path = await import("node:path");
			const onPath = (name: string): string | null => {
				for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
					if (dir && fs.existsSync(path.join(dir, name))) {
						return path.join(dir, name);
					}
				}
				return null;
			};
			if (cmd === "which" || cmd === "where") {
				const found = onPath(String(args[0]));
				return found
					? { error: null, status: 0, stdout: `${found}\n`, stderr: "" }
					: { error: null, status: 1, stdout: "", stderr: "" };
			}
			const target = path.isAbsolute(cmd) ? cmd : onPath(cmd);
			if (!target || !fs.existsSync(target)) {
				return {
					error: new Error(`spawn ${cmd} ENOENT`),
					status: null,
					stdout: "",
					stderr: "",
					spawnFailure: { kind: "tool-not-found" },
				};
			}
			// A shim whose interpreter is gone: present, rejects every call.
			if (fs.readFileSync(target, "utf8").includes("BROKEN")) {
				return { error: null, status: 1, stdout: "", stderr: "Traceback\n" };
			}
			return { error: null, status: 0, stdout: "tool 1.0.0\n", stderr: "" };
		},
	);
	return { safeSpawnAsync, spawnCalls };
});
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

const GOOD = "#!/bin/sh\nexit 0\n";
const BROKEN = "#!/bin/sh\n# BROKEN interpreter\nexit 1\n";

function plant(file: string, body: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
	fs.chmodSync(file, 0o755);
	return file;
}

let home: string;
let pathDir: string;
let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
	vi.resetModules();
	// The installer captures its bin dir at module load, so the home is pinned
	// before the fresh import each test takes. The trust latch is set AFTER the
	// reset, which re-evaluates the module graph.
	home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5410f-home-"));
	pathDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5410f-path-"));
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5410f-root-"));
	previousHome = process.env.PI_LENS_HOME;
	process.env.PI_LENS_HOME = home;
	vi.stubEnv("PATH", pathDir);
	(await import("../../clients/project-trust.js")).setProjectTrustState(
		"trusted",
	);
	spawnCalls.length = 0;
	safeSpawnAsync.mockClear();
});

afterEach(async () => {
	(await import("../../clients/project-trust.js")).resetProjectTrust();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
	for (const dir of [home, pathDir, root]) removeTempDirSync(dir);
});

describe("formatter ancestor venv (#5410 run-a)", () => {
	// The ruff runner looks in the project's own `.venv` at exactly its cwd. A
	// `.venv` in a parent directory is an unrelated sibling project's
	// interpreter and must not outrank PATH.
	it("ruff: a parent directory's .venv ruff is not the project's formatter", async () => {
		const parentRuff = plant(path.join(root, ".venv", "bin", "ruff"), GOOD);
		const app = path.join(root, "app");
		fs.mkdirSync(app, { recursive: true });
		fs.writeFileSync(path.join(app, "pyproject.toml"), "[tool.ruff]\n");
		const file = path.join(app, "main.py");
		fs.writeFileSync(file, "def f():\n    return 1\n");
		const { formatFile, ruffFormatter } =
			await import("../../clients/formatters.js");

		const result = await formatFile(file, ruffFormatter);

		expect(spawnCalls.some((call) => call.cmd === parentRuff)).toBe(false);
		expect(result.outcome).toBe("unavailable");
	});

	// Control (green on the base too): the venv the project owns still wins,
	// found from the project root the formatter spawns in even when the edited
	// file sits deeper.
	it("ruff: the project's own .venv ruff runs for a file nested under the project root", async () => {
		const app = path.join(root, "app");
		const ownRuff = plant(path.join(app, ".venv", "bin", "ruff"), GOOD);
		fs.writeFileSync(path.join(app, "pyproject.toml"), "[tool.ruff]\n");
		const nested = path.join(app, "src", "pkg");
		fs.mkdirSync(nested, { recursive: true });
		const file = path.join(nested, "main.py");
		fs.writeFileSync(file, "def f():\n    return 1\n");
		const { formatFile, ruffFormatter } =
			await import("../../clients/formatters.js");

		await formatFile(file, ruffFormatter);

		expect(
			spawnCalls
				.filter((call) => call.cmd === ownRuff)
				.map((call) => call.args[0]),
		).toContain("format");
	});

	// The formatter rides the checker's latch, so a trust grant mid-session
	// reaches it as it reaches the runners (#4530, #5437): the project's own
	// venv is refused while pi has not trusted the project and used after.
	it("ruff: the project's own .venv ruff runs once pi trusts the project mid-session", async () => {
		const app = path.join(root, "app");
		const ownRuff = plant(path.join(app, ".venv", "bin", "ruff"), GOOD);
		fs.writeFileSync(path.join(app, "pyproject.toml"), "[tool.ruff]\n");
		const file = path.join(app, "main.py");
		fs.writeFileSync(file, "def f():\n    return 1\n");
		const trust = await import("../../clients/project-trust.js");
		const { formatFile, ruffFormatter } =
			await import("../../clients/formatters.js");

		trust.setProjectTrustState("untrusted");
		await formatFile(file, ruffFormatter);
		expect(spawnCalls.some((call) => call.cmd === ownRuff)).toBe(false);

		trust.setProjectTrustState("trusted");
		await formatFile(file, ruffFormatter);
		expect(
			spawnCalls
				.filter((call) => call.cmd === ownRuff)
				.map((call) => call.args[0]),
		).toEqual(["--version", "format"]);
	});

	// Control (green on the base too): pins the sqlfluff formatter's venv rung,
	// which the shared ladder now answers.
	it("sqlfluff: the project's own .venv binary runs, found from the project root", async () => {
		const app = path.join(root, "app");
		const ownBin = plant(path.join(app, ".venv", "bin", "sqlfluff"), GOOD);
		fs.writeFileSync(path.join(app, ".sqlfluff"), "[sqlfluff]\n");
		const nested = path.join(app, "models");
		fs.mkdirSync(nested, { recursive: true });
		const file = path.join(nested, "q.sql");
		fs.writeFileSync(file, "select 1\n");
		const { sqlfluffFormatter } = await import("../../clients/formatters.js");

		const cmd = await sqlfluffFormatter.resolveCommand!(file, nested);

		expect(cmd).toEqual([ownBin, "fix", "--force", file]);
	});

	it.each([
		["black", "blackFormatter"],
		["sqlfluff", "sqlfluffFormatter"],
	] as const)(
		"%s: a parent directory's .venv binary is not resolved",
		async (tool, exportName) => {
			const parentBin = plant(path.join(root, ".venv", "bin", tool), GOOD);
			const app = path.join(root, "app");
			fs.mkdirSync(app, { recursive: true });
			fs.writeFileSync(path.join(app, "pyproject.toml"), "[tool.black]\n");
			const file = path.join(app, "main.py");
			fs.writeFileSync(file, "x = 1\n");
			const formatters = await import("../../clients/formatters.js");
			const formatter = formatters[exportName];

			const cmd = await formatter.resolveCommand!(file, app);

			expect(JSON.stringify(cmd)).not.toContain(parentBin);
			expect(cmd).toBe(formatters.FORMATTER_UNAVAILABLE);
		},
	);
});

describe("formatter binary order (#5410 run-f)", () => {
	// Each row is a tool whose formatter used to ask PATH first. `exportName`
	// is the formatter, `file` a source file with detectable indentation,
	// `managed` the release-managed binary name the installer looks for.
	const ROWS = [
		["shfmt", "shfmtFormatter", "script.sh", "if true; then\n  echo hi\nfi\n"],
		["taplo", "taploFormatter", "Cargo.toml", "[package]\nname = 'x'\n"],
		["ktlint", "ktlintFormatter", "Main.kt", "fun main() {}\n"],
		["typstyle", "typstyleFormatter", "doc.typ", "= Title\n"],
		["ktfmt", "ktfmtFormatter", "Main.kt", "fun main() {}\n"],
		[
			"google-java-format",
			"googleJavaFormatFormatter",
			"Main.java",
			"class A {}\n",
		],
		["cljfmt", "cljfmtFormatter", "core.clj", "(ns core)\n"],
		["php-cs-fixer", "phpCsFixerFormatter", "main.php", "<?php\n"],
		["stylua", "styluaFormatter", "main.lua", "local x = 1\n"],
	] as const;

	async function resolve(
		exportName: (typeof ROWS)[number][1],
		fileName: string,
		body: string,
	): Promise<string[] | string | null | undefined> {
		const project = path.join(root, "proj");
		fs.mkdirSync(project, { recursive: true });
		const file = path.join(project, fileName);
		fs.writeFileSync(file, body);
		const formatters = await import("../../clients/formatters.js");
		return formatters[exportName].resolveCommand!(file, project);
	}

	it.each(ROWS)(
		"%s: a broken PATH binary does not shadow the working managed one",
		async (tool, exportName, fileName, body) => {
			plant(path.join(pathDir, tool), BROKEN);
			const managed = plant(path.join(home, "bin", tool), GOOD);

			const cmd = await resolve(exportName, fileName, body);

			expect(Array.isArray(cmd) ? cmd[0] : cmd).toBe(managed);
		},
	);

	// Order rule (#5492 r2, user decision): the formatter's version decides its
	// output bytes, so a working PATH binary is the one that runs even when a
	// managed copy exists. Runners keep managed before PATH.
	it.each(ROWS)(
		"%s: a working PATH binary outranks the managed one",
		async (tool, exportName, fileName, body) => {
			plant(path.join(pathDir, tool), GOOD);
			const managed = plant(path.join(home, "bin", tool), GOOD);

			const cmd = await resolve(exportName, fileName, body);
			const ran = String(Array.isArray(cmd) ? cmd[0] : cmd);

			expect(ran).not.toBe(managed);
			expect(path.basename(ran)).toBe(tool);
		},
	);

	// A project shim that cannot run falls through to PATH, not to managed.
	it.each([
		["shfmt", "shfmtFormatter", "script.sh", "if true; then\n  echo hi\nfi\n"],
		["taplo", "taploFormatter", "Cargo.toml", "[package]\nname = 'x'\n"],
	] as const)(
		"%s: a broken project shim falls through to a working PATH binary before managed",
		async (tool, exportName, fileName, body) => {
			plant(path.join(pathDir, tool), GOOD);
			const managed = plant(path.join(home, "bin", tool), GOOD);
			const project = path.join(root, "proj");
			plant(path.join(project, "node_modules", ".bin", tool), BROKEN);
			fs.writeFileSync(path.join(project, ".gitignore"), "node_modules\n");
			const file = path.join(project, fileName);
			fs.writeFileSync(file, body);
			const formatters = await import("../../clients/formatters.js");

			const cmd = await formatters[exportName].resolveCommand!(file, project);
			const ran = String(Array.isArray(cmd) ? cmd[0] : cmd);

			expect(ran).not.toBe(managed);
			expect(path.basename(ran)).toBe(tool);
		},
	);

	// Nothing on PATH: the managed copy is the formatter.
	it.each(ROWS)(
		"%s: the managed binary runs when PATH has none",
		async (tool, exportName, fileName, body) => {
			const managed = plant(path.join(home, "bin", tool), GOOD);

			const cmd = await resolve(exportName, fileName, body);

			expect(Array.isArray(cmd) ? cmd[0] : cmd).toBe(managed);
		},
	);

	// The ladder's first rung: the trusted project's own shim, found at exactly
	// the project root the formatter spawns in (the marker is `.gitignore`).
	// Only the ladder looks in the project; the installer lookups do not.
	it.each([
		["shfmt", "shfmtFormatter", "script.sh", "if true; then\n  echo hi\nfi\n"],
		["taplo", "taploFormatter", "Cargo.toml", "[package]\nname = 'x'\n"],
		["ktlint", "ktlintFormatter", "Main.kt", "fun main() {}\n"],
		["typstyle", "typstyleFormatter", "doc.typ", "= Title\n"],
		["ktfmt", "ktfmtFormatter", "Main.kt", "fun main() {}\n"],
	] as const)(
		"%s: the trusted project's own node_modules shim outranks managed and PATH",
		async (tool, exportName, fileName, body) => {
			plant(path.join(pathDir, tool), GOOD);
			plant(path.join(home, "bin", tool), GOOD);
			const project = path.join(root, "proj");
			const shim = plant(
				path.join(project, "node_modules", ".bin", tool),
				GOOD,
			);
			fs.writeFileSync(path.join(project, ".gitignore"), "node_modules\n");
			const nested = path.join(project, "src");
			fs.mkdirSync(nested, { recursive: true });
			const file = path.join(nested, fileName);
			fs.writeFileSync(file, body);
			const formatters = await import("../../clients/formatters.js");

			const cmd = await formatters[exportName].resolveCommand!(file, nested);

			expect(Array.isArray(cmd) ? cmd[0] : cmd).toBe(shim);
		},
	);

	// oxfmt is an npm tool: its managed copy is a shim under the tools tree,
	// not a release binary, so the row sits outside the table above.
	it("oxfmt: a broken PATH binary does not shadow the working managed shim", async () => {
		plant(path.join(pathDir, "oxfmt"), BROKEN);
		const shim = plant(
			path.join(home, "tools", "node_modules", ".bin", "oxfmt"),
			GOOD,
		);
		const project = path.join(root, "proj");
		fs.mkdirSync(project, { recursive: true });
		const file = path.join(project, "main.ts");
		fs.writeFileSync(file, "const x = 1;\n");
		const { oxfmtFormatter } = await import("../../clients/formatters.js");

		const cmd = await oxfmtFormatter.resolveCommand!(file, project);

		expect(Array.isArray(cmd) ? cmd[0] : cmd).toBe(shim);
	});

	// Control (green on the base too): the PATH answer is not lost.
	it.each(ROWS)(
		"%s: a working PATH binary still runs when nothing is managed",
		async (tool, exportName, fileName, body) => {
			plant(path.join(pathDir, tool), GOOD);

			const cmd = await resolve(exportName, fileName, body);

			expect(Array.isArray(cmd) ? path.basename(String(cmd[0])) : cmd).toBe(
				tool,
			);
		},
	);
});

describe("pip-managed formatters (#5410, #5492 r2 F4)", () => {
	// black and cmake-format have no release binary: the managed copy is the
	// pi-lens pip prefix. A broken PATH copy falls through to it; a working
	// PATH copy outranks it.
	const PIP = [
		["black", "blackFormatter", "main.py", "x = 1\n"],
		["cmake-format", "cmakeFormatFormatter", "CMakeLists.txt", "project(x)\n"],
	] as const;

	async function resolvePip(
		exportName: (typeof PIP)[number][1],
		fileName: string,
		body: string,
	) {
		const project = path.join(root, "proj");
		fs.mkdirSync(project, { recursive: true });
		const file = path.join(project, fileName);
		fs.writeFileSync(file, body);
		const formatters = await import("../../clients/formatters.js");
		return formatters[exportName].resolveCommand!(file, project);
	}

	it.each(PIP)(
		"%s: a broken PATH binary falls through to the pip-managed one",
		async (tool, exportName, fileName, body) => {
			plant(path.join(pathDir, tool), BROKEN);
			const managed = plant(path.join(home, "pip-tools", "bin", tool), GOOD);

			const cmd = await resolvePip(exportName, fileName, body);

			expect(Array.isArray(cmd) ? cmd[0] : cmd).toBe(managed);
		},
	);

	// The spec rows are what give these two tools the project rung: without a
	// row the formatter would only see PATH and the pip prefix.
	it.each(PIP)(
		"%s: the project's own .venv binary outranks PATH and the pip-managed one",
		async (tool, exportName, fileName, body) => {
			plant(path.join(pathDir, tool), GOOD);
			plant(path.join(home, "pip-tools", "bin", tool), GOOD);
			const project = path.join(root, "proj");
			const own = plant(path.join(project, ".venv", "bin", tool), GOOD);
			fs.writeFileSync(path.join(project, ".gitignore"), ".venv\n");
			const file = path.join(project, fileName);
			fs.writeFileSync(file, body);
			const formatters = await import("../../clients/formatters.js");

			const cmd = await formatters[exportName].resolveCommand!(file, project);

			expect(Array.isArray(cmd) ? cmd[0] : cmd).toBe(own);
		},
	);

	it.each(PIP)(
		"%s: a working PATH binary outranks the pip-managed one",
		async (tool, exportName, fileName, body) => {
			plant(path.join(pathDir, tool), GOOD);
			const managed = plant(path.join(home, "pip-tools", "bin", tool), GOOD);

			const cmd = await resolvePip(exportName, fileName, body);
			const ran = String(Array.isArray(cmd) ? cmd[0] : cmd);

			expect(ran).not.toBe(managed);
			expect(path.basename(ran)).toBe(tool);
		},
	);
});

describe("a present tool that fails its version check (#5492 r2 F2, F6)", () => {
	// Recurrence: r1 read a black that tracebacks on every call as "formatter
	// executable not found" and dropped the traceback (master said "failed"
	// with it, #3312). Present-but-rejected stays a failed outcome carrying
	// the probe's stderr; only a tool nothing resolves reads "not found".
	it("black: a PATH binary that fails --version is a failed outcome carrying its stderr", async () => {
		plant(path.join(pathDir, "black"), BROKEN);
		const project = path.join(root, "proj");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, "pyproject.toml"), "[tool.black]\n");
		const file = path.join(project, "main.py");
		fs.writeFileSync(file, "x = 1\n");
		const { formatFile, blackFormatter } =
			await import("../../clients/formatters.js");

		const result = await formatFile(file, blackFormatter);

		expect(result.outcome).toBe("failed");
		expect(result.success).toBe(false);
		expect(result.error).toContain("failed its version check");
		expect(result.error).toContain("Traceback");
		expect(result.error).not.toContain("not found");
	});

	it("black: a tool nothing resolves still reads executable not found", async () => {
		const project = path.join(root, "proj");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, "pyproject.toml"), "[tool.black]\n");
		const file = path.join(project, "main.py");
		fs.writeFileSync(file, "x = 1\n");
		const { formatFile, blackFormatter } =
			await import("../../clients/formatters.js");

		const result = await formatFile(file, blackFormatter);

		expect(result.outcome).toBe("unavailable");
		expect(result.error).toContain("not found");
	});

	// Recurrence (CodeRabbit on #5492, formatters.ts sqlfluff): the resolver
	// returned `null` when the ladder rejected the PATH sqlfluff, so the
	// static bare `sqlfluff fix --force` ran the REJECTED binary; its status 1
	// is lenient for sqlfluff, so the file read "unchanged", a clean verdict
	// from a tool that failed its probe.
	it("sqlfluff: a PATH binary that fails --version is never run, and is not unchanged", async () => {
		plant(path.join(pathDir, "sqlfluff"), BROKEN);
		const project = path.join(root, "proj");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, ".sqlfluff"), "[sqlfluff]\n");
		const file = path.join(project, "q.sql");
		fs.writeFileSync(file, "select 1\n");
		const { formatFile, sqlfluffFormatter } =
			await import("../../clients/formatters.js");

		const result = await formatFile(file, sqlfluffFormatter);

		expect(spawnCalls.some((call) => call.args[0] === "fix")).toBe(false);
		expect(result.outcome).toBe("failed");
		expect(result.error).toContain("failed its version check");
	});

	it("sqlfluff: no binary anywhere is unavailable without a spawn", async () => {
		const project = path.join(root, "proj");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, ".sqlfluff"), "[sqlfluff]\n");
		const file = path.join(project, "q.sql");
		fs.writeFileSync(file, "select 1\n");
		const { formatFile, sqlfluffFormatter } =
			await import("../../clients/formatters.js");

		const result = await formatFile(file, sqlfluffFormatter);

		expect(spawnCalls.some((call) => call.args[0] === "fix")).toBe(false);
		expect(result.outcome).toBe("unavailable");
	});
});

describe("runner and formatter keep separate answers for one tool (#5492 r2)", () => {
	// Recurrence it prevents: one checker per tool id shared by both orders
	// would hand the first caller's answer to the second. The runner prefers
	// managed, the formatter PATH, so a shared latch makes one of them run the
	// wrong binary depending on who asked first.
	it.each([
		["runner first", true],
		["formatter first", false],
	] as const)(
		"shfmt with PATH and managed both working: %s",
		async (_label, runnerFirst) => {
			plant(path.join(pathDir, "shfmt"), GOOD);
			const managed = plant(path.join(home, "bin", "shfmt"), GOOD);
			const project = path.join(root, "proj");
			fs.mkdirSync(project, { recursive: true });
			const helpers =
				await import("../../clients/dispatch/runners/utils/runner-helpers.js");

			const order: Array<"runner" | "formatter"> = runnerFirst
				? ["runner", "formatter"]
				: ["formatter", "runner"];
			const answers: Record<string, string | null> = {};
			for (const who of order) {
				answers[who] =
					who === "runner"
						? await helpers.resolveToolCommandWithInstallFallback(
								project,
								"shfmt",
							)
						: (await helpers.resolveInstalledToolCommand(project, "shfmt"))
								.command;
			}

			expect(answers.runner).toBe(managed);
			expect(answers.formatter).not.toBe(managed);
			expect(path.basename(String(answers.formatter))).toBe("shfmt");
		},
	);
});

describe("resolveInstalledToolCommand answers (#5492 r2)", () => {
	// Recurrence it prevents: the formatter bodies fall back to the installer
	// lookups on a null, so a ladder that stopped at a rejected PATH binary
	// (no fall-through to the managed rungs) stayed green behind them while the
	// latched verdict said "rejected" for a tool whose managed copy works.
	async function ask(toolId: string) {
		const helpers =
			await import("../../clients/dispatch/runners/utils/runner-helpers.js");
		const project = path.join(root, "proj");
		fs.mkdirSync(project, { recursive: true });
		return helpers.resolveInstalledToolCommand(project, toolId);
	}

	it("a broken PATH release tool falls through to the managed release binary", async () => {
		plant(path.join(pathDir, "shfmt"), BROKEN);
		const managed = plant(path.join(home, "bin", "shfmt"), GOOD);

		expect(await ask("shfmt")).toEqual({ command: managed });
	});

	it("a broken PATH npm tool falls through to the managed npm shim", async () => {
		plant(path.join(pathDir, "oxfmt"), BROKEN);
		const shim = plant(
			path.join(home, "tools", "node_modules", ".bin", "oxfmt"),
			GOOD,
		);

		expect(await ask("oxfmt")).toEqual({ command: shim });
	});

	it("a present tool that fails its version check reports the probe output", async () => {
		plant(path.join(pathDir, "shfmt"), BROKEN);

		expect(await ask("shfmt")).toEqual({
			command: null,
			rejected: "Traceback\n",
		});
	});

	it("a tool nothing provides reports no rejection", async () => {
		expect(await ask("shfmt")).toEqual({ command: null });
	});

	// #5410 S1 review V1: the path-first project rung takes each bin dir's own
	// Windows launcher (`PROJECT_BIN_DIR_WINDOWS_EXT`). pyright's spec says `.cmd`,
	// so only the per-dir map finds a pip venv's `Scripts\pyright.exe`; without
	// it the rung falls to the npm `.cmd` beside it. Recurrence it prevents: the
	// map dropped from this rung, which every formatter reaches through here.
	it("win32: a venv Scripts pyright.exe outranks a node_modules/.bin pyright.cmd", async () => {
		const saved = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			const project = path.join(root, "proj");
			const venvExe = plant(
				path.join(project, ".venv", "Scripts", "pyright.exe"),
				GOOD,
			);
			plant(path.join(project, "node_modules", ".bin", "pyright.cmd"), GOOD);

			expect(await ask("pyright")).toEqual({ command: venvExe });
		} finally {
			if (saved) Object.defineProperty(process, "platform", saved);
		}
	});
});

// PR #5783 r1 F1-F5: keep each formatter/client's established lookup contract.
describe("reviewed ladder preservation (#5783)", () => {
	it("stylua: an ancestor shim remains detectable and resolves without a version probe", async () => {
		const shim = plant(path.join(root, "node_modules", ".bin", "stylua"), GOOD);
		fs.chmodSync(shim, 0o644);
		const child = path.join(root, "child");
		fs.mkdirSync(child);
		fs.writeFileSync(path.join(child, "stylua.toml"), "column_width = 100\n");
		const file = path.join(child, "init.lua");
		const { styluaFormatter } = await import("../../clients/formatters.js");
		expect(await styluaFormatter.detect(child)).toBe(true);
		expect(await styluaFormatter.resolveCommand?.(file, child)).toEqual([
			shim,
			file,
		]);
		expect(spawnCalls.some((call) => call.cmd === shim)).toBe(false);
	});

	it("stylua: config without an installed shim is not detected", async () => {
		fs.writeFileSync(path.join(root, "stylua.toml"), "column_width = 100\n");
		const { styluaFormatter } = await import("../../clients/formatters.js");
		expect(await styluaFormatter.detect(root)).toBe(false);
	});

	it("shfmt: no installed command is not detected", async () => {
		const { shfmtFormatter } = await import("../../clients/formatters.js");
		expect(await shfmtFormatter.detect(root)).toBe(false);
	});

	it("shfmt: a working project command is detected", async () => {
		plant(path.join(root, "node_modules", ".bin", "shfmt"), GOOD);
		const { shfmtFormatter } = await import("../../clients/formatters.js");
		expect(await shfmtFormatter.detect(root)).toBe(true);
	});

	// Control: Biome's formatter caller omits the client install handoff and
	// retains its version-checked PATH-first ladder (#5783 profile isolation).
	it("biome: the ordinary formatter lookup keeps PATH before managed", async () => {
		plant(path.join(home, "tools", "node_modules", ".bin", "biome"), GOOD);
		plant(path.join(pathDir, "biome"), GOOD);
		const { resolveInstalledToolCommand } =
			await import("../../clients/dispatch/runners/utils/runner-helpers.js");
		expect((await resolveInstalledToolCommand(root, "biome")).command).toBe(
			"biome",
		);
		expect(
			spawnCalls.some(
				(call) => call.cmd === "biome" && call.args.includes("--version"),
			),
		).toBe(true);
	});

	it("biome: an installed project shim is not version-probed", async () => {
		const project = plant(
			path.join(root, "node_modules", ".bin", "biome"),
			BROKEN,
		);
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient() as unknown as {
			getBiomeBinary(cwd?: string): Promise<{ cmd: string }>;
		};
		expect((await client.getBiomeBinary(root)).cmd).toBe(project);
		expect(spawnCalls.some((call) => call.cmd === project)).toBe(false);
	});

	it("biome: a missing presence ladder returns npx without a bare version probe", async () => {
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient() as unknown as {
			getBiomeBinary(cwd?: string): Promise<{ cmd: string; args: string[] }>;
		};
		expect(await client.getBiomeBinary(root)).toEqual({
			cmd: "npx",
			args: ["@biomejs/biome"],
		});
		expect(spawnCalls.some((call) => call.cmd === "biome")).toBe(false);
	});

	// Recurrence it prevents (PR #5783 verify r5, thread PRRT_kwDORt8rec68Va6o):
	// a presence-only miss latched `missing` for the whole session, so an
	// `npm install` that planted `node_modules/.bin/biome` mid-session was never
	// read and every later Biome call ran npx. Master re-checked the bin dir on
	// each resolve. A repeated miss still answers npx.
	it("biome: a shim an install plants after a miss is picked up in the same session", async () => {
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient() as unknown as {
			getBiomeBinary(cwd?: string): Promise<{ cmd: string; args: string[] }>;
		};
		const npx = { cmd: "npx", args: ["@biomejs/biome"] };
		expect(await client.getBiomeBinary(root)).toEqual(npx);
		expect(await client.getBiomeBinary(root)).toEqual(npx);
		const shim = plant(path.join(root, "node_modules", ".bin", "biome"), GOOD);
		expect((await client.getBiomeBinary(root)).cmd).toBe(shim);
		expect(spawnCalls.some((call) => call.cmd === shim)).toBe(false);
	});

	// Recurrence it prevents: the presence-only branch (`fastPathOnly`) returns
	// before the probe and used to leave no availability decision, so a Biome
	// that fell through to npx looked identical to one nobody asked about.
	it("biome: the presence ladder records its hit and its miss as caller-classified decisions", async () => {
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient() as unknown as {
			getBiomeBinary(cwd?: string): Promise<{ cmd: string }>;
		};
		// The real latency log (no double): test mode writes nothing, so it is
		// switched off for this case, as tool-binary-resolver.test.ts does.
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		const { flushLatencyLog, getLatencyLogPath } =
			await import("../../clients/latency-logger.js");
		const biomeRows = async () => {
			await flushLatencyLog();
			const log = getLatencyLogPath();
			if (!fs.existsSync(log)) return [];
			return fs
				.readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
				.filter(
					(row) =>
						row.phase === "availability_decision" &&
						row.metadata?.tool === "biome",
				)
				.map((row) => row.metadata);
		};

		await client.getBiomeBinary(root);
		expect(await biomeRows()).toEqual([
			expect.objectContaining({
				verdict: "unavailable",
				outcome: "missing",
				cause: "not-found",
				classifiedBy: "caller",
			}),
		]);

		const managed = plant(
			path.join(home, "tools", "node_modules", ".bin", "biome"),
			GOOD,
		);
		const elsewhere = path.join(root, "other");
		fs.mkdirSync(elsewhere);
		expect((await client.getBiomeBinary(elsewhere)).cmd).toBe(managed);
		// Append order: the hit follows the miss it came after.
		expect(await biomeRows()).toEqual([
			expect.objectContaining({ verdict: "unavailable", cause: "not-found" }),
			expect.objectContaining({
				verdict: "available",
				outcome: "success",
				cause: "fast-path",
				classifiedBy: "caller",
			}),
		]);
	});

	it("biome: Windows managed discovery prefers cmd over the bare shim", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		const managed = plant(
			path.join(home, "tools", "node_modules", ".bin", "biome.cmd"),
			GOOD,
		);
		plant(path.join(home, "tools", "node_modules", ".bin", "biome"), GOOD);
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient() as unknown as {
			getBiomeBinary(cwd?: string): Promise<{ cmd: string }>;
		};
		expect((await client.getBiomeBinary(root)).cmd).toBe(managed);
	});

	for (const explicit of [true, false]) {
		it(`biome: managed precedes PATH with cwd ${explicit ? "set" : "unset"}`, async () => {
			vi.spyOn(process, "cwd").mockReturnValue(root);
			const managed = plant(
				path.join(home, "tools", "node_modules", ".bin", "biome"),
				GOOD,
			);
			plant(path.join(pathDir, "biome"), GOOD);
			const { BiomeClient } = await import("../../clients/biome-client.js");
			const client = new BiomeClient() as unknown as {
				getBiomeBinary(cwd?: string): Promise<{ cmd: string }>;
			};
			expect(
				(await client.getBiomeBinary(explicit ? root : undefined)).cmd,
			).toBe(managed);
		});

		it(`biome: bun global bin precedes npx with cwd ${explicit ? "set" : "unset"}`, async () => {
			vi.spyOn(process, "cwd").mockReturnValue(root);
			plant(path.join(pathDir, "bun"), GOOD);
			const bunRoot = path.join(home, "bun");
			vi.stubEnv("BUN_INSTALL", bunRoot);
			const global = plant(path.join(bunRoot, "bin", "biome"), GOOD);
			const { BiomeClient } = await import("../../clients/biome-client.js");
			const client = new BiomeClient() as unknown as {
				getBiomeBinary(cwd?: string): Promise<{ cmd: string }>;
			};
			expect(
				(await client.getBiomeBinary(explicit ? root : undefined)).cmd,
			).toBe(global);
		});
	}

	it("biome: auto-installed precedes managed and PATH but follows this project's shim", async () => {
		const managed = plant(
			path.join(home, "tools", "node_modules", ".bin", "biome"),
			GOOD,
		);
		plant(path.join(pathDir, "biome"), GOOD);
		const installed = plant(path.join(home, "installed", "biome"), GOOD);
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient() as unknown as {
			autoInstalledBinaryPath: string;
			getBiomeBinary(cwd?: string): Promise<{ cmd: string }>;
		};
		client.autoInstalledBinaryPath = installed;
		expect((await client.getBiomeBinary(root)).cmd).toBe(installed);
		const project = plant(
			path.join(root, "node_modules", ".bin", "biome"),
			GOOD,
		);
		expect((await client.getBiomeBinary(root)).cmd).toBe(project);
		expect(installed).not.toBe(managed);
	});

	it("biome: the same client stops returning and spawning the project shim when trust is withdrawn", async () => {
		const project = plant(
			path.join(root, "node_modules", ".bin", "biome"),
			GOOD,
		);
		const managed = plant(
			path.join(home, "tools", "node_modules", ".bin", "biome"),
			GOOD,
		);
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const trust = await import("../../clients/project-trust.js");
		const client = new BiomeClient() as unknown as {
			getBiomeBinary(cwd?: string): Promise<{ cmd: string }>;
			spawnBiomeAsync(
				args: string[],
				timeout: number,
				cwd: string,
			): Promise<unknown>;
		};
		expect((await client.getBiomeBinary(root)).cmd).toBe(project);
		await client.spawnBiomeAsync(["lint"], 1000, root);
		expect(
			spawnCalls.some(
				(call) => call.cmd === project && call.args.includes("lint"),
			),
		).toBe(true);
		trust.setProjectTrustState("untrusted");
		spawnCalls.length = 0;
		expect((await client.getBiomeBinary(root)).cmd).toBe(managed);
		await client.spawnBiomeAsync(["lint"], 1000, root);
		expect(spawnCalls.some((call) => call.cmd === project)).toBe(false);
		trust.setProjectTrustState("trusted");
		expect((await client.getBiomeBinary(root)).cmd).toBe(project);
	});

	it("biome: a managed hit while untrusted does not hide the project after trust is granted", async () => {
		const project = plant(
			path.join(root, "node_modules", ".bin", "biome"),
			GOOD,
		);
		const managed = plant(
			path.join(home, "tools", "node_modules", ".bin", "biome"),
			GOOD,
		);
		const trust = await import("../../clients/project-trust.js");
		trust.setProjectTrustState("untrusted");
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient() as unknown as {
			getBiomeBinary(cwd?: string): Promise<{ cmd: string }>;
		};
		expect((await client.getBiomeBinary(root)).cmd).toBe(managed);
		trust.setProjectTrustState("trusted");
		expect((await client.getBiomeBinary(root)).cmd).toBe(project);
	});
});
