/**
 * #5258 r3: a runner's tool-unusable skip reads the verdict of the resolution
 * the runner used, through the real runner.
 *
 * Recurrence prevented: #5258 r2 verify N2 and N4, and the sweep of the same
 * shape. rubocop resolves by its own `--version` spawn and its skip read the
 * registry ladder it never probed, so a rubocop that hung or rejected the
 * probe read "not installed, and the managed install is off"; taplo's upward
 * walk and phpstan's `vendor/bin` walk refuse a project binary their checker
 * never looks up, and the skip read an absence; elixir-check read the mix
 * probe in a project that is not a mix project, where only elixirc ran.
 *
 * Doubles sit at the process boundary (the spawn and the installer) and at the
 * runners' module-level checkers, which have no setter; `toolAbsentSkip`, the
 * registry ladder and the bin walks are real.
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
import { setupTestEnvironment } from "../../test-utils.js";

type Verdict = { outcome: string | null; cause: string | null };

const { safeSpawnAsync, isSpawnableCommand, verdicts } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	isSpawnableCommand: vi.fn(),
	verdicts: new Map<string, Verdict>(),
}));

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync,
}));

vi.mock("../../../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/installer/index.js")
	>()),
	isSpawnableCommand,
	ensureTool: async () => null,
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: (command: string) => ({
			isAvailableAsync: async () => false,
			getCommand: () => null,
			getVerdict: () => ({
				...(verdicts.get(command) ?? { outcome: null, cause: null }),
				elapsedMs: 0,
				latched: false,
				retryAtMs: 0,
			}),
		}),
		resolveToolCommandWithInstallFallback: async () => null,
	}),
);

const TIMED_OUT = {
	error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
	status: null,
	failure: "timeout",
	stdout: "",
	stderr: "",
};

let env: ReturnType<typeof setupTestEnvironment>;

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-5258-resolution-");
	safeSpawnAsync.mockReset();
	isSpawnableCommand.mockReset();
	isSpawnableCommand.mockResolvedValue(true);
	verdicts.clear();
});

afterEach(() => {
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

/** A project binary under the temp root, an ancestor of the package. */
function ancestorBin(binDir: string, name: string): void {
	const dir = path.join(env.tmpDir, binDir);
	fs.mkdirSync(dir, { recursive: true });
	for (const file of [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`])
		fs.writeFileSync(path.join(dir, file), "#!/bin/sh\nexit 0\n");
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
		ancestorBin(path.join("node_modules", ".bin"), "taplo");
		const dir = project("a.toml");
		setProjectTrustState("untrusted");
		expect(await run("taplo", ctxFor(dir, "a.toml", "toml"))).toBe(
			"trust-refused",
		);
	});

	it("phpstan: reads the trust refusal of its own vendor/bin walk", async () => {
		ancestorBin(path.join("vendor", "bin"), "phpstan");
		const dir = project("a.php", { "phpstan.neon": "parameters: {}\n" });
		verdicts.set("phpstan", { outcome: "missing", cause: "not-found" });
		setProjectTrustState("untrusted");
		expect(await run("phpstan", ctxFor(dir, "a.php", "php"))).toBe(
			"trust-refused",
		);
	});

	it("elixir-check: reads the elixirc probe outside a mix project", async () => {
		const dir = project("a.ex");
		verdicts.set("elixirc", { outcome: "transient", cause: "probe-timeout" });
		expect(await run("elixir-check", ctxFor(dir, "a.ex", "elixir"))).toBe(
			"probe-incomplete",
		);
	});

	it.each([
		["timed out", TIMED_OUT, true, "probe-incomplete"],
		[
			"exited 3",
			{ error: null, status: 3, stdout: "", stderr: "" },
			true,
			"probe-rejected",
		],
		[
			"was refused by trust",
			{
				error: new Error("refused"),
				status: null,
				failure: "spawn",
				spawnFailure: { kind: "trust-refused" },
				stdout: "",
				stderr: "",
			},
			true,
			"trust-refused",
		],
		[
			"is not on disk and the install is off",
			{
				error: Object.assign(new Error("missing"), { code: "ENOENT" }),
				status: null,
				failure: "spawn",
				spawnFailure: { kind: "tool-not-found" },
				stdout: "",
				stderr: "",
			},
			false,
			"install-disabled",
		],
	] as const)(
		"rubocop: reads its own --version spawn when it %s",
		async (_name, result, spawnable, reason) => {
			safeSpawnAsync.mockResolvedValue(result);
			isSpawnableCommand.mockResolvedValue(spawnable);
			const dir = project("a.rb");
			expect(await run("rubocop", ctxFor(dir, "a.rb", "ruby"))).toBe(reason);
		},
	);
});
