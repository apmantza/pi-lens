/**
 * #5119. The markdownlint runner lints through markdownlint-cli2's exported
 * `main` with `optionsOverride: { fix: false }`, run in a package-owned wrapper
 * child through the spawn seam (killed at the budget, fresh module cache, a
 * crash costs the child). The real module is driven in
 * markdownlint-no-fix-real.test.ts; this file drives the branches the real
 * module cannot be made to take on demand (a throw, a hang, a spin, a late
 * throw, an edited config) with a stand-in package written to disk in the
 * layouts npm and the platforms produce. The stand-in appends the parameters it
 * received to `cli2-calls.jsonl` in its directory, so the contract with the
 * real `main` is asserted at the call.
 *
 * Recurrences each case guards are named on the case.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { setProjectTrustState } from "../../clients/project-trust.js";
import markdownlintRunner from "../../clients/dispatch/runners/markdownlint.js";
import {
	locateCli2Entry,
	runMarkdownlintApi,
} from "../../clients/dispatch/runners/utils/markdownlint-api.js";
import { makeRunnerCtx } from "../support/runner-ctx.js";
import { removeTempDirSync } from "./test-utils.js";

/** Behaviour keyed by the last argv entry, so one package serves every case. */
const STAND_IN_MAIN = `
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
export async function main(params) {
	fs.appendFileSync(
		path.join(params.directory, "cli2-calls.jsonl"),
		JSON.stringify({
			directory: params.directory,
			argv: params.argv,
			optionsOverride: params.optionsOverride,
		}) + "\\n",
	);
	const file = params.argv.at(-1);
	if (file.endsWith("throws.md")) throw new Error("boom: unreadable config");
	if (file.endsWith("hangs.md")) {
		// A live handle, as a rule awaiting a socket or a timer would hold.
		setInterval(() => {}, 1000);
		return new Promise(() => {});
	}
	if (file.endsWith("spins.md")) {
		const end = Date.now() + 3000;
		while (Date.now() < end) {}
	}
	if (file.endsWith("late-throw.md")) {
		setTimeout(() => {
			throw new Error("late: rule threw after main returned its promise");
		}, 30);
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
	if (file.endsWith("config.md")) {
		// What cli2 does with a .cjs/.mjs config: import(fileUrl).
		const config = await import(pathToFileURL(path.join(params.directory, "config.mjs")).href);
		params.logError(file + ":3 error " + config.default + " from the config");
		return 1;
	}
	params.logMessage("markdownlint-cli2 v0 (stand-in)");
	params.logError(file + ":3 error MD009/no-trailing-spaces Trailing spaces");
	return 1;
}
`;

interface Cli2Call {
	directory: string;
	argv: string[];
	optionsOverride: unknown;
}

function recordedCalls(): Cli2Call[] {
	try {
		return fs
			.readFileSync(path.join(root, "cli2-calls.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Cli2Call);
	} catch {
		// none: no call recorded yet reads as an empty list the assertion fails on
		return [];
	}
}

let root: string;

function writePackage(
	dir: string,
	main = STAND_IN_MAIN,
	name = "markdownlint-cli2",
) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ name, exports: { ".": "./markdownlint-cli2.mjs" } }),
	);
	fs.writeFileSync(path.join(dir, "markdownlint-cli2.mjs"), main);
	fs.writeFileSync(path.join(dir, "markdownlint-cli2-bin.mjs"), "// bin\n");
	return path.join(dir, "markdownlint-cli2.mjs");
}

function writeShim(file: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	return file;
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5119-api-"));
	resetDegradationLedger();
	// The runner resolves the project's own node_modules/.bin only once pi
	// trusts the project (#4268).
	setProjectTrustState("trusted");
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeTempDirSync(root);
});

describe("locateCli2Entry finds the package the resolved command belongs to", () => {
	// Recurrence: a locator that knew only the symlink layout (POSIX global or
	// `npm i` on Linux) left every Windows `.cmd` shim, which is a script and
	// not a link, on the spawn path where a project `"fix": true` still wrote.
	it("reads the package beside a plain node_modules/.bin shim (npm and the managed tree on Windows)", () => {
		const entry = writePackage(
			path.join(root, "node_modules", "markdownlint-cli2"),
		);
		const shim = writeShim(
			path.join(root, "node_modules", ".bin", "markdownlint-cli2"),
		);

		expect(locateCli2Entry(shim)).toBe(entry);
	});

	it("reads node_modules/markdownlint-cli2 beside a Windows global prefix shim", () => {
		const prefix = path.join(root, "npm");
		const entry = writePackage(
			path.join(prefix, "node_modules", "markdownlint-cli2"),
		);
		const shim = writeShim(path.join(prefix, "markdownlint-cli2.cmd"));

		expect(locateCli2Entry(shim)).toBe(entry);
	});

	it("follows a POSIX global symlink into the package", (ctx) => {
		if (process.platform === "win32") ctx.skip();
		const entry = writePackage(
			path.join(root, "lib", "node_modules", "markdownlint-cli2"),
		);
		fs.mkdirSync(path.join(root, "bin"));
		const link = path.join(root, "bin", "markdownlint-cli2");
		fs.symlinkSync(
			path.join(
				root,
				"lib",
				"node_modules",
				"markdownlint-cli2",
				"markdownlint-cli2-bin.mjs",
			),
			link,
		);

		expect(locateCli2Entry(link)).toBe(entry);
	});

	// Recurrence: the bare command name the PATH rung returns for a global
	// install was handed to the spawn path unresolved.
	it("resolves a bare command name through PATH", (ctx) => {
		if (process.platform === "win32") ctx.skip();
		const entry = writePackage(
			path.join(root, "node_modules", "markdownlint-cli2"),
		);
		writeShim(path.join(root, "node_modules", ".bin", "markdownlint-cli2"));
		vi.stubEnv("PATH", path.join(root, "node_modules", ".bin"));

		expect(locateCli2Entry("markdownlint-cli2")).toBe(entry);
	});

	// Recurrence: a sibling package whose shim shares the directory must never
	// be imported as cli2 (its `main` would run with cli2's parameters).
	it("refuses a directory whose package.json names another package", () => {
		writePackage(
			path.join(root, "node_modules", "markdownlint-cli2"),
			STAND_IN_MAIN,
			"not-cli2",
		);
		const shim = writeShim(
			path.join(root, "node_modules", ".bin", "markdownlint-cli2"),
		);

		expect(locateCli2Entry(shim)).toBeNull();
	});

	it("is null for a shim with no package behind it", () => {
		const shim = writeShim(path.join(root, "bin", "markdownlint-cli2"));

		expect(locateCli2Entry(shim)).toBeNull();
	});
});

describe("runMarkdownlintApi runs cli2's main with fix off, in a child", () => {
	function project(main = STAND_IN_MAIN): { shim: string; cwd: string } {
		writePackage(path.join(root, "node_modules", "markdownlint-cli2"), main);
		return {
			shim: writeShim(
				path.join(root, "node_modules", ".bin", "markdownlint-cli2"),
			),
			cwd: root,
		};
	}

	// Recurrence: #5119 itself. A project `"fix": true` is beaten only by an
	// optionsOverride; argv carries no spelling that turns fix off.
	it("passes the project directory, the argv and optionsOverride { fix: false }", async () => {
		const { shim, cwd } = project();

		await runMarkdownlintApi({
			command: shim,
			cwd,
			args: ["--config", "core.json", "doc.md"],
			timeoutMs: 15000,
		});

		expect(recordedCalls()).toHaveLength(1);
		expect(recordedCalls()[0]).toMatchObject({
			directory: cwd,
			argv: ["--config", "core.json", "doc.md"],
			optionsOverride: { fix: false },
		});
	});

	// Recurrence: output the host never captured; the loggers are the API's
	// channel and the wrapper maps them onto the child's stdout and stderr.
	it("returns logMessage as stdout, logError as stderr and the exit code as status", async () => {
		const { shim, cwd } = project();

		const result = await runMarkdownlintApi({
			command: shim,
			cwd,
			args: ["doc.md"],
			timeoutMs: 15000,
		});

		expect(result).toMatchObject({
			stdout: "markdownlint-cli2 v0 (stand-in)\n",
			stderr: "doc.md:3 error MD009/no-trailing-spaces Trailing spaces\n",
			status: 1,
		});
	});

	// Recurrence: cli2's bin catches a rejected config and exits 2; a throw in
	// the wrapper child must read as the same exit 2, never as exit 1 (findings).
	it("turns a thrown main into exit 2 with the message on stderr", async () => {
		const { shim, cwd } = project();

		const result = await runMarkdownlintApi({
			command: shim,
			cwd,
			args: ["throws.md"],
			timeoutMs: 15000,
		});

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("boom: unreadable config");
	});

	// Recurrence: a module that will not load must read as a rejected invocation
	// (exit 2 with the cause), not as a clean file and not as findings.
	it("turns a module that will not load into exit 2 with the cause on stderr", async () => {
		const { shim, cwd } = project('throw new Error("cannot load");\n');

		const result = await runMarkdownlintApi({
			command: shim,
			cwd,
			args: ["doc.md"],
			timeoutMs: 15000,
		});

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("cannot load");
	});

	it("turns a module that exports no main into exit 2", async () => {
		const { shim, cwd } = project("export const other = 1;\n");

		const result = await runMarkdownlintApi({
			command: shim,
			cwd,
			args: ["doc.md"],
			timeoutMs: 15000,
		});

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("exports no main");
	});

	// Recurrence: the pre-child design left a run that never settles running
	// inside the host; the child is killed at the budget.
	it("reports a run that never settles as a timeout", async () => {
		const { shim, cwd } = project();

		const result = await runMarkdownlintApi({
			command: shim,
			cwd,
			args: ["hangs.md"],
			timeoutMs: 1000,
		});

		expect(result).toMatchObject({ status: null, failure: "timeout" });
	});

	// Recurrence (review r1 F1): a rule that spins, or a 240 KB table, ran on the
	// host's event loop (measured 20 s and >60 s blocked) where the old child was
	// killed at 15 s. The event-loop delay histogram is the host loop; the spin is 3 s.
	it("does not block the host loop and times a spinning rule out", async () => {
		const { shim, cwd } = project();
		const delay = monitorEventLoopDelay({ resolution: 10 });
		delay.enable();
		let result: Awaited<ReturnType<typeof runMarkdownlintApi>>;
		try {
			result = await runMarkdownlintApi({
				command: shim,
				cwd,
				args: ["spins.md"],
				timeoutMs: 700,
			});
		} finally {
			delay.disable();
		}

		expect(result).toMatchObject({ status: null, failure: "timeout" });
		// Nanoseconds; a 3 s spin in the host reads ~3e9.
		expect(delay.max).toBeLessThan(5e8);
	});

	// Recurrence (review r1 F2): cli2 loads .cjs/.mjs configs and custom rules by
	// `import(fileUrl)`, which the host process caches until restart; an agent
	// that edited the config to silence a rule kept getting the rule's findings.
	it("follows an edit of an imported config between two lints", async () => {
		const { shim, cwd } = project();
		const run = () =>
			runMarkdownlintApi({
				command: shim,
				cwd,
				args: ["config.md"],
				timeoutMs: 15000,
			});

		fs.writeFileSync(
			path.join(root, "config.mjs"),
			'export default "CONFIG-V1";\n',
		);
		const first = await run();
		fs.writeFileSync(
			path.join(root, "config.mjs"),
			'export default "CONFIG-V2";\n',
		);
		const second = await run();

		expect(first.stderr).toContain("CONFIG-V1");
		expect(second.stderr).toContain("CONFIG-V2");
	});

	// Recurrence (review r1 F3): a rule that throws after `main` returned its
	// promise is an uncaught exception, and pi's interactive mode exits on one.
	// The child dies instead and the run reads as exit 2.
	it("keeps a late throw out of the host", async () => {
		const { shim, cwd } = project();
		const uncaught: unknown[] = [];
		const onUncaught = (error: unknown) => uncaught.push(error);
		process.on("uncaughtException", onUncaught);
		let result: Awaited<ReturnType<typeof runMarkdownlintApi>>;
		try {
			result = await runMarkdownlintApi({
				command: shim,
				cwd,
				args: ["late-throw.md"],
				timeoutMs: 15000,
			});
		} finally {
			process.off("uncaughtException", onUncaught);
		}

		expect(uncaught).toEqual([]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("late: rule threw");
	});

	// Recurrence: silently linting by an unresolved spawn hid the one path where
	// a project fix setting can still write. No package beside the command is
	// one row, once, and the command runs with its own argv (never --fix).
	it.skipIf(process.platform === "win32")(
		"spawns the command as it was and records one markdownlint-api-unavailable row when no package sits beside it",
		async () => {
			const shim = path.join(root, "bin", "markdownlint-cli2");
			fs.mkdirSync(path.dirname(shim), { recursive: true });
			fs.writeFileSync(shim, '#!/bin/sh\necho "argv:$*"\nexit 0\n', {
				mode: 0o755,
			});

			for (let i = 0; i < 2; i += 1) {
				const result = await runMarkdownlintApi({
					command: shim,
					cwd: root,
					args: ["--config", "core.json", "doc.md"],
					timeoutMs: 15000,
				});
				expect(result.stdout).toBe("argv:--config core.json doc.md\n");
				expect(result.stdout).not.toContain("--fix");
			}

			const rows = getDegradationSummary().filter(
				(group) => group.kind === "markdownlint-api-unavailable",
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.count).toBe(1);
			expect(rows[0]?.latestReasons[0]?.subject).toBe(shim);
		},
	);
});

describe.skipIf(process.platform === "win32")(
	"the runner reads the API's output through the shared tail",
	() => {
		// The runner's PATH rung resolves the bare command name (a global
		// install); leading PATH with the stand-in's bin pins which cli2 it gets.
		function useStandInOnPath(): void {
			const bin = path.join(root, "node_modules", ".bin");
			writeShim(path.join(bin, "markdownlint-cli2"));
			vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
		}

		// Recurrence: the runner kept parsing `safeSpawnAsync` output only, so a
		// module-backed run would have produced no diagnostics at all. The shim
		// prints nothing and exits 0, so a finding can only come from `main`.
		it("reports the finding main logged, with the dispatched file's path and line", async () => {
			writePackage(path.join(root, "node_modules", "markdownlint-cli2"));
			useStandInOnPath();
			fs.writeFileSync(path.join(root, ".markdownlint-cli2.jsonc"), "{}\n");
			const filePath = path.join(root, "doc.md");
			fs.writeFileSync(filePath, "# Title\n\ntext   \n");

			const result = await markdownlintRunner.run(
				makeRunnerCtx(filePath, root, { kind: "markdown" }) as never,
			);

			expect(result.diagnostics.map((d) => [d.rule, d.line])).toEqual([
				["MD009", 3],
			]);
			expect(recordedCalls().at(-1)?.optionsOverride).toEqual({ fix: false });
		});

		// Recurrence: exit 2 from the API (a rejected config) must read as "the
		// tool never analysed the file", like the spawn path, not as a clean file.
		it("does not report a clean file when main throws", async () => {
			writePackage(path.join(root, "node_modules", "markdownlint-cli2"));
			useStandInOnPath();
			fs.writeFileSync(path.join(root, ".markdownlint-cli2.jsonc"), "{}\n");
			const filePath = path.join(root, "throws.md");
			fs.writeFileSync(filePath, "# Title\n");

			const result = await markdownlintRunner.run(
				makeRunnerCtx(filePath, root, { kind: "markdown" }) as never,
			);

			expect(recordedCalls()).toHaveLength(1);
			expect(result.diagnostics).toEqual([]);
			expect(result.status).toBe("skipped");
		});
	},
);
