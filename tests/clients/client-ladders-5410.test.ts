/**
 * #5410 (#5666 item 1): the client-owned availability ladders (jscpd, madge,
 * knip, and the security scanners' `probeVersion`) answer through the one
 * registry resolver, not a checker or probe of their own.
 *
 * Driven through the real clients (`JscpdClient`, `DependencyChecker`,
 * `KnipClient`, `GitleaksClient`), the real checker, the real trust seam and
 * the real installer lookups. Only the child process (`safe-spawn`) is doubled;
 * installs stay off through the suite's `PI_LENS_DISABLE_TOOL_INSTALL`
 * default.
 *
 * Which cells are red before the change: jscpd's project-local cell (its
 * private checker walked the venv dirs alone and carried no project
 * `node_modules/.bin` rung, so a project that ships jscpd read as missing) and
 * gitleaks's broken-managed cell (`findManagedToolBinary` answers from a bare
 * `fs.access`, so a managed binary that fails its version check shadowed a
 * working PATH one). The madge and knip cells are characterization tests that
 * pass on the old code too, and say so: their private checkers reached the
 * project shim through an env-PATH augmentation instead of a rung.
 *
 * Recurrence pinned: a client's private checker or probe decides "is this tool
 * usable" by a different ladder than the registry's, so one binary reads as
 * available to the runner and missing to the client (#5410).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDispatchAvailabilityState } from "../../clients/dispatch/runners/utils/runner-helpers.js";
import { getGlobalPiLensDir } from "../../clients/file-utils.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { setupTestEnvironment } from "./test-utils.js";

const { safeSpawnAsync, spawnCalls, behaviour, ensureToolCalls } = vi.hoisted(
	() => {
		const ensureToolCalls: string[] = [];
		const spawnCalls: Array<{
			cmd: string;
			args: readonly string[];
			cwd: string | undefined;
		}> = [];
		// What a binary on disk does when asked for its version: it answers, or it
		// is broken. Keyed by absolute path; a bare command is resolved on the
		// spawn's own PATH first, as the OS would.
		const behaviour: { broken: Set<string> } = { broken: new Set() };
		const safeSpawnAsync = vi.fn(
			async (
				cmd: string,
				args: readonly string[] = [],
				opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
			) => {
				spawnCalls.push({ cmd: String(cmd), args, cwd: opts.cwd });
				const fs = await import("node:fs");
				const path = await import("node:path");
				const searchPath = opts.env?.PATH ?? process.env.PATH ?? "";
				const resolved = path.isAbsolute(cmd)
					? cmd
					: searchPath
							.split(path.delimiter)
							.filter(Boolean)
							.map((dir) => path.join(dir, cmd))
							.find((file) => fs.existsSync(file));
				if (!resolved || !fs.existsSync(resolved)) {
					return {
						error: new Error(`spawn ${cmd} ENOENT`),
						status: null,
						stdout: "",
						stderr: "",
						spawnFailure: { kind: "tool-not-found" },
					};
				}
				if (behaviour.broken.has(resolved)) {
					return { error: null, status: 1, stdout: "", stderr: "broken shim" };
				}
				return { error: null, status: 0, stdout: "1.0.0\n", stderr: "" };
			},
		);
		return { safeSpawnAsync, spawnCalls, behaviour, ensureToolCalls };
	},
);
// A passthrough: the real installer answers, the test only counts the asks.
vi.mock("../../clients/installer/index.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../clients/installer/index.js")>();
	return {
		...original,
		ensureTool: (...args: Parameters<typeof original.ensureTool>) => {
			ensureToolCalls.push(String(args[0]));
			return original.ensureTool(...args);
		},
	};
});
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

function plant(dir: string, bin: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(
		dir,
		process.platform === "win32" ? `${bin}.cmd` : bin,
	);
	fs.writeFileSync(file, "#!/bin/sh\n");
	fs.chmodSync(file, 0o755);
	return file;
}

/** Spawns of `bin`'s version probe, by command basename. */
const probeSpawns = (bin: string) =>
	spawnCalls.filter(
		(call) =>
			new RegExp(`(^|[\\\\/])${bin}(\\.cmd|\\.exe)?$`).test(call.cmd) &&
			call.args.some((arg) => /version/.test(arg)),
	);

describe("client availability through the registry resolver (#5410)", () => {
	let pathEnv: ReturnType<typeof setupTestEnvironment>;
	let project: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		pathEnv = setupTestEnvironment("pi-lens-5410cl-path-");
		project = setupTestEnvironment("pi-lens-5410cl-proj-");
		vi.stubEnv("PATH", pathEnv.tmpDir);
		vi.spyOn(process, "cwd").mockReturnValue(project.tmpDir);
		setProjectTrustState("trusted");
		resetDispatchAvailabilityState();
		spawnCalls.length = 0;
		ensureToolCalls.length = 0;
		behaviour.broken.clear();
		safeSpawnAsync.mockClear();
	});
	afterEach(() => {
		pathEnv.cleanup();
		project.cleanup();
		resetProjectTrust();
		resetDispatchAvailabilityState();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	const nodeModulesBin = () =>
		path.join(project.tmpDir, "node_modules", ".bin");

	// Red before the change: jscpd's private checker (`jscpdAvailability`) had no
	// `node_modules/.bin` rung, so a trusted project that ships jscpd read as
	// "missing" and the scan was skipped (or an install attempted) while the
	// scan's own lookup (`findNodeToolBinary`) would have run that shim.
	it("jscpd: a trusted project's own node_modules/.bin/jscpd is available", async () => {
		plant(nodeModulesBin(), "jscpd");
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		expect(await new JscpdClient().ensureAvailable()).toBe(true);
	});

	it("jscpd: the same shim is refused while untrusted, then admitted once trusted", async () => {
		plant(nodeModulesBin(), "jscpd");
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const client = new JscpdClient();
		setProjectTrustState("untrusted");
		expect(await client.ensureAvailable()).toBe(false);
		setProjectTrustState("trusted");
		expect(await client.ensureAvailable()).toBe(true);
	});

	it("jscpd: a repeated question probes the binary once", async () => {
		plant(pathEnv.tmpDir, "jscpd");
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const client = new JscpdClient();
		expect(await client.ensureAvailable()).toBe(true);
		expect(await client.ensureAvailable()).toBe(true);
		expect(probeSpawns("jscpd")).toHaveLength(1);
	});

	// Recurrence: the registry answers for the cwd it was asked about, and a
	// project's own shim at that cwd is that root's to run. Stored as a client's
	// fallback command, it would be what a scan of ANOTHER root ran when that
	// root has no jscpd of its own (the host cwd's shim, not the root's own).
	it("jscpd: the project shim at one root is not the fallback command of another root's scan", async () => {
		const shim = plant(nodeModulesBin(), "jscpd");
		// The other root has jscpd on PATH only, so its own availability holds.
		plant(pathEnv.tmpDir, "jscpd");
		const other = setupTestEnvironment("pi-lens-5410cl-other-");
		try {
			fs.mkdirSync(path.join(other.tmpDir, "src"), { recursive: true });
			fs.writeFileSync(
				path.join(other.tmpDir, "src", "a.ts"),
				"export const a = 1;\n",
			);
			const { JscpdClient } = await import("../../clients/jscpd-client.js");
			const client = new JscpdClient();
			expect(await client.ensureAvailable(project.tmpDir)).toBe(true);
			spawnCalls.length = 0;
			await client.scan(other.tmpDir, 5, 50, false);
			const scanSpawn = spawnCalls.find((call) =>
				call.args.includes("--reporters"),
			);
			expect(scanSpawn?.cmd).not.toBe(shim);
			expect(scanSpawn?.cmd).toBe("npx");
		} finally {
			other.cleanup();
		}
	});

	it("knip: the project shim at the asked cwd is not kept as the fallback command", async () => {
		plant(nodeModulesBin(), "knip");
		const { KnipClient } = await import("../../clients/knip-client.js");
		const client = new KnipClient();
		expect(await client.ensureAvailable()).toBe(true);
		expect((client as unknown as { knipCommand: string }).knipCommand).toBe(
			"knip",
		);
	});

	// Characterization: the old madge checker reached the project shim through
	// an env-PATH augmentation; the registry reaches it through the exact-cwd
	// rung. Passes on both.
	it("madge: a trusted project's own node_modules/.bin/madge is available", async () => {
		plant(nodeModulesBin(), "madge");
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		expect(await new DependencyChecker().ensureAvailable(project.tmpDir)).toBe(
			true,
		);
	});

	it("madge: a repeated question probes the binary once", async () => {
		plant(pathEnv.tmpDir, "madge");
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const checker = new DependencyChecker();
		expect(await checker.ensureAvailable(project.tmpDir)).toBe(true);
		expect(await checker.ensureAvailable(project.tmpDir)).toBe(true);
		expect(probeSpawns("madge")).toHaveLength(1);
	});

	it("madge: a broken PATH madge is unavailable with the cause stated", async () => {
		const bin = plant(pathEnv.tmpDir, "madge");
		behaviour.broken.add(bin);
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const checker = new DependencyChecker();
		expect(await checker.ensureAvailable(project.tmpDir)).toBe(false);
		expect(checker.getAvailabilityVerdict().cause).not.toBeNull();
	});

	// Characterization, as for madge.
	it("knip: a trusted project's own node_modules/.bin/knip is available", async () => {
		plant(nodeModulesBin(), "knip");
		const { KnipClient } = await import("../../clients/knip-client.js");
		expect(await new KnipClient().ensureAvailable()).toBe(true);
	});

	it("knip: a repeated question probes the binary once", async () => {
		plant(pathEnv.tmpDir, "knip");
		const { KnipClient } = await import("../../clients/knip-client.js");
		const client = new KnipClient();
		expect(await client.ensureAvailable()).toBe(true);
		expect(await client.ensureAvailable()).toBe(true);
		expect(probeSpawns("knip")).toHaveLength(1);
	});

	describe("security scanner probe", () => {
		let managed: string;
		beforeEach(() => {
			managed = plant(path.join(getGlobalPiLensDir(), "bin"), "gitleaks");
		});
		afterEach(() => {
			fs.rmSync(managed, { force: true });
		});

		// Red before the change: the managed binary was probed and nothing else, so
		// one that fails its version check read as "gitleaks is unavailable" (a
		// latched row) and sent the client to the installer, with a working
		// gitleaks on PATH. The runner ladder falls through to PATH (#1657).
		it("gitleaks: a managed binary that fails its version check falls through to PATH without an install", async () => {
			behaviour.broken.add(managed);
			plant(pathEnv.tmpDir, "gitleaks");
			const { GitleaksClient } =
				await import("../../clients/gitleaks-client.js");
			expect(await new GitleaksClient().ensureAvailable()).toBe(true);
			expect(ensureToolCalls).toEqual([]);
		});

		// Characterization: a managed binary that works still outranks PATH.
		it("gitleaks: a working managed binary is the one run", async () => {
			plant(pathEnv.tmpDir, "gitleaks");
			const { GitleaksClient } =
				await import("../../clients/gitleaks-client.js");
			const client = new GitleaksClient();
			expect(await client.ensureAvailable()).toBe(true);
			expect(
				(client as unknown as { binaryPath: string | null }).binaryPath,
			).toBe(managed);
		});
	});
});
