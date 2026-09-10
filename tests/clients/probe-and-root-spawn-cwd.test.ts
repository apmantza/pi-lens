/**
 * #2894 — the two spawn-cwd classes that used to be decided site by site.
 *
 * Recurrence this file prevents (AGENTS.md defect shape 40, "a tool root
 * resolved at a different seam than its child spawn", and the #2872 sweep's
 * admission tables going unauditable):
 *
 * 1. PROBES. 24 availability/version spawns each decided "no cwd" in their own
 *    words, and the sweep carried 24 sentences a reviewer had to re-read one
 *    at a time. `probeToolAsync` owns that decision now, and it STRIPS a cwd
 *    rather than merely omitting one — the failure mode being closed is a
 *    probe that quietly acquires a project directory through an options
 *    object someone widened, which is invisible to the type alone.
 *
 * 2. HAND-DERIVED ROOTS. `ruff-client.ts` computed
 *    `cwd ?? path.dirname(absolutePath)` while `dispatch/runners/ruff.ts`
 *    used `resolveRunnerCwd` for the same file — two derivations for one root,
 *    which `tool-policy.ts`'s own contract says must agree. Measured on
 *    pre-#2894 code, with the caller passing the workspace root and the file
 *    in a nested package that ships its own `pyproject.toml`:
 *
 *      ruff check --output-format json …  cwd=<workspace root>
 *
 *    i.e. the nested package's config never applied. `rust-clippy.ts` had the
 *    same shape with its own `findNearestContaining(dirname(file),
 *    ["Cargo.toml"])` walk, uncapped by the dispatch root.
 *
 * Everything below drives the REAL production paths — the real dispatcher
 * availability probe, the real `RuffClient.fixFileAsync`, the real runner
 * `run()` — and fakes only the process boundary (`safeSpawnAsync`), which is
 * where the child's cwd is observed. A real spawn would show nothing extra
 * and would need `flake-shape-ratchet` admission for a shape the fix does not
 * require.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	SafeSpawnOptions,
	SpawnResult,
} from "../../clients/safe-spawn.js";

type SafeSpawnAsync = (
	command: string,
	args: string[],
	options?: SafeSpawnOptions,
) => Promise<SpawnResult>;

const spawned: Array<{
	command: string;
	args: string[];
	cwd?: string;
	hasCwdKey: boolean;
}> = [];

const { safeSpawnAsync, findCargoPathAsync } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn<SafeSpawnAsync>(),
	findCargoPathAsync: vi.fn(async () => "/usr/bin/cargo" as string | null),
}));

// The no-argument `importOriginal()` pass-through is the idiom
// `tests/config/vi-mock-export-sweep.test.ts` recognises as complete (#2784).
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal()),
	safeSpawnAsync,
}));
vi.mock("../../clients/rust-client.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		rustClient: {
			...(actual.rustClient as object),
			findCargoPathAsync,
		},
	};
});

import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { probeToolAsync } from "../../clients/tool-probe.js";
import { makeRunnerCtx } from "../support/runner-ctx.js";
import { removeTempDirSync } from "./test-utils.js";

const dirs: string[] = [];
let previousHome: string | undefined;

beforeEach(() => {
	// The seam caps every marker walk at `$HOME` (`isAtOrAboveHomeDir`), so a
	// fixture under the OS temp root is out of reach of its own markers unless
	// the ceiling moves with it. `os.homedir()` reads `$HOME` on POSIX, and
	// pointing it at the temp root is what makes these trees ordinary projects
	// rather than out-of-tree files.
	previousHome = process.env.HOME;
	process.env.HOME = fs.realpathSync(os.tmpdir());
	spawned.length = 0;
	safeSpawnAsync.mockImplementation(async (command, args, options) => {
		spawned.push({
			command,
			args,
			cwd: options?.cwd,
			hasCwdKey: options !== undefined && "cwd" in options,
		});
		return { stdout: "", stderr: "", status: 0 };
	});
	resetDegradationLedger();
});

afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	vi.clearAllMocks();
});

/** A temp project tree, under the `$HOME` the `beforeEach` pins. */
function makeTree(prefix: string, files: Record<string, string>): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-${prefix}-`)),
	);
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(root, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}
	return root;
}

describe("#2894 probe seam: a tool probe never carries a cwd", () => {
	it("probeToolAsync strips a cwd that reached it inside an options object", async () => {
		// The type forbids `cwd` on a LITERAL; this is the other direction — an
		// already-typed options object widened at the call site, which is what a
		// type alone cannot stop. The strip is what makes the seam's single
		// admission row true for every caller rather than for well-behaved ones.
		const widened = {
			timeout: 1000,
			cwd: "/nested/project",
		} as SafeSpawnOptions;
		await probeToolAsync("sometool", ["--version"], widened);

		expect(spawned).toHaveLength(1);
		expect(spawned[0].cwd).toBeUndefined();
	});

	it("the dispatcher's shared --version probe reaches the child with no cwd", async () => {
		// The real `checkToolAvailability` — the highest-traffic availability
		// consumer in the product, and the seam every `ctx.hasTool(command)`
		// gate goes through.
		const { checkToolAvailability } =
			await import("../../clients/dispatch/dispatcher.js");
		const nested = makeTree("probe-cwd", { "packages/api/main.py": "x = 1\n" });
		const previous = process.cwd();
		process.chdir(path.join(nested, "packages", "api"));
		try {
			// `node` is on PATH in every lane, so the on-disk pre-check that guards
			// the probe passes and the spawn is actually reached.
			expect(await checkToolAvailability("node", new FactStore())).toBe(true);
		} finally {
			process.chdir(previous);
		}

		const probe = spawned.find((call) => call.args[0] === "--version");
		expect(probe, "the availability probe spawned").toBeDefined();
		expect(probe?.cwd).toBeUndefined();
	});
});

describe("#2894 root seam: a hand-derived package root resolves through resolveToolCwd", () => {
	it("ruff autofix runs at the nested package root, not the caller's workspace root", async () => {
		const root = makeTree("ruff-nested", {
			"pyproject.toml": "[tool.ruff]\n",
			"packages/api/pyproject.toml": "[tool.ruff]\n",
			"packages/api/app.py": "import os\n",
		});
		const filePath = path.join(root, "packages", "api", "app.py");
		const { RuffClient } = await import("../../clients/ruff-client.js");

		// The caller (pipeline.ts) passes the dispatch language root. Pre-#2894
		// that value WAS the child's cwd; now it is only the ceiling the seam
		// walks inside.
		await new RuffClient().fixFileAsync(filePath, root);

		const checks = spawned.filter((call) => call.args[0] === "check");
		expect(checks.length, "the pre-scan and the --fix pass").toBe(2);
		for (const call of checks) {
			expect(call.cwd).toBe(path.join(root, "packages", "api"));
		}
	});

	it("cargo clippy runs at the crate root the seam resolves", async () => {
		const root = makeTree("clippy-nested", {
			"Cargo.toml": "[workspace]\n",
			"crates/engine/Cargo.toml": '[package]\nname = "engine"\n',
			"crates/engine/src/lib.rs": "pub fn f() {}\n",
		});
		const filePath = path.join(root, "crates", "engine", "src", "lib.rs");
		const runner = (
			await import("../../clients/dispatch/runners/rust-clippy.js")
		).default;

		await runner.run(makeRunnerCtx(filePath, root, { kind: "rust" }) as never);

		const clippy = spawned.find(
			(call) => call.args[1] === "--message-format=json",
		);
		expect(clippy, "cargo clippy spawned").toBeDefined();
		expect(clippy?.cwd).toBe(path.join(root, "crates", "engine"));
	});

	it("cargo clippy skips rather than running above the dispatch root", async () => {
		// The hand-rolled `findNearestContaining` walk had no ceiling: with the
		// only Cargo.toml ABOVE the dispatch root it ran cargo outside the
		// project pi-lens was asked about. The seam caps at the dispatch root,
		// so the gate — which now asks about the directory cargo would actually
		// start in — declines instead.
		const root = makeTree("clippy-outside", {
			"Cargo.toml": '[package]\nname = "outer"\n',
			"sub/src/lib.rs": "pub fn f() {}\n",
		});
		const filePath = path.join(root, "sub", "src", "lib.rs");
		const runner = (
			await import("../../clients/dispatch/runners/rust-clippy.js")
		).default;

		const result = await runner.run(
			makeRunnerCtx(filePath, path.join(root, "sub"), {
				kind: "rust",
			}) as never,
		);

		expect(result.status).toBe("skipped");
		expect(
			spawned.filter((call) => call.args[1] === "--message-format=json"),
		).toEqual([]);
	});
});
