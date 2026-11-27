/**
 * #5258 r3: a runner's tool-unusable skip reads the verdict of the resolution
 * the runner used, through the real runner.
 *
 * Recurrence prevented: #5258 r2 verify N2 and N4, and the sweep of the same
 * shape. rubocop resolved by its own `--version` spawn and its skip read the
 * registry ladder it never probed, so a rubocop that hung or rejected the
 * probe read "not installed, and the managed install is off" (rubocop is on
 * the registry ladder since #5410, and its trust refusal reads as every
 * ladder tool's does); taplo's upward
 * walk and phpstan's `vendor/bin` walk refuse a project binary their checker
 * never looks up, and the skip read an absence; elixir-check read the mix
 * probe in a project that is not a mix project, where only elixirc ran.
 *
 * The one double is the spawn (a process boundary): every checker, the
 * registry ladder, the bin walks and the installer are real, with the managed
 * install off and `PI_LENS_HOME` pinned by the Vitest setup.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import type { DispatchContext } from "../../../../clients/dispatch/types.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../../clients/project-trust.js";
import { withEnv } from "../../../support/with-env.js";
import { setupTestEnvironment } from "../../test-utils.js";

type SpawnResult = Record<string, unknown>;

const { safeSpawnAsync, results } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	results: new Map<string, SpawnResult>(),
}));

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync,
}));

const MISSING: SpawnResult = {
	error: Object.assign(new Error("missing"), { code: "ENOENT" }),
	status: null,
	failure: "spawn",
	spawnFailure: { kind: "tool-not-found" },
	stdout: "",
	stderr: "",
};

const TIMED_OUT: SpawnResult = {
	error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
	status: null,
	failure: "timeout",
	stdout: "",
	stderr: "",
};

let env: ReturnType<typeof setupTestEnvironment>;
let restoreEnv: (() => void) | undefined;

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-5258-resolution-");
	results.clear();
	safeSpawnAsync.mockReset();
	// Answer by the spawned command's name; anything unlisted is absent.
	safeSpawnAsync.mockImplementation(
		async (command: string) =>
			results.get(path.basename(command).replace(/\.(exe|cmd|bat)$/i, "")) ??
			MISSING,
	);
});

afterEach(() => {
	restoreEnv?.();
	restoreEnv = undefined;
	resetProjectTrust();
	env.cleanup();
});

/** A package directory under the temp root, holding the edited file. */
function project(file: string, extra: Record<string, string> = {}) {
	const dir = path.join(env.tmpDir, "pkg");
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries({ [file]: "x\n", ...extra }))
		fs.writeFileSync(path.join(dir, name), content);
	return dir;
}

/** Executable files named `name` in `dir`, which the spawn double answers for. */
function binaries(dir: string, name: string): void {
	fs.mkdirSync(dir, { recursive: true });
	for (const file of [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`]) {
		fs.writeFileSync(path.join(dir, file), "#!/bin/sh\nexit 0\n");
		fs.chmodSync(path.join(dir, file), 0o755);
	}
}

function ctxFor(dir: string, file: string, kind: string): DispatchContext {
	return {
		filePath: path.join(dir, file),
		cwd: dir,
		kind,
		pi: { getFlag: (flag: string) => flag === "no-lsp" },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	} as unknown as DispatchContext;
}

async function run(runner: string, ctx: DispatchContext) {
	const mod = await import(`../../../../clients/dispatch/runners/${runner}.js`);
	return (await mod.default.run(ctx)).skipReason;
}

describe("a skip reads the resolution its runner used (#5258 r3)", () => {
	it("taplo: reads the trust refusal of its own upward walk", async () => {
		binaries(path.join(env.tmpDir, "node_modules", ".bin"), "taplo");
		const dir = project("a.toml");
		setProjectTrustState("untrusted");
		expect(await run("taplo", ctxFor(dir, "a.toml", "toml"))).toBe(
			"trust-refused",
		);
	});

	it("phpstan: reads the trust refusal of its own vendor/bin walk", async () => {
		binaries(path.join(env.tmpDir, "vendor", "bin"), "phpstan");
		const dir = project("a.php", { "phpstan.neon": "parameters: {}\n" });
		setProjectTrustState("untrusted");
		expect(await run("phpstan", ctxFor(dir, "a.php", "php"))).toBe(
			"trust-refused",
		);
	});

	it("elixir-check: reads the elixirc probe outside a mix project", async () => {
		const dir = project("a.ex");
		results.set("elixirc", TIMED_OUT);
		expect(await run("elixir-check", ctxFor(dir, "a.ex", "elixir"))).toBe(
			"probe-incomplete",
		);
	});

	it.each([
		["timed out", TIMED_OUT, "probe-incomplete"],
		[
			"exited 3",
			{ error: null, status: 3, stdout: "", stderr: "" },
			"probe-rejected",
		],
	] as const)(
		"rubocop: reads the registry ladder's verdict when it %s",
		async (_name, result, reason) => {
			const bin = path.join(env.tmpDir, "bin");
			binaries(bin, "rubocop");
			restoreEnv = withEnv({ PATH: bin });
			results.set("rubocop", result);
			const dir = project("a.rb");
			expect(await run("rubocop", ctxFor(dir, "a.rb", "ruby"))).toBe(reason);
		},
	);
});
