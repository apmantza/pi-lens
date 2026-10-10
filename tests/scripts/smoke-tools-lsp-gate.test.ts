import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	classifyLspGateResult,
	classifyOfficialDockerGateResult,
	runLspGate,
} from "../../scripts/smoke-tools.mjs";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

const fixture = { lang: "lua", serverHint: "probe-primary" };

const gateFixture = {
	lang: "typescript",
	dir: "tests/fixtures/tool-smoke/typescript",
	file: "bad.ts",
	serverHint: "probe-primary",
	tools: [],
	setup: undefined,
};

const originalHome = process.env.PI_LENS_HOME;
const tempHomes: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const home of tempHomes.splice(0))
		fs.rmSync(home, { recursive: true, force: true });
	if (originalHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = originalHome;
});

function gateDeps(
	execute: () => Promise<unknown>,
	fixtureOverrides: Record<string, unknown> = {},
	hasDockerBuildx = true,
) {
	const selectedFixture = { ...gateFixture, ...fixtureOverrides };
	return {
		population: {
			eligible: [selectedFixture],
			gated: [selectedFixture],
			exempt: [],
		},
		ensureTool: vi.fn(async () => "/mock/tool"),
		getInstallAttempt: vi.fn(),
		initLSPConfig: vi.fn(async () => undefined),
		bootstrapFixtureWorkspace: vi.fn(async () => ({
			workspace: "/tmp/pi-lens-gate-test-workspace",
			absFile: "/tmp/pi-lens-gate-test-workspace/bad.ts",
			cleanup: vi.fn(),
		})),
		createLspDiagnosticsTool: () => ({ execute }),
		adoptProjectTrustFromContext: vi.fn(),
		hasDockerBuildx: vi.fn(() => hasDockerBuildx),
	};
}

async function runGateWithCensus(
	state: string,
	execute: () => Promise<unknown>,
	fixtureOverrides?: Record<string, unknown>,
	hasDockerBuildx = true,
) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-gate-census-"));
	tempHomes.push(home);
	process.env.PI_LENS_HOME = home;
	fs.writeFileSync(
		path.join(home, "lsp-handshake-census.json"),
		JSON.stringify({ typescript: { state } }),
	);
	const output: string[] = [];
	vi.spyOn(console, "log").mockImplementation((...args) =>
		output.push(args.join(" ")),
	);
	const deps = gateDeps(execute, fixtureOverrides, hasDockerBuildx);
	await runLspGate({
		langs: ["typescript"],
		install: false,
		verbose: false,
		deps,
	});
	return { output: output.join("\n"), deps };
}

describe("LSP diagnostics clean-gate classification (#2780/#2776)", () => {
	it("requires the official Docker BuildKit rule, or discloses unavailable buildx", () => {
		// #3939 recurrence: the official server's old fixture produced an empty
		// list, and allowEmptyBaseline turned that unsupported rule set into green.
		const finding = {
			details: {
				totalDiagnostics: 1,
				primaryDiagnosticsCount: 1,
				diagnostics: [{ code: "JSONArgsRecommended" }],
			},
		};
		expect(classifyOfficialDockerGateResult(finding, true)).toMatchObject({
			state: "pass",
		});
		expect(
			classifyOfficialDockerGateResult(
				{ details: { totalDiagnostics: 0, diagnostics: [] } },
				true,
			),
		).toMatchObject({ state: "fail" });
		expect(
			classifyOfficialDockerGateResult(
				{ details: { totalDiagnostics: 0, diagnostics: [] } },
				false,
			),
		).toMatchObject({ state: "skip", detail: "buildx unavailable" });
		expect(
			classifyOfficialDockerGateResult(
				{ details: { unavailable: "official server unavailable" } },
				true,
			),
		).toMatchObject({ state: "skip", detail: "official server unavailable" });
	});

	it("passes only when the real handler reports a primary finding", () => {
		expect(
			classifyLspGateResult(
				{
					details: {
						totalDiagnostics: 1,
						primaryDiagnosticsCount: 1,
						auxiliaryDiagnosticsCount: 0,
					},
				},
				fixture,
			),
		).toMatchObject({ state: "pass", diags: 1 });
	});

	it("reds diagnostics delivered only outside the primary bucket", () => {
		// #2776 recurrence: a custom primary pushed a finding whose source differed
		// from its server id, so the handler returned a diagnostic but rendered zero
		// primary findings. The nightly gate must catch that provenance drift.
		expect(
			classifyLspGateResult(
				{
					details: {
						totalDiagnostics: 1,
						primaryDiagnosticsCount: 0,
						auxiliaryDiagnosticsCount: 1,
					},
				},
				fixture,
			),
		).toMatchObject({ state: "fail", diags: 1 });
	});

	it("skips a server whose declared tool is unavailable", () => {
		// #3309 recurrence: installer availability can disagree with a real
		// language-toolchain server. The gate must use the handler's no_clients
		// decision, not an ensureTool preflight.
		expect(classifyLspGateResult(undefined, fixture, true)).toMatchObject({
			state: "skip",
		});
	});

	it("fails when the handler ran but returned no primary finding", () => {
		expect(
			classifyLspGateResult(
				{ details: { totalDiagnostics: 0, primaryDiagnosticsCount: 0 } },
				fixture,
			),
		).toMatchObject({ state: "fail" });
	});
});

describe("smoke-tools --lsp-gate census admission (#3309)", () => {
	it("keeps a non-pass handshake census row unavailable", async () => {
		// R2-M1 recurrence: a census row that did not pass was admitted to the
		// diagnostic handler, so an unavailable handshake could look gated.
		const execute = vi.fn(async () => ({
			details: { totalDiagnostics: 1, primaryDiagnosticsCount: 1 },
		}));
		const { output } = await runGateWithCensus("skip", execute);

		expect(output).toContain("⚠  typescript");
		expect(output).toContain(
			"LSP clean-gate census: gated 0 / handshake-only 0 / unavailable 1",
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("keeps a handler-owned unavailable result out of the gated census", async () => {
		// R2-M1 companion cell: the handler can discover unavailability after the
		// handshake census passed; that result must retain the ⚠ row semantics.
		safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });
		const execute = vi.fn(async () => {
			await safeSpawnAsync("probe-language-server", []);
			return { details: { unavailable: "probe server unavailable" } };
		});
		const { output } = await runGateWithCensus(
			"pass",
			execute,
			{ expectDiagnosticCode: "AnyDeclaredRule" },
			true,
		);

		expect(output).toContain("⚠  typescript");
		expect(output).toContain(
			"LSP clean-gate census: gated 0 / handshake-only 0 / unavailable 1",
		);
		expect(execute).toHaveBeenCalledOnce();
		expect(safeSpawnAsync).toHaveBeenCalledOnce();
	});

	it("routes a declared diagnostic code through the gated classifier", async () => {
		const execute = vi.fn(async () => ({
			details: {
				totalDiagnostics: 1,
				primaryDiagnosticsCount: 1,
				diagnostics: [{ code: "DifferentRule" }],
			},
		}));
		const { output } = await runGateWithCensus(
			"pass",
			execute,
			{ expectDiagnosticCode: "AnyDeclaredRule" },
			true,
		);

		// #3939 recurrence: removing the declared-code routing would let the
		// generic primary-finding classifier accept the wrong rule.
		expect(output).toContain("✗  typescript");
		expect(output).toContain(
			"official Docker server did not return AnyDeclaredRule",
		);
	});

	it("adopts the host trust result before driving diagnostics", async () => {
		const execute = vi.fn(async () => ({
			details: { totalDiagnostics: 1, primaryDiagnosticsCount: 1 },
		}));
		const { deps } = await runGateWithCensus("pass", execute);

		expect(deps.adoptProjectTrustFromContext).toHaveBeenCalledOnce();
		const context = deps.adoptProjectTrustFromContext.mock.calls[0][0];
		expect(context).toEqual({ isProjectTrusted: expect.any(Function) });
		expect(context.isProjectTrusted()).toBe(true);
	});
});
