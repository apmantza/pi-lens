// flake-shape: in-process-mock — #4515: launching the managed language server is the process boundary; the trust refusal, the installer (real ensureTool and getToolPath over a seeded store) and the candidate loop all run for real
/**
 * #4515: under project trust "unknown", `launchLSP` refuses the project-local
 * candidate `<root>/node_modules/.bin/<cmd>` by path shape, and the refusal used
 * to end `resolveAndLaunch` before the managed-install step, so a managed binary
 * was never tried (the nightly LSP probes lost 30 of 54 rows).
 *
 * Round 2 (review F1): after a refusal the repair must not run project code.
 * The installer spawns bare names (its PATH rung runs `<cmd> --version`), so a
 * project bin dir on PATH (`npm run`, an activated venv, direnv) used to run the
 * planted binary. Every case below drives the REAL installer against a store
 * seeded under the worker's `PI_LENS_HOME`; only the launch of a store binary
 * is stubbed, because spawning a language server is the process boundary.
 *
 * Recurrences guarded: a fail-closed trust gate on one candidate silently
 * deleting every later fallback, and the fallback then probing the very binary
 * the gate refused.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { getGlobalPiLensDir } from "../../../clients/file-utils.js";
import {
	getInstallAttempt,
	resetProbeCacheStateForTesting,
} from "../../../clients/installer/index.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../../../clients/latency-logger.js";
import { commandSearchReachesProject } from "../../../clients/package-manager.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import { resolveSearchPathCommand } from "../../../clients/safe-spawn.js";
import { readNdjsonRows } from "../../support/ndjson-rows.js";
import { setPlatform } from "../../support/platform-stub.js";
import { removeTempDirSync } from "../test-utils.js";

vi.hoisted(() => {
	// The availability row is read back from latency.log, the bytes a
	// production reader consumes; the opt-out is scoped to this worker, whose
	// PI_LENS_HOME the setup pins under the test tree.
	process.env.PI_LENS_TEST_MODE = "0";
});
const { managedLaunch } = vi.hoisted(() => ({ managedLaunch: vi.fn() }));
const storeRoot = (): string => path.join(getGlobalPiLensDir(), "tools");
const storeBin = (): string => path.join(storeRoot(), "node_modules", ".bin");

vi.mock("../../../clients/lsp/launch.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../../clients/lsp/launch.js")>();
	return {
		...original,
		launchLSP: (
			command: string,
			args: string[],
			options: Parameters<typeof original.launchLSP>[2],
		) => {
			// Bare Python candidates can resolve to the managed store in the augmented PATH.
			const resolved = path.isAbsolute(command)
				? command
				: resolveSearchPathCommand(
						command,
						options?.env?.PATH,
						String(options?.cwd ?? process.cwd()),
					);
			return resolved?.startsWith(getGlobalPiLensDir() + path.sep)
				? managedLaunch(resolved, args, options)
				: original.launchLSP(command, args, options);
		},
	};
});

import { withLspProjectCodePermission } from "../../../clients/lsp/launch.js";
import {
	PythonJediServer,
	PythonServer,
	TypeScriptServer,
	resolveAndLaunch as resolveAndLaunchRaw,
} from "../../../clients/lsp/server.js";

// Production runs every launch inside the service's spawn scope; an own,
// trusted root is granted project-code permission there.
const resolveAndLaunch = (
	...args: Parameters<typeof resolveAndLaunchRaw>
): ReturnType<typeof resolveAndLaunchRaw> =>
	withLspProjectCodePermission(true, () => resolveAndLaunchRaw(...args));

const fakeProc = { stdout: {}, stderr: {} } as never;
const dirs: string[] = [];
const originalPath = process.env.PATH;
const originalPlatform = process.platform;
let outsideBin = "";

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** A project whose `node_modules/.bin/<tool>` (when planted) leaves a marker if it ever runs. */
function makeProject(
	tool: string,
	planted: boolean,
	binDir = path.join("node_modules", ".bin"),
) {
	const root = tempDir("pi-lens-4515-");
	const bin = path.join(root, binDir);
	const marker = path.join(root, "executed.marker");
	fs.mkdirSync(bin, { recursive: true });
	if (planted) {
		fs.writeFileSync(
			path.join(bin, tool),
			`#!/bin/sh\necho "$@" > ${JSON.stringify(marker)}\necho 1.0.0\n`,
			{ mode: 0o755 },
		);
	}
	return {
		bin,
		marker,
		spec: {
			candidates: [path.join(bin, tool)],
			args: ["--stdio"],
			cwd: root,
			managedToolId: tool,
		},
	};
}

/** Seed intelephense in the store the way npm lays it out (spawn-free verification). */
function seedStoreIntelephense(): string {
	const pkg = path.join(storeRoot(), "node_modules", "intelephense");
	fs.mkdirSync(path.join(pkg, "lib"), { recursive: true });
	fs.writeFileSync(
		path.join(pkg, "package.json"),
		JSON.stringify({
			version: "1.0.0",
			bin: { intelephense: "lib/intelephense.js" },
		}),
	);
	fs.writeFileSync(path.join(pkg, "lib", "intelephense.js"), "// stub\n");
	fs.mkdirSync(storeBin(), { recursive: true });
	const shim = path.join(storeBin(), "intelephense");
	for (const name of [shim, `${shim}.cmd`]) {
		fs.writeFileSync(name, "#!/bin/sh\n", { mode: 0o755 });
	}
	return process.platform === "win32" ? `${shim}.cmd` : shim;
}

function decisionRows(fragment: string) {
	return getDegradationSummary()
		.filter((group) => group.kind === "lsp-registry-decision")
		.flatMap((group) => group.latestReasons)
		.filter((row) => row.subject.includes(fragment));
}

async function availabilityRows(tool: string) {
	await flushLatencyLog();
	const { rows, skipped } = readNdjsonRows<{
		phase?: string;
		metadata?: Record<string, unknown>;
	}>(getLatencyLogPath());
	expect(skipped).toBe(0);
	return rows.filter(
		(entry) =>
			entry.phase === "availability_decision" && entry.metadata?.tool === tool,
	);
}

beforeEach(async () => {
	clearLatencyLog();
	await flushLatencyLog();
	managedLaunch.mockReset().mockResolvedValue(fakeProc);
	resetDegradationLedger();
	resetProjectTrust();
	resetProbeCacheStateForTesting();
	fs.rmSync(storeRoot(), { recursive: true, force: true });
	fs.rmSync(path.join(getGlobalPiLensDir(), "pip-tools"), {
		recursive: true,
		force: true,
	});
	fs.rmSync(path.join(getGlobalPiLensDir(), "probe-cache.json"), {
		force: true,
	});
	// A PATH that reaches nothing: no project dir and no real tool.
	outsideBin = tempDir("pi-lens-4515-outside-");
	process.env.PATH = outsideBin;
});

afterEach(() => {
	process.env.PATH = originalPath;
	setPlatform(originalPlatform);
	resetProjectTrust();
	resetProbeCacheStateForTesting();
	fs.rmSync(storeRoot(), { recursive: true, force: true });
	while (dirs.length) removeTempDirSync(dirs.pop() as string);
});

/** Seed pyright in the store the way npm lays it out, both of its bins. */
function seedStorePyright(): void {
	const pkg = path.join(storeRoot(), "node_modules", "pyright");
	fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
	fs.writeFileSync(
		path.join(pkg, "package.json"),
		JSON.stringify({
			version: "1.1.414",
			bin: {
				pyright: "dist/pyright.js",
				"pyright-langserver": "dist/pyright-langserver.js",
			},
		}),
	);
	for (const name of ["pyright", "pyright-langserver"]) {
		fs.writeFileSync(path.join(pkg, "dist", `${name}.js`), "// fixture\n");
		fs.mkdirSync(storeBin(), { recursive: true });
		fs.writeFileSync(path.join(storeBin(), name), "#!/bin/sh\n", {
			mode: 0o755,
		});
	}
}

/**
 * An adopted root whose node_modules/.bin, on PATH as `npm run` or direnv
 * puts it, holds both pyright bins, each leaving the marker if it ever runs.
 */
function makePyrightProjectOnPath() {
	const project = makeProject("pyright-langserver", true);
	fs.copyFileSync(
		path.join(project.bin, "pyright-langserver"),
		path.join(project.bin, "pyright"),
	);
	process.env.PATH = [project.bin, outsideBin].join(path.delimiter);
	return project;
}

describe("Python managed stage after a project refusal (#5674 review F5)", () => {
	it.each([
		["trusted", true],
		["trusted", false],
		["unknown", true],
		["unknown", false],
	] as const)(
		"never runs the project's pyright with trust=%s allowInstall=%s and its bin on PATH",
		async (trust, allowInstall) => {
			// Review F5: once the project stage's refusal no longer ended the
			// launch, Python's own managed lookup ran the installer's PATH rung,
			// `pyright --version`, which is the project's planted pyright.
			setProjectTrustState(trust);
			const { spec, marker } = makePyrightProjectOnPath();

			const result = await withLspProjectCodePermission(false, () =>
				PythonServer.spawn(spec.cwd, { allowInstall }),
			);

			expect(fs.existsSync(marker)).toBe(false);
			expect(result).toBeUndefined();
			expect(managedLaunch).not.toHaveBeenCalled();
			expect(getInstallAttempt("pyright")).toBeUndefined();
			expect(decisionRows("store-only-repair:pyright")).toHaveLength(1);
		},
	);

	it("still installs pyright when PATH is clear of the project", async () => {
		// #5674's own state: a first run with no managed pyright yet. A clean
		// PATH reaches no project code, so the refusal must not cost the install.
		// The setup's PI_LENS_DISABLE_TOOL_INSTALL=1 makes the install decline.
		setProjectTrustState("unknown");
		const { spec, marker } = makeProject("pyright-langserver", true);

		const result = await withLspProjectCodePermission(false, () =>
			PythonServer.spawn(spec.cwd, { allowInstall: true }),
		);

		expect(result).toBeUndefined();
		expect(fs.existsSync(marker)).toBe(false);
		expect(getInstallAttempt("pyright")).toMatchObject({
			outcome: "declined",
			reason: expect.stringContaining("PI_LENS_DISABLE_TOOL_INSTALL"),
		});
		expect(decisionRows("store-only-repair")).toHaveLength(0);
	});

	it.skipIf(process.platform === "win32").each(["trusted", "unknown"] as const)(
		"keeps jedi's managed tier off the activated venv's python with trust=%s",
		async (trust) => {
			// The same shape one server over: jedi's managed tier's pip probe ran
			// the activated venv's `python -m site --user-base`. Under `trusted`
			// the project tier refuses the venv's jedi first; under `unknown`
			// detectPythonEnvironment refuses the venv, so no stage refuses at
			// all (#5674 r3 item 4).
			setProjectTrustState(trust);
			const tool = "jedi-language-server";
			const {
				spec,
				bin: venvBin,
				marker,
			} = makeProject(tool, false, path.join(".venv", "bin"));
			fs.writeFileSync(path.join(spec.cwd, ".venv", "pyvenv.cfg"), "\n");
			for (const python of ["python3", "python"]) {
				fs.writeFileSync(
					path.join(venvBin, python),
					`#!/bin/sh\necho "$@" > ${JSON.stringify(marker)}\n`,
					{ mode: 0o755 },
				);
			}
			process.env.PATH = [venvBin, outsideBin].join(path.delimiter);

			const result = await withLspProjectCodePermission(false, () =>
				PythonJediServer.spawn(spec.cwd, { allowInstall: true }),
			);

			expect(result).toBeUndefined();
			expect(fs.existsSync(marker)).toBe(false);
			expect(decisionRows(`store-only-repair:${tool}`)).toHaveLength(1);
		},
	);
});

/** A recording script at `<root>/<dir>/<name>`, leaving `marker` if it runs. */
function plantRecorder(file: string, marker: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`#!/bin/sh\necho "$0 $@" >> ${JSON.stringify(marker)}\necho 1.0.0\n`,
		{ mode: 0o755 },
	);
}

function pathEntryRefusals() {
	return getDegradationSummary()
		.filter((group) => group.kind === "trust-refusal")
		.flatMap((group) => group.latestReasons)
		.filter((row) => row.subject.startsWith("project-path-entry:"));
}

describe.skipIf(process.platform === "win32")(
	"PATH entries that reach a root not admitted for project code (#5674 r3)",
	() => {
		it.each([
			["trusted", "relative"],
			["unknown", "relative"],
			["trusted", "absolute"],
			["unknown", "absolute"],
		] as const)(
			"never runs a bare candidate planted in the root with trust=%s through a %s entry",
			async (trust, shape) => {
				// Item 1 (review F1): a relative entry (`bin`, `.`) resolves against
				// the launch cwd, the root, so a bare candidate ran the root's file.
				// Item 2: an absolute dir under the root (direnv's PATH_add) did too.
				setProjectTrustState(trust);
				const { spec, bin, marker } = makeProject("fixture-lsp", false, "bin");
				plantRecorder(path.join(bin, "fixture-lsp"), marker);
				process.env.PATH = [
					outsideBin,
					shape === "relative" ? "bin" : bin,
				].join(path.delimiter);

				const outcome = await withLspProjectCodePermission(false, () =>
					resolveAndLaunchRaw(
						{ candidates: ["fixture-lsp"], args: [], cwd: spec.cwd },
						false,
					),
				).catch((err: unknown) => err);

				expect(fs.existsSync(marker)).toBe(false);
				expect(outcome).toBeUndefined();
				expect(pathEntryRefusals().map((row) => row.subject)).toContain(
					`project-path-entry:${fs.realpathSync(bin)}`,
				);
			},
		);

		it("refuses a PATH link whose target is inside the root", async () => {
			// A global bin dir holding a link into the project (`npm link`): the
			// entry is outside the root, the file it answers with is not.
			setProjectTrustState("trusted");
			const { spec, bin, marker } = makeProject("fixture-lsp", false, "bin");
			plantRecorder(path.join(bin, "fixture-lsp"), marker);
			fs.symlinkSync(
				path.join(bin, "fixture-lsp"),
				path.join(outsideBin, "fixture-lsp"),
			);

			const outcome = await withLspProjectCodePermission(false, () =>
				resolveAndLaunchRaw(
					{ candidates: ["fixture-lsp"], args: [], cwd: spec.cwd },
					false,
				),
			).catch((err: unknown) => err);

			expect(fs.existsSync(marker)).toBe(false);
			expect(outcome).toBeUndefined();
		});

		it("skips the runtime install when PATH reaches the root", async () => {
			// The runtime (`go install`, `gem install`) is a bare name resolved
			// through the process PATH; no stage refuses a missing bare candidate.
			setProjectTrustState("trusted");
			const whichDir = (originalPath ?? "")
				.split(path.delimiter)
				.find((dir) => dir && fs.existsSync(path.join(dir, "which")));
			expect(whichDir).toBeDefined();
			const { spec, bin } = makeProject("fixture-lsp", false, "bin");
			process.env.PATH = [bin, outsideBin, whichDir].join(path.delimiter);
			const install = vi.fn(async () => true);

			await withLspProjectCodePermission(false, () =>
				resolveAndLaunchRaw(
					{
						candidates: ["fixture-lsp"],
						args: [],
						cwd: spec.cwd,
						runtimeInstall: { runtimeCommand: "sh", install },
					},
					true,
				),
			);

			expect(install).not.toHaveBeenCalled();
		});

		it.each(["trusted", "unknown"] as const)(
			"keeps Python's PATH stages off a langserver in an ordinary root dir with trust=%s",
			async (trust) => {
				// Item 2: this PR made the PATH stages reachable for an adopted root.
				setProjectTrustState(trust);
				const { spec, bin, marker } = makeProject(
					"pyright-langserver",
					false,
					"bin",
				);
				for (const name of ["pyright-langserver", "pyright"])
					plantRecorder(path.join(bin, name), marker);
				process.env.PATH = [bin, outsideBin].join(path.delimiter);

				const result = await withLspProjectCodePermission(false, () =>
					PythonServer.spawn(spec.cwd, { allowInstall: true }),
				);

				expect(fs.existsSync(marker)).toBe(false);
				expect(result).toBeUndefined();
			},
		);

		it.each(["trusted", "unknown"] as const)(
			"never version-probes the root's tsc for the TypeScript server with trust=%s",
			async (trust) => {
				// Item 3: findTsserverPath's ensureTool("typescript") ran the
				// project's `tsc --version` through PATH after refusing its tsserver.
				setProjectTrustState(trust);
				const { spec, bin, marker } = makeProject("tsc", false);
				for (const name of ["tsc", "typescript-language-server"])
					plantRecorder(path.join(bin, name), marker);
				const pkg = path.join(spec.cwd, "node_modules", "typescript");
				fs.mkdirSync(path.join(pkg, "lib"), { recursive: true });
				fs.writeFileSync(path.join(pkg, "lib", "tsserver.js"), "//\n");
				fs.writeFileSync(
					path.join(pkg, "package.json"),
					JSON.stringify({ version: "5.9.3" }),
				);
				fs.writeFileSync(path.join(spec.cwd, "tsconfig.json"), "{}\n");
				process.env.PATH = [bin, outsideBin].join(path.delimiter);

				await withLspProjectCodePermission(false, () =>
					TypeScriptServer.spawn(spec.cwd, { allowInstall: true }),
				).catch(() => undefined);

				expect(fs.existsSync(marker)).toBe(false);
				expect(decisionRows("store-only-repair:typescript")).toHaveLength(1);
			},
		);
	},
);

describe("Python adopted-root fallback (#5674)", () => {
	it.each([
		[false, "trusted"],
		[true, "trusted"],
		[false, "unknown"],
		[true, "unknown"],
	] as const)(
		"reaches managed pyright with planted=%s trust=%s and no project permission",
		async (planted, trust) => {
			// #5674: Python's no-install project stage must not abort the later managed stage.
			setProjectTrustState(trust);
			const { spec, marker } = makeProject("pyright-langserver", planted);
			seedStorePyright();
			const result = await withLspProjectCodePermission(false, () =>
				PythonServer.spawn(spec.cwd, { allowInstall: false }),
			);
			expect(result).toBeDefined();
			expect(managedLaunch).toHaveBeenCalledWith(
				path.join(storeBin(), "pyright-langserver"),
				["--stdio"],
				expect.anything(),
			);
			expect(fs.existsSync(marker)).toBe(false);
			expect(decisionRows("project-local-binary").length).toBeGreaterThan(0);
			await flushLatencyLog();
			const { rows, skipped } = readNdjsonRows(getLatencyLogPath());
			expect(skipped).toBe(0);
			expect(rows).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						phase: "lsp_launch_candidate_failed",
						filePath: spec.cwd,
						metadata: expect.objectContaining({
							error: expect.stringContaining("project-local binary refused"),
						}),
					}),
					expect.objectContaining({
						phase: "lsp_launch_install_blocked",
						filePath: spec.cwd,
					}),
				]),
			);
		},
	);
});

describe("resolveAndLaunch after a trust refusal, PATH clear of the project (#4515)", () => {
	it("reaches the managed binary when the project-local candidate does not exist", async () => {
		setProjectTrustState("unknown");
		const managed = seedStoreIntelephense();
		const { spec } = makeProject("intelephense", false);

		const result = await resolveAndLaunch(spec, true);

		expect(managedLaunch).toHaveBeenCalledWith(
			managed,
			["--stdio"],
			expect.anything(),
		);
		expect(result?.source).toBe("managed");
	});

	it("keeps an existing project-local binary refused and still reaches the managed binary", async () => {
		setProjectTrustState("unknown");
		seedStoreIntelephense();
		const { spec, marker } = makeProject("intelephense", true);

		const result = await resolveAndLaunch(spec, true);

		expect(fs.existsSync(marker)).toBe(false); // never executed
		expect(result?.source).toBe("managed");
	});

	it("reaches the install step when the store is empty and rethrows the refusal when it yields nothing", async () => {
		// The test setup sets PI_LENS_DISABLE_TOOL_INSTALL=1, so the install
		// step is reached and declines without a download.
		setProjectTrustState("unknown");
		const { spec } = makeProject("tinymist", false);

		await expect(resolveAndLaunch(spec, true)).rejects.toThrow(
			/project-local binary refused: project trust is unknown/,
		);

		expect(getInstallAttempt("tinymist")).toMatchObject({
			outcome: "declined",
			reason: expect.stringContaining("PI_LENS_DISABLE_TOOL_INSTALL"),
		});
	});

	it("keeps launching the managed binary after a trusted project-local miss", async () => {
		// Trusted projects keep the old behaviour: the missing project-local file
		// is a plain tool-not-found and the managed binary still launches.
		setProjectTrustState("trusted");
		seedStoreIntelephense();
		const { spec } = makeProject("intelephense", false);

		const result = await resolveAndLaunch(spec, true);

		expect(result?.source).toBe("managed");
	});
});

describe("resolveAndLaunch after a trust refusal, project bin dir on PATH (#4515 F1)", () => {
	it("never runs the refused project binary through the installer's PATH probe", async () => {
		// Review r1 F1: under `npm run` the project's node_modules/.bin leads
		// PATH; the installer's PATH rung ran `yaml-language-server --version`
		// there, which is the refused binary.
		setProjectTrustState("unknown");
		const { spec, bin, marker } = makeProject("yaml-language-server", true);
		process.env.PATH = [bin, outsideBin].join(path.delimiter);

		await expect(resolveAndLaunch(spec, true)).rejects.toThrow(
			/project-local binary refused: project trust is unknown/,
		);

		expect(fs.existsSync(marker)).toBe(false);
		expect(getInstallAttempt("yaml-language-server")).toBeUndefined();
	});

	it("still launches the managed binary from the store", async () => {
		setProjectTrustState("unknown");
		const managed = seedStoreIntelephense();
		const { spec, bin, marker } = makeProject("intelephense", true);
		process.env.PATH = [bin, outsideBin].join(path.delimiter);

		const result = await resolveAndLaunch(spec, true);

		expect(managedLaunch).toHaveBeenCalledWith(
			managed,
			["--stdio"],
			expect.anything(),
		);
		expect(result?.source).toBe("managed");
		expect(fs.existsSync(marker)).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"finds a pip tool in pi-lens's own prefix without asking the PATH python",
		async () => {
			// An activated venv leads PATH with its bin dir, python included; the
			// Python user-base probe would run that python.
			setProjectTrustState("unknown");
			const tool = "jedi-language-server";
			const {
				spec,
				bin: venvBin,
				marker,
			} = makeProject(tool, true, path.join(".venv", "bin"));
			for (const python of ["python3", "python"]) {
				fs.writeFileSync(
					path.join(venvBin, python),
					`#!/bin/sh\necho "$@" > ${JSON.stringify(marker)}\n`,
					{ mode: 0o755 },
				);
			}
			const prefixBin = path.join(getGlobalPiLensDir(), "pip-tools", "bin");
			fs.mkdirSync(prefixBin, { recursive: true });
			const managed = path.join(prefixBin, tool);
			fs.writeFileSync(managed, "#!/bin/sh\necho 0.41.0\n", { mode: 0o755 });
			process.env.PATH = [venvBin, outsideBin].join(path.delimiter);

			const result = await resolveAndLaunch(spec, true);

			expect(managedLaunch).toHaveBeenCalledWith(
				managed,
				["--stdio"],
				expect.anything(),
			);
			expect(result?.source).toBe("managed");
			expect(fs.existsSync(marker)).toBe(false);
		},
	);

	it("records the store-only repair once per session per tool", async () => {
		setProjectTrustState("unknown");
		const { spec, bin } = makeProject("yaml-language-server", false);
		process.env.PATH = [bin, outsideBin].join(path.delimiter);

		for (let attempt = 0; attempt < 2; attempt += 1) {
			await expect(resolveAndLaunch(spec, true)).rejects.toThrow(
				/project-local binary refused/,
			);
		}

		expect(decisionRows("store-only-repair:yaml-language-server")).toHaveLength(
			1,
		);
	});

	it("reports the refused candidate as missing by policy, not as a rejected probe", async () => {
		// Review r1 F4: the availability row read "non-installable /
		// probe-rejected" for a refusal, a cause nothing else produces here.
		setProjectTrustState("unknown");
		const { spec, bin } = makeProject("yaml-language-server", false);
		process.env.PATH = [bin, outsideBin].join(path.delimiter);

		await expect(resolveAndLaunch(spec, true)).rejects.toThrow(
			/project-local binary refused/,
		);

		const rows = await availabilityRows("yaml-language-server");
		expect(rows.map((row) => row.metadata)).toEqual([
			expect.objectContaining({
				producer: "lsp-launch",
				verdict: "unavailable",
				outcome: "missing",
				cause: "policy-denied",
			}),
		]);
	});
});

describe("resolveAndLaunch trust-refusal surface (#4515)", () => {
	it("keeps an untrusted project unexecuted with the registry's allowInstall=false", async () => {
		// Review r1 F3: the registry passes allowInstall=false under untrusted
		// (assertInstallAllowed), so the store is not consulted and nothing is
		// installed, exactly as before #4515.
		setProjectTrustState("untrusted");
		seedStoreIntelephense();
		const { spec, marker } = makeProject("intelephense", true);

		expect(await resolveAndLaunch(spec, false)).toBeUndefined();
		expect(decisionRows("project-local-binary")).toHaveLength(1);

		expect(managedLaunch).not.toHaveBeenCalled();
		expect(getInstallAttempt("intelephense")).toBeUndefined();
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("returns no process and records the refusal when installs are blocked", async () => {
		setProjectTrustState("unknown");
		seedStoreIntelephense();
		const { spec, marker } = makeProject("intelephense", true);

		expect(await resolveAndLaunch(spec, false)).toBeUndefined();
		expect(decisionRows("project-local-binary")).toHaveLength(1);

		expect(managedLaunch).not.toHaveBeenCalled();
		expect(fs.existsSync(marker)).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"skips the runtime install after a refusal",
		async () => {
			// Step 4 runs a language runtime (go, gem, dotnet) in the project cwd,
			// where a go.mod toolchain line or a nuget.config feed is project
			// input; before #4515 a refusal never reached it.
			setProjectTrustState("unknown");
			const whichDir = (originalPath ?? "")
				.split(path.delimiter)
				.find((dir) => dir && fs.existsSync(path.join(dir, "which")));
			expect(whichDir).toBeDefined();
			process.env.PATH = [outsideBin, whichDir].join(path.delimiter);
			const install = vi.fn(async () => true);
			const { spec } = makeProject("fixture-lsp", false);

			await expect(
				resolveAndLaunch(
					{
						...spec,
						managedToolId: undefined,
						runtimeInstall: { runtimeCommand: "sh", install },
					},
					true,
				),
			).rejects.toThrow(/project-local binary refused/);

			expect(install).not.toHaveBeenCalled();
		},
	);

	it("records the refusal once per session per tool across repeated attempts", async () => {
		setProjectTrustState("unknown");
		seedStoreIntelephense();
		const { spec } = makeProject("intelephense", false);

		await resolveAndLaunch(spec, true);
		await resolveAndLaunch(spec, true);

		expect(decisionRows("project-local-binary")).toHaveLength(1);
	});
});

describe("commandSearchReachesProject (#4515)", () => {
	it("counts a project-local bin dir of an ancestor of the root", () => {
		const root = tempDir("pi-lens-4515-mono-");
		process.env.PATH = path.join(root, "node_modules", ".bin");

		expect(commandSearchReachesProject(path.join(root, "packages", "a"))).toBe(
			true,
		);
	});

	it("counts any directory under the root, such as a direnv bin", () => {
		const root = tempDir("pi-lens-4515-direnv-");
		process.env.PATH = [outsideBin, path.join(root, "bin")].join(
			path.delimiter,
		);

		expect(commandSearchReachesProject(root)).toBe(true);
	});

	it("counts a relative entry, which follows each spawn's cwd", () => {
		process.env.PATH = [outsideBin, path.join("node_modules", ".bin")].join(
			path.delimiter,
		);

		expect(commandSearchReachesProject(tempDir("pi-lens-4515-rel-"))).toBe(
			true,
		);
	});

	it("counts an empty entry as the cwd on POSIX only", () => {
		const root = tempDir("pi-lens-4515-empty-");
		process.env.PATH = `${outsideBin}${path.delimiter}`;

		setPlatform("linux");
		expect(commandSearchReachesProject(root)).toBe(true);
		setPlatform("win32");
		expect(commandSearchReachesProject(root)).toBe(false);
	});

	it("ignores entries outside the project", () => {
		expect(commandSearchReachesProject(tempDir("pi-lens-4515-clean-"))).toBe(
			false,
		);
	});
});
