/**
 * Project-toolchain-first knip resolution (#1721).
 *
 * Dogfood evidence: the lens reported 62 unused type exports on a tree whose
 * own `npx knip` reported none. Same cwd, same `knip.json` — different BINARY.
 * The lens spawned its managed knip 6.4.1 while the project resolved 6.32.2,
 * and 62 pieces of destructive advice came out of the version gap with nothing
 * in any log to explain it.
 *
 * These tests pin: the project's own knip wins; a project without one keeps the
 * managed command; and every run records which binary and config it used.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	classifyKnipBinary,
	KnipClient,
	resolveProjectKnipBinary,
	resolveProjectKnipConfig,
} from "../../clients/knip-client.js";
import { setupTestEnvironment } from "./test-utils.js";
import { setProjectTrustState } from "../../clients/project-trust.js";

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync: vi.fn(async () => ({
		error: null,
		status: 0,
		stdout: "",
		stderr: "",
	})),
}));

vi.mock("../../clients/sessionstart-logger.js", () => ({
	logSessionStart: vi.fn(),
}));

/**
 * Resolution runs for real (`findLocalBinUpwards`, filesystem only). The walk
 * climbs past the temp dir, so tests that assert the FALLBACK first assert that
 * no ancestor knip exists — a host that happens to carry one then fails with a
 * readable precondition instead of a confusing mismatch.
 */
function expectNoAncestorKnip(dir: string): void {
	expect(
		resolveProjectKnipBinary(dir),
		"test host has a knip above the temp dir; the fallback case cannot be observed here",
	).toBeNull();
}

type Harness = {
	runAnalyze: (dir: string) => Promise<unknown>;
	analyze: (cwd?: string) => Promise<unknown>;
	ensureAvailable: () => Promise<boolean>;
	knipCommand: string;
};

/** A fake project-local knip shim plus its manifest; returns the shim path. */
function installProjectKnip(root: string, version = "6.32.2"): string {
	const binDir = path.join(root, "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	const shim = path.join(
		binDir,
		process.platform === "win32" ? "knip.cmd" : "knip",
	);
	fs.writeFileSync(shim, "#!/bin/sh\nexit 0\n");
	const pkgDir = path.join(root, "node_modules", "knip");
	fs.mkdirSync(pkgDir, { recursive: true });
	fs.writeFileSync(
		path.join(pkgDir, "package.json"),
		JSON.stringify({ name: "knip", version }),
	);
	return shim;
}

async function spawnedCommand(): Promise<string> {
	const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");
	const call = vi.mocked(safeSpawnAsync).mock.calls[0];
	expect(call, "expected knip to be spawned").toBeDefined();
	return call?.[0] as string;
}

async function toolchainRows(): Promise<string[]> {
	const { logSessionStart } =
		await import("../../clients/sessionstart-logger.js");
	return vi
		.mocked(logSessionStart)
		.mock.calls.map((c) => String(c[0]))
		.filter((m) => m.startsWith("knip toolchain "));
}

describe("knip project-toolchain resolution (#1721)", () => {
	beforeEach(async () => {
		setProjectTrustState("trusted");
		const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");
		const { logSessionStart } =
			await import("../../clients/sessionstart-logger.js");
		vi.mocked(safeSpawnAsync).mockClear();
		vi.mocked(logSessionStart).mockClear();
	});

	it("spawns the project's own knip shim in preference to the managed one", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-local-");
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');
			const shim = installProjectKnip(tmpDir);

			const client = new KnipClient(false) as unknown as Harness;
			// What ensureAvailable() would have latched: pi-lens's managed shim.
			client.knipCommand = path.join(
				tmpDir,
				"managed",
				"node_modules",
				".bin",
				"knip.cmd",
			);

			await client.runAnalyze(tmpDir);

			expect(await spawnedCommand()).toBe(shim);
		} finally {
			cleanup();
		}
	});

	it("keeps the managed/PATH command when the project ships no knip", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-nolocal-");
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');
			expectNoAncestorKnip(tmpDir);

			const client = new KnipClient(false) as unknown as Harness;
			client.knipCommand = "managed-knip";

			await client.runAnalyze(tmpDir);

			expect(await spawnedCommand()).toBe("managed-knip");
		} finally {
			cleanup();
		}
	});

	it("runs a project-installed knip even when the managed probe reports missing", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-gate-");
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');
			const shim = installProjectKnip(tmpDir);

			const client = new KnipClient(false) as unknown as Harness;
			client.ensureAvailable = async () => false;

			await client.analyze(tmpDir);

			expect(await spawnedCommand()).toBe(shim);
		} finally {
			cleanup();
		}
	});

	it("still reports unavailable when neither the project nor pi-lens has knip", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-gate2-");
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');
			expectNoAncestorKnip(tmpDir);

			const client = new KnipClient(false) as unknown as Harness;
			client.ensureAvailable = async () => false;

			const result = (await client.analyze(tmpDir)) as {
				success: boolean;
				failureKind?: string;
			};

			expect(result.success).toBe(false);
			expect(result.failureKind).toBe("unavailable-missing");
			const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("records the binary, its version, its source, and the config it ran with", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-record-");
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');
			fs.writeFileSync(path.join(tmpDir, "knip.json"), '{"entry":["a.ts"]}');
			const shim = installProjectKnip(tmpDir, "6.32.2");

			const client = new KnipClient(false) as unknown as Harness;
			await client.runAnalyze(tmpDir);

			const rows = await toolchainRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toContain(`binary=${shim}`);
			expect(rows[0]).toContain("version=6.32.2");
			expect(rows[0]).toContain("source=project");
			expect(rows[0]).toContain("config=knip.json");
		} finally {
			cleanup();
		}
	});

	it("records config=none and source=managed-or-path for an unconfigured project", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-record2-");
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');
			expectNoAncestorKnip(tmpDir);

			const client = new KnipClient(false) as unknown as Harness;
			client.knipCommand = "managed-knip";
			await client.runAnalyze(tmpDir);

			const rows = await toolchainRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toContain("source=managed-or-path");
			expect(rows[0]).toContain("config=none (knip defaults)");
		} finally {
			cleanup();
		}
	});

	it("records one row per resolution, not one per run (bounded telemetry)", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-bound-");
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');

			const client = new KnipClient(false) as unknown as Harness;
			await client.runAnalyze(tmpDir);
			await client.runAnalyze(tmpDir);
			await client.runAnalyze(tmpDir);

			expect(await toolchainRows()).toHaveLength(1);
		} finally {
			cleanup();
		}
	});

	it("caps distinct toolchain records so many roots cannot flood the log", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-cap-");
		try {
			const client = new KnipClient(false) as unknown as Harness;
			for (let i = 0; i < 40; i++) {
				const root = path.join(tmpDir, `p${i}`);
				fs.mkdirSync(root, { recursive: true });
				fs.writeFileSync(path.join(root, "package.json"), '{"name":"demo"}');
				await client.runAnalyze(root);
			}

			// 40 distinct roots, one row each — capped at MAX_RECORDED_TOOLCHAINS.
			expect(await toolchainRows()).toHaveLength(32);
		} finally {
			cleanup();
		}
	});

	it("re-records when the resolved config changes under the same root", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-rerecord-");
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');

			const client = new KnipClient(false) as unknown as Harness;
			await client.runAnalyze(tmpDir);
			fs.writeFileSync(path.join(tmpDir, "knip.json"), "{}");
			await client.runAnalyze(tmpDir);

			const rows = await toolchainRows();
			expect(rows).toHaveLength(2);
			expect(rows[1]).toContain("config=knip.json");
		} finally {
			cleanup();
		}
	});

	describe("config discovery", () => {
		it("reports knip's config files in knip's own lookup order", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-cfg-");
			try {
				expect(resolveProjectKnipConfig(tmpDir)).toBeNull();

				fs.writeFileSync(
					path.join(tmpDir, "knip.config.ts"),
					"export default {}",
				);
				expect(resolveProjectKnipConfig(tmpDir)).toBe("knip.config.ts");

				fs.writeFileSync(path.join(tmpDir, "knip.jsonc"), "{}");
				expect(resolveProjectKnipConfig(tmpDir)).toBe("knip.jsonc");

				fs.writeFileSync(path.join(tmpDir, "knip.json"), "{}");
				expect(resolveProjectKnipConfig(tmpDir)).toBe("knip.json");
			} finally {
				cleanup();
			}
		});

		it("counts a package.json knip field as the project's config", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-cfgpkg-");
			try {
				fs.writeFileSync(
					path.join(tmpDir, "package.json"),
					JSON.stringify({ name: "demo", knip: { entry: ["a.ts"] } }),
				);
				expect(resolveProjectKnipConfig(tmpDir)).toBe("package.json#knip");
			} finally {
				cleanup();
			}
		});

		it("reports no config for a package.json without a knip field", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-cfgbare-");
			try {
				fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');
				expect(resolveProjectKnipConfig(tmpDir)).toBeNull();
			} finally {
				cleanup();
			}
		});
	});

	describe("binary discovery", () => {
		it("finds the shim the project installed", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-bin-");
			try {
				const shim = installProjectKnip(tmpDir);
				expect(resolveProjectKnipBinary(tmpDir)).toBe(shim);
			} finally {
				cleanup();
			}
		});

		it("finds a monorepo-root shim from a nested workspace package", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-bin2-");
			try {
				const shim = installProjectKnip(tmpDir);
				const nested = path.join(tmpDir, "packages", "app");
				fs.mkdirSync(nested, { recursive: true });
				expect(resolveProjectKnipBinary(nested)).toBe(shim);
			} finally {
				cleanup();
			}
		});
	});

	describe("binary classification", () => {
		it("calls a shim inside the project tree 'project'", () => {
			const root = path.resolve("/repo");
			expect(
				classifyKnipBinary(
					path.join(root, "node_modules", ".bin", "knip"),
					root,
				),
			).toBe("project");
		});

		it("calls a shim outside the project tree 'global'", () => {
			expect(
				classifyKnipBinary(
					path.resolve("/usr/local/bin/knip"),
					path.resolve("/repo"),
				),
			).toBe("global");
		});

		it("calls a monorepo-root hoisted shim 'global' from a nested package", () => {
			expect(
				classifyKnipBinary(
					path.resolve("/repo/node_modules/.bin/knip"),
					path.resolve("/repo/packages/app"),
				),
			).toBe("global");
		});

		it("calls an unresolved binary 'managed-or-path'", () => {
			expect(classifyKnipBinary(null, path.resolve("/repo"))).toBe(
				"managed-or-path",
			);
		});
	});
});
