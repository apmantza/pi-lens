/**
 * #3246 review round 2 (R3247-1) — the MCP turn-end ADAPTER, not the shared
 * engine seam.
 *
 * Round 1's delivery case called `handleTurnEnd` directly and passed
 * `host: "mcp"` as a field, so MCP file registration, turn-state ownership and
 * the consume→`TurnEndOutcome` hop were never exercised: an adapter-only
 * change could break MCP delivery while that test stayed green. This drives
 * the real `runTurnEnd` entry point in `clients/mcp/session.ts` — the one the
 * MCP server calls — end to end.
 *
 * Doubles are the two true process boundaries only: `clients/bootstrap.js`
 * (spawns the whole client bundle) and the LSP service / ast-grep client it
 * would otherwise start. `clients/runtime-turn.js` (the composer),
 * `clients/runtime-context.js` (the consumer), the `RuntimeCoordinator`, the
 * `CacheManager` and the durable disposition store are all REAL — they are the
 * seams under test.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLspServiceDouble } from "../../support/lsp-service-double.js";
import { removeTempDirSync } from "../test-utils.js";

const stubClients = vi.hoisted(() => {
	const keys = [
		"ruffClient",
		"biomeClient",
		"knipClient",
		"todoScanner",
		"jscpdClient",
		"depChecker",
		"testRunnerClient",
		"metricsClient",
		"complexityClient",
		"goClient",
		"govulncheckClient",
		"gitleaksClient",
		"trivyClient",
		"opengrepClient",
		"rustClient",
		"agentBehaviorClient",
	];
	const clients: Record<string, unknown> = Object.fromEntries(
		keys.map((k) => [k, { __stub: k }]),
	);
	// `handleTurnEnd` really runs here, so the clients it actually calls must
	// answer like the real ones do when nothing is configured.
	clients.knipClient = {
		ensureAvailable: async () => false,
		analyze: async () => ({
			success: true,
			issues: [],
			unusedExports: [],
			unusedFiles: [],
			unusedDeps: [],
			unlistedDeps: [],
			summary: "skipped",
		}),
	};
	clients.depChecker = { ensureAvailable: async () => false };
	clients.testRunnerClient = { getTestRunTarget: () => null };
	clients.deadCodeClients = [];
	return clients;
});

vi.mock("../../../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("../../support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => stubClients);
});
vi.mock("../../../clients/ast-grep-client.js", () => ({
	AstGrepClient: class {},
}));
// Partial override, not a whole-module replacement: only the two entry points
// that would start a language server are doubled, so the module's other
// exports stay real (#2281's vi.mock export ratchet).
vi.mock("../../../clients/lsp/capabilities.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/lsp/capabilities.js")
	>()),
	getLSPService: () => makeLspServiceDouble({ getAliveClientCount: () => 0 }),
	resetLSPService: vi.fn(),
}));

import { markDisposition } from "../../../clients/diagnostic-dispositions.js";
import { evaluateGitGuard } from "../../../clients/git-guard.js";
import type { Diagnostic } from "../../../clients/dispatch/types.js";
import { formatDiagnostics } from "../../../clients/dispatch/utils/format-utils.js";
import {
	_resetMcpSessionContext,
	_resetTurnEndChain,
	getMcpSessionContext,
	runTurnEnd,
} from "../../../clients/mcp/session.js";

let tmpDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
	previousDataDir = process.env.PILENS_DATA_DIR;
	_resetMcpSessionContext();
	_resetTurnEndChain();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3246-mcp-"));
	process.env.PILENS_DATA_DIR = path.join(tmpDir, "data");
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	removeTempDirSync(tmpDir);
});

function blockingDiagnostic(
	filePath: string,
	line: number,
	message: string,
): Diagnostic {
	return {
		id: `ast-grep:${path.basename(filePath)}:${line}`,
		message,
		filePath,
		line,
		severity: "error",
		semantic: "blocking",
		tool: "ast-grep",
		rule: "no-eval",
	};
}

describe("MCP turn-end adapter honors inline-blocker dispositions (#3246)", () => {
	it("delivers only the unmarked blocker through the real runTurnEnd entry point", async () => {
		const filePath = path.join(tmpDir, "shared.ts");
		fs.writeFileSync(filePath, "alpha();\nbeta();\n");

		// The session context the MCP server itself would build: its runtime and
		// cache manager are the ones `runTurnEnd` hands to `handleTurnEnd`.
		const ctx = await getMcpSessionContext();
		const diagnostics = [
			blockingDiagnostic(filePath, 1, "alpha is unsafe"),
			blockingDiagnostic(filePath, 2, "beta is unsafe"),
		];
		const bytes = fs.readFileSync(filePath);
		ctx.runtime.recordInlineBlockers(
			filePath,
			formatDiagnostics(diagnostics, "blocking").trim(),
			ctx.runtime.nextWriteIndex(),
			["ast-grep"],
			[1, 2],
			{
				size: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
			diagnostics,
		);
		markDisposition(
			tmpDir,
			{
				cwd: tmpDir,
				filePath,
				tool: "ast-grep",
				rule: "no-eval",
				message: "alpha is unsafe",
				line: 1,
				content: fs.readFileSync(filePath, "utf8"),
			},
			"false-positive",
		);

		const outcome = await runTurnEnd(tmpDir, [filePath]);

		// The adapter registered the edited file into turn state under its own
		// owner id, ran the composer, and consumed the result — all real.
		expect(outcome.filesRegistered).toBe(1);
		expect(outcome.turnEnd ?? "").toContain("L2: beta is unsafe");
		expect(outcome.turnEnd ?? "").not.toContain("alpha is unsafe");
		expect(outcome.turnEnd ?? "").toContain(
			"suppressed by disposition: 1 finding(s)",
		);
	});

	it("emits no turn-end message at all when every blocker is marked", async () => {
		const filePath = path.join(tmpDir, "all-marked.ts");
		fs.writeFileSync(filePath, "alpha();\n");

		const ctx = await getMcpSessionContext();
		const diagnostic = blockingDiagnostic(filePath, 1, "alpha is unsafe");
		const bytes = fs.readFileSync(filePath);
		ctx.runtime.recordInlineBlockers(
			filePath,
			formatDiagnostics([diagnostic], "blocking").trim(),
			ctx.runtime.nextWriteIndex(),
			["ast-grep"],
			[1],
			{
				size: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
			[diagnostic],
		);
		markDisposition(
			tmpDir,
			{
				cwd: tmpDir,
				filePath,
				tool: "ast-grep",
				rule: "no-eval",
				message: "alpha is unsafe",
				line: 1,
				content: fs.readFileSync(filePath, "utf8"),
			},
			"false-positive",
		);

		const outcome = await runTurnEnd(tmpDir, [filePath]);

		expect(outcome.filesRegistered).toBe(1);
		expect(outcome.turnEnd).toBeUndefined();
	});

	it("clears the commit-gate latch on the MCP path too, from the same turn end (#3248)", async () => {
		// Host parity: the latch and the commit gate live under `clients/`, so an
		// MCP session that marks every blocker must be able to commit exactly as
		// a pi session can. The gate is checked through the same
		// `evaluateGitGuard` the `tool_call` hook calls, on the session context's
		// OWN runtime and cache manager — the ones `runTurnEnd` just drove.
		const filePath = path.join(tmpDir, "mcp-gate.ts");
		fs.writeFileSync(filePath, "alpha();\n");

		const ctx = await getMcpSessionContext();
		const diagnostic = blockingDiagnostic(filePath, 1, "alpha is unsafe");
		const bytes = fs.readFileSync(filePath);
		ctx.runtime.recordInlineBlockers(
			filePath,
			formatDiagnostics([diagnostic], "blocking").trim(),
			ctx.runtime.nextWriteIndex(),
			["ast-grep"],
			[1],
			{
				size: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
			[diagnostic],
		);
		ctx.runtime.updateGitGuardStatus(
			true,
			"🔴 STOP — 1 issue(s) must be fixed",
		);
		expect(evaluateGitGuard(ctx.runtime, ctx.cacheManager, tmpDir).block).toBe(
			true,
		);

		markDisposition(
			tmpDir,
			{
				cwd: tmpDir,
				filePath,
				tool: "ast-grep",
				rule: "no-eval",
				message: "alpha is unsafe",
				line: 1,
				content: fs.readFileSync(filePath, "utf8"),
			},
			"false-positive",
		);

		await runTurnEnd(tmpDir, [filePath]);

		expect(ctx.runtime.gitGuardHasBlockers).toBe(false);
		expect(evaluateGitGuard(ctx.runtime, ctx.cacheManager, tmpDir)).toEqual({
			block: false,
		});

		// GG-3283-01 on this host too: bytes that move outside dispatch make the
		// verdict stale, and the gate must not keep allowing on it.
		fs.writeFileSync(filePath, "alpha();\nbeta();\n");
		expect(
			evaluateGitGuard(ctx.runtime, ctx.cacheManager, tmpDir),
		).toMatchObject({ block: true, unknown: true });
	});
});
