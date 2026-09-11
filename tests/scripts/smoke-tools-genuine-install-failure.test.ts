/**
 * #2638/#2661 review: the tool-smoke lane's `ensureTool` failure classification.
 *
 * Round 1 shipped `genuineInstallFailure`, which inferred "genuine" from
 * install strategy + the `getInstallFailureReason` REFUSAL map alone — the
 * exact inference `clients/installer/index.ts`'s own `InstallAttempt` doc
 * comment says cannot answer "did an install even run" (#1500 round 3 deleted
 * this same inference from `describeInstallAttempt` for the identical
 * reason). Review F1 reproduced it directly: `PI_LENS_DISABLE_TOOL_INSTALL=1`
 * (outcome `declined`), an install-lock timeout (`skipped`), and a
 * project-trust decline (`declined`) all left `unavailableTools` populated
 * with NO install ever having run, and the old function reported every one
 * of them as a genuine npm-strategy failure — a false RED on a lane the
 * operator deliberately disabled installs on.
 *
 * `classifyInstallOutcome` fixes this by gating on
 * `getInstallAttempt(toolId)?.outcome === "failed"` FIRST — the only outcome
 * that means "an install genuinely ran and did not succeed" — before ever
 * consulting strategy/toolchain. It also excludes a transient/offline
 * registry condition (F2: `ENOTFOUND`/`E5xx` is a runner condition, not an
 * installer defect) and caps the reported detail to one line (F5).
 *
 * `resolveUnavailabilityRow` is the single wrapper all three
 * `runLspHandshake` unavailability sites now call (F3 — collapses three
 * near-identical inline blocks into one, tested once here).
 *
 * Review round 2, R2-F1 asked for the bulk of this file's near-identical
 * `it` bodies to become one `it.each` table — done below.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	classifyInstallOutcome,
	ensureFixtureTools,
	pipCandidateUsable,
	runInstallRegistrySmoke,
	resolveUnavailabilityRow,
} from "../../scripts/smoke-tools.mjs";

interface SmokeInstallAttempt {
	outcome: "succeeded" | "failed" | "declined" | "skipped";
	reason?: string;
}
type GetInstallAttempt = (toolId: string) => SmokeInstallAttempt | undefined;

const toolsById = new Map([
	["vscode-css-languageserver", { installStrategy: "npm" }],
	["rust-analyzer", { installStrategy: "github" }],
	["jedi-language-server", { installStrategy: "pip" }],
	["some-gem-tool", { installStrategy: "gem" }],
]);

function deps(
	getInstallAttempt: GetInstallAttempt,
	overrides: Record<string, unknown> = {},
) {
	return {
		getInstallAttempt,
		toolsById,
		toolchainPresence: {},
		pipCandidates: ["pip3", "pip", "python3", "python"],
		...overrides,
	};
}

// { name, toolId, attempt, toolchainPresence, expectRow, expectContains?,
//   expectNotContains? } — one row per `InstallAttempt.outcome` × toolchain
// state combination this function distinguishes (#2661 round 2 R2-F1).
const CASES: Array<{
	name: string;
	toolId: string;
	attempt: SmokeInstallAttempt | undefined;
	toolchainPresence?: Record<string, boolean>;
	expectRow: "fail" | "skip";
	expectContains?: string;
}> = [
	{
		name: "a genuine npm failure (outcome: failed) is a fail row with the real reason",
		toolId: "vscode-css-languageserver",
		attempt: {
			outcome: "failed",
			reason: "npm ERR! code ENOVERSIONS\nnpm ERR! No versions available",
		},
		expectRow: "fail",
		expectContains: "ENOVERSIONS",
	},
	{
		// The exact reviewer probe: PI_LENS_DISABLE_TOOL_INSTALL=1.
		name: "PI_LENS_DISABLE_TOOL_INSTALL=1 (outcome: declined) is a skip, never a fail",
		toolId: "vscode-css-languageserver",
		attempt: {
			outcome: "declined",
			reason: "installation disabled by PI_LENS_DISABLE_TOOL_INSTALL=1",
		},
		expectRow: "skip",
	},
	{
		name: "an install-lock timeout (outcome: skipped) is a skip, never a fail",
		toolId: "vscode-css-languageserver",
		attempt: { outcome: "skipped", reason: "install lock held" },
		expectRow: "skip",
	},
	{
		name: "a project-trust decline (outcome: declined) is a skip, never a fail",
		toolId: "vscode-css-languageserver",
		attempt: {
			outcome: "declined",
			reason: "project trust: untrusted project",
		},
		expectRow: "skip",
	},
	{
		name: "no attempt record at all is a skip",
		toolId: "vscode-css-languageserver",
		attempt: undefined,
		expectRow: "skip",
		expectContains: "no install attempt",
	},
	{
		name: "a transient network failure (ENOTFOUND) is a skip, not a fail",
		toolId: "vscode-css-languageserver",
		attempt: {
			outcome: "failed",
			reason: "npm error ENOTFOUND registry.npmjs.org",
		},
		expectRow: "skip",
		expectContains: "transient",
	},
	{
		name: "a registry 5xx is a skip, not a fail",
		toolId: "vscode-css-languageserver",
		attempt: {
			outcome: "failed",
			reason: "npm error E503 Service Unavailable",
		},
		expectRow: "skip",
	},
	{
		name: "PEP 668 externally-managed-environment remains a genuine pip failure",
		toolId: "jedi-language-server",
		attempt: {
			outcome: "failed",
			reason: "error: externally-managed-environment",
		},
		toolchainPresence: { pip: true },
		expectRow: "fail",
	},
	{
		name: "ETIMEDOUT is treated as transient",
		toolId: "vscode-css-languageserver",
		attempt: { outcome: "failed", reason: "npm error ETIMEDOUT" },
		expectRow: "skip",
	},
	{
		name: "ECONNRESET is treated as transient",
		toolId: "vscode-css-languageserver",
		attempt: { outcome: "failed", reason: "npm error ECONNRESET" },
		expectRow: "skip",
	},
	{
		name: "EAI_AGAIN is treated as transient",
		toolId: "vscode-css-languageserver",
		attempt: { outcome: "failed", reason: "npm error EAI_AGAIN" },
		expectRow: "skip",
	},
	{
		name: "a genuine github-strategy failure stays a skip (toolchain-asset gap, unchanged)",
		toolId: "rust-analyzer",
		attempt: { outcome: "failed", reason: "no asset for this platform" },
		expectRow: "skip",
	},
	{
		name: "a genuine pip failure with the toolchain present is a fail",
		toolId: "jedi-language-server",
		attempt: { outcome: "failed", reason: "pip install failed" },
		toolchainPresence: { pip: true },
		expectRow: "fail",
	},
	{
		name: "a genuine pip failure with the toolchain absent is a skip",
		toolId: "jedi-language-server",
		attempt: { outcome: "failed", reason: "pip install failed" },
		toolchainPresence: { pip: false },
		expectRow: "skip",
	},
	{
		name: "a genuine gem failure with the toolchain present is a fail",
		toolId: "some-gem-tool",
		attempt: { outcome: "failed", reason: "gem install failed" },
		toolchainPresence: { gem: true },
		expectRow: "fail",
	},
	{
		name: "a genuine gem failure with the toolchain absent is a skip",
		toolId: "some-gem-tool",
		attempt: { outcome: "failed", reason: "gem install failed" },
		toolchainPresence: { gem: false },
		expectRow: "skip",
	},
];

describe("classifyInstallOutcome (#2638/#2661) — outcome × toolchain table", () => {
	it.each(CASES)(
		"$name",
		({ toolId, attempt, toolchainPresence, expectRow, expectContains }) => {
			const result = classifyInstallOutcome(
				toolId,
				deps(() => attempt, toolchainPresence ? { toolchainPresence } : {}),
			);
			expect(result.row).toBe(expectRow);
			if (expectContains) expect(result.detail).toContain(expectContains);
		},
	);

	// F5: detail is one line, capped — not a table row (a distinct dimension:
	// formatting, not outcome × toolchain).
	it("caps a multi-line reason to its first non-empty line, at 200 chars", () => {
		const longLine = "x".repeat(250);
		const result = classifyInstallOutcome(
			"vscode-css-languageserver",
			deps(() => ({
				outcome: "failed",
				reason: `\n\n${longLine}\nsecond line never shown`,
			})),
		);
		expect(result.row).toBe("fail");
		expect(result.detail).not.toContain("second line never shown");
		expect(result.detail.length).toBeLessThan(300);
	});

	it("preserves the network-unreachable classification for release consumers", () => {
		const result = classifyInstallOutcome(
			"vscode-css-languageserver",
			deps(() => ({
				outcome: "failed",
				reason: "npm error ENOTFOUND registry.npmjs.org",
			})),
		);
		expect(result.networkUnreachable).toBe(true);
	});

	it("carries the classifier tag into the registry report", async () => {
		const report = await runInstallRegistrySmoke({
			deps: {
				TOOLS: [{ id: "vscode-css-languageserver", installStrategy: "npm" }],
				ensureTool: async () => undefined,
				getInstallAttempt: () => ({
					outcome: "failed",
					reason: "npm error ENOTFOUND registry.npmjs.org",
				}),
				pipCommandCandidates: () => [],
			},
		});
		expect(report.results[0].networkUnreachable).toBe(true);
	});

	it("does not fall back to the source checkout when installer root is absent", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation(((
			code?: number,
		) => {
			throw new Error(`process.exit(${code})`);
		}) as never);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(runInstallRegistrySmoke()).rejects.toThrow(
				"process.exit(2)",
			);
			expect(error).toHaveBeenCalledWith(
				"installer root missing: --installer-root=<path> is required for the installed registry smoke",
			);
		} finally {
			exit.mockRestore();
			error.mockRestore();
		}
	});
});

/**
 * R2-F2: a python-family command answering a bare `--version` is NOT proof
 * of a usable pip toolchain — `python3` is commonly present without the
 * `pip` module on slim/manylinux base images, and `installPipTool` itself
 * runs `python3 -m pip …`, which fails there. Real shim scripts on a
 * throwaway PATH (not a mocked `child_process`) so this proves the ACTUAL
 * subprocess invocation `pipCandidateUsable` makes, the same hermetic-shim
 * technique `managed-tool-refresh.test.ts` uses.
 */
// POSIX shell shims — the authoritative Unit tests lane is ubuntu (AGENTS.md
// platform rule); skipped on a Windows dev box rather than doubling the shim
// technique for a lane this project does not run tests on.
describe.skipIf(process.platform === "win32")(
	"pipCandidateUsable (#2661 round 2 R2-F2)",
	() => {
		let binDir: string;
		let restorePath: string | undefined;

		beforeEach(() => {
			binDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pip-shim-"));
			restorePath = process.env.PATH;
		});

		afterEach(() => {
			process.env.PATH = restorePath;
			fs.rmSync(binDir, { recursive: true, force: true });
		});

		function writeShim(name: string, script: string): void {
			const file = path.join(binDir, name);
			fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
		}

		it("python3 with no pip module: --version succeeds, -m pip fails → NOT usable", () => {
			// Simulates Debian slim / manylinux: python3 present, pip module absent.
			writeShim(
				"python3",
				[
					'if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then',
					'  echo "No module named pip" >&2',
					"  exit 1",
					"fi",
					'echo "Python 3.11.0"',
				].join("\n"),
			);
			process.env.PATH = `${binDir}:${restorePath}`;
			expect(pipCandidateUsable("python3")).toBe(false);
		});

		it("python3 WITH a working pip module is usable", () => {
			writeShim(
				"python3",
				[
					'if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then',
					'  echo "pip 24.0"',
					"  exit 0",
					"fi",
					'echo "Python 3.11.0"',
				].join("\n"),
			);
			process.env.PATH = `${binDir}:${restorePath}`;
			expect(pipCandidateUsable("python3")).toBe(true);
		});

		it("a bare pip/pip3 candidate is checked with --version directly (unchanged)", () => {
			writeShim("pip3", 'echo "pip 24.0"');
			process.env.PATH = `${binDir}:${restorePath}`;
			expect(pipCandidateUsable("pip3")).toBe(true);
		});
	},
);

// `restDeps` is everything `classifyInstallOutcome` needs EXCEPT
// `getInstallAttempt` — #2670 moved that out into its own positional
// `attemptSnapshots` Map parameter (see resolveUnavailabilityRow's own doc
// comment for why), so a caller here has no `getInstallAttempt` key to set
// at all under normal use.
function restDeps(overrides: Record<string, unknown> = {}) {
	return {
		toolsById,
		toolchainPresence: {},
		pipCandidates: ["pip3", "pip", "python3", "python"],
		...overrides,
	};
}

describe("resolveUnavailabilityRow (#2661 F3 / #2670)", () => {
	it("returns the first genuine failure among several tool ids", () => {
		const attemptSnapshots = new Map<string, SmokeInstallAttempt>([
			["rust-analyzer", { outcome: "declined" }],
			[
				"vscode-css-languageserver",
				{ outcome: "failed", reason: "npm ERR! code ENOVERSIONS" },
			],
		]);
		const result = resolveUnavailabilityRow(
			["rust-analyzer", "vscode-css-languageserver"],
			new Set(["rust-analyzer", "vscode-css-languageserver"]),
			attemptSnapshots,
			restDeps(),
			"fallback skip detail",
		);
		expect(result.row).toBe("fail");
		expect(result.detail).toContain("vscode-css-languageserver");
	});

	it("falls back to the given skip detail when nothing is genuine", () => {
		const attemptSnapshots = new Map<string, SmokeInstallAttempt>([
			["rust-analyzer", { outcome: "declined" }],
		]);
		const result = resolveUnavailabilityRow(
			["rust-analyzer"],
			new Set(["rust-analyzer"]),
			attemptSnapshots,
			restDeps(),
			"fallback skip detail",
		);
		expect(result).toEqual({ row: "skip", detail: "fallback skip detail" });
	});

	it("skips tool ids that were never unavailable", () => {
		const attemptSnapshots = new Map<string, SmokeInstallAttempt>([
			[
				"vscode-css-languageserver",
				{ outcome: "failed", reason: "should not be reached" },
			],
		]);
		const result = resolveUnavailabilityRow(
			["vscode-css-languageserver"],
			new Set(),
			attemptSnapshots,
			restDeps(),
			"fallback skip detail",
		);
		expect(result).toEqual({ row: "skip", detail: "fallback skip detail" });
	});

	/**
	 * #2670 (the #2661 r3 verify's residual): the production call site used to
	 * assemble a `deps` object at each of `runLspHandshake`'s three
	 * unavailability sites, with `getInstallAttempt: (id) =>
	 * attemptSnapshots.get(id)` set INLINE — nothing about that shape stopped
	 * a future edit from swapping that closure for the live module-global
	 * `getInstallAttempt` instead (mutation E, #2661 r3), and no test caught
	 * it because none exercised the assembled object's own precedence.
	 *
	 * Reproduces the exact hazard directly against the NEW signature: pass a
	 * `restDeps` that itself carries a (hostile/mistaken) live
	 * `getInstallAttempt`, alongside the real snapshot `Map` as its own
	 * parameter — and assert the snapshot always wins. This is mutation E's
	 * shape moved onto the new call surface: reverting `resolveUnavailabilityRow`
	 * to spread `restDeps` AFTER its own derived `getInstallAttempt` (instead
	 * of before) reintroduces exactly this bug and reds this test.
	 */
	it("always classifies from the snapshot Map, never a getInstallAttempt smuggled into restDeps", () => {
		const attemptSnapshots = new Map<string, SmokeInstallAttempt>([
			[
				"vscode-css-languageserver",
				{ outcome: "failed", reason: "npm ERR! code ENOVERSIONS" },
			],
		]);
		const liveGetInstallAttempt = (): SmokeInstallAttempt => ({
			outcome: "declined",
			reason:
				"should never be read — this is the live global, not the snapshot",
		});
		const result = resolveUnavailabilityRow(
			["vscode-css-languageserver"],
			new Set(["vscode-css-languageserver"]),
			attemptSnapshots,
			restDeps({ getInstallAttempt: liveGetInstallAttempt }),
			"fallback skip detail",
		);
		expect(result.row).toBe("fail");
		expect(result.detail).toContain("ENOVERSIONS");
	});
});

/**
 * R2-F3: `getInstallAttempt` reads a module-global the installer keeps
 * mutating. Reproduces the race directly: a `getInstallAttempt` stub whose
 * answer for the SAME tool id changes between the first call (during
 * `ensureFixtureTools`) and a later call (simulating a subsequent fixture's
 * overlapping re-ensure rewriting failed→declined before classification
 * runs) — the snapshot must freeze the FIRST answer.
 */
describe("ensureFixtureTools (#2661 round 2 R2-F3)", () => {
	it("snapshots the attempt record at ensure-time, immune to a later rewrite", async () => {
		let callCount = 0;
		const getInstallAttempt = (_toolId: string): SmokeInstallAttempt => {
			callCount += 1;
			// First read (inside ensureFixtureTools): a genuine E404. Every
			// later read (a stale live re-read would hit this): rewritten by
			// an unrelated later `{allowInstall:false}` re-ensure.
			return callCount === 1
				? { outcome: "failed", reason: "npm ERR! code ENOVERSIONS" }
				: { outcome: "declined", reason: "installation disabled" };
		};
		const ensureTool = async () => undefined; // always unavailable

		const { unavailableTools, attemptSnapshots } = await ensureFixtureTools(
			["vscode-css-languageserver"],
			ensureTool,
			getInstallAttempt,
		);

		expect(unavailableTools.has("vscode-css-languageserver")).toBe(true);
		// The snapshot froze the FIRST (genuine-failure) answer...
		expect(attemptSnapshots.get("vscode-css-languageserver")).toMatchObject({
			outcome: "failed",
		});
		// ...so classifying from the snapshot still reds, even though a LIVE
		// re-read at this point would now return "declined" (mutation this
		// test would not have caught without the snapshot).
		const result = classifyInstallOutcome("vscode-css-languageserver", {
			getInstallAttempt: (id: string) => attemptSnapshots.get(id),
			toolsById,
			toolchainPresence: {},
			pipCandidates: [],
		});
		expect(result.row).toBe("fail");
		expect(getInstallAttempt("vscode-css-languageserver").outcome).toBe(
			"declined",
		); // proves the live source really did move on
	});

	it("records no snapshot and no unavailability for a tool that resolves", async () => {
		const { unavailableTools, attemptSnapshots } = await ensureFixtureTools(
			["vscode-css-languageserver"],
			async () => "/path/to/binary",
			() => ({ outcome: "succeeded" }),
		);
		expect(unavailableTools.size).toBe(0);
		expect(attemptSnapshots.size).toBe(0);
	});

	it("calls onEnsured with the tool id and resolved path/undefined", async () => {
		const calls: Array<[string, string | undefined]> = [];
		await ensureFixtureTools(
			["a", "b"],
			async (id: string) => (id === "a" ? "/bin/a" : undefined),
			() => ({ outcome: "failed", reason: "x" }),
			(id: string, resolved: string | undefined) => calls.push([id, resolved]),
		);
		expect(calls).toEqual([
			["a", "/bin/a"],
			["b", undefined],
		]);
	});
});
