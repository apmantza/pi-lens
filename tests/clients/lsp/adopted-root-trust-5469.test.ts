/** #5469: only the external spawn boundary is substituted; trust/store/roots are real. */
import fs from "node:fs";
import path from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { filterGroupsForAdoptedRoot } from "../../../clients/dispatch/adopted-root-runners.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../../clients/latency-logger.js";
import { _setServersForFileForTests } from "../../../clients/lsp/config.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { LSP_SERVERS } from "../../../clients/lsp/server.js";
import {
	registerSessionRoot,
	resetSessionRootsForTests,
} from "../../../clients/lsp/session-roots.js";
import {
	type ProjectTrustState,
	resetProjectTrust,
	setHostProjectTrustLoader,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import {
	beginTurnContext,
	runWithTurnContext,
} from "../../../clients/turn-context.js";
import { readNdjsonRows } from "../../support/ndjson-rows.js";

let base: string, A: string, B: string, agent: string;
const services: LSPService[] = [];
beforeEach(() => {
	fs.mkdirSync(path.join(process.cwd(), ".probe-home"), { recursive: true });
	base = fs.mkdtempSync(path.join(process.cwd(), ".probe-home", "trust-5469-"));
	A = path.join(base, "A");
	B = path.join(base, "B");
	agent = path.join(base, "agent");
	for (const dir of [A, B, agent]) fs.mkdirSync(dir, { recursive: true });
	for (const dir of [A, B]) {
		fs.mkdirSync(path.join(dir, ".git"));
		fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
	}
	fs.writeFileSync(path.join(B, "main.rs"), "fn main() {}\n");
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	resetSessionRootsForTests();
	registerSessionRoot(A);
	resetDegradationLedger();
});
afterEach(async () => {
	for (const service of services.splice(0)) await service.shutdown();
	_setServersForFileForTests(undefined);
	setHostProjectTrustLoader(undefined);
	resetProjectTrust();
	resetSessionRootsForTests();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fs.rmSync(base, { recursive: true, force: true });
});
function resources() {
	fs.mkdirSync(path.join(B, ".pi"));
	fs.writeFileSync(path.join(B, ".pi", "settings.json"), "{}");
}
function saved(root: string, decision: boolean) {
	fs.writeFileSync(
		path.join(agent, "trust.json"),
		JSON.stringify({ [root]: decision }),
	);
}
function setup(projectCode = true) {
	const original = LSP_SERVERS.find(
		(s) => s.id === (projectCode ? "rust" : "cpp"),
	)!;
	const spawn = vi.fn(async () => undefined);
	_setServersForFileForTests(() => [
		{ ...original, trustAllowed: true, root: async () => B, spawn },
	]);
	const service = new LSPService(undefined, A);
	services.push(service);
	return {
		service,
		spawn,
		touch: () => service.getClientForFile(path.join(B, "main.rs")),
	};
}
const cases: {
	name: string;
	resources: boolean;
	entry?: string;
	saved?: boolean;
	policy?: string;
	missing?: boolean;
	expected: boolean;
}[] = [
	{
		name: "saved B true",
		resources: true,
		entry: "B",
		saved: true,
		expected: true,
	},
	{
		name: "saved ancestor true",
		resources: true,
		entry: "parent",
		saved: true,
		expected: true,
	},
	{
		name: "saved false",
		resources: false,
		entry: "B",
		saved: false,
		expected: false,
	},
	{ name: "no resources", resources: false, expected: true },
	{
		name: "resources always",
		resources: true,
		policy: "always",
		expected: true,
	},
	{
		name: "resources never",
		resources: true,
		policy: "never",
		expected: false,
	},
	{ name: "resources ask", resources: true, policy: "ask", expected: false },
	{ name: "missing export", resources: false, missing: true, expected: false },
];
describe("adopted root start decision (#5469)", () => {
	for (const host of ["pi", "MCP"])
		for (const trust of [
			"trusted",
			"untrusted",
			"unknown",
		] as ProjectTrustState[])
			for (const c of cases)
				for (const projectCode of [true, false]) {
					it(`${host} ${trust} ${c.name} ${projectCode ? "project-code" : "inert"}`, async () => {
						// Recurrence: #5469 let a trusted A authorize Rust on saved-false B.
						setProjectTrustState(trust);
						if (c.resources) resources();
						if (c.entry) saved(c.entry === "B" ? B : base, c.saved!);
						fs.writeFileSync(
							path.join(agent, "settings.json"),
							JSON.stringify({ defaultProjectTrust: c.policy ?? "ask" }),
						);
						// No-resource cells isolate the host classifier answer: this checkout is below
						// a real user skills directory, which the hermetic test HOME cannot own.
						const hostSdk = c.resources
							? sdk
							: { ...sdk, hasTrustRequiringProjectResources: () => false };
						const load = vi.fn(async () =>
							c.missing
								? { ...hostSdk, ProjectTrustStore: undefined }
								: hostSdk,
						);
						setHostProjectTrustLoader(host === "pi" ? load : undefined);
						const { touch, spawn } = setup(projectCode);
						await touch();
						expect(spawn).toHaveBeenCalledTimes(
							!projectCode || (host === "pi" ? c.expected : trust === "trusted")
								? 1
								: 0,
						);
						if (!projectCode || host === "MCP")
							expect(load).not.toHaveBeenCalled();
						if (host === "pi" && projectCode && !c.expected)
							expect(
								getDegradationSummary().some(
									(row) => row.kind === "lsp-registry-decision",
								),
							).toBe(true);
						if (c.entry)
							expect(
								fs.readFileSync(path.join(agent, "trust.json"), "utf8"),
							).toBe(JSON.stringify({ [c.entry === "B" ? B : base]: c.saved }));
					});
				}
	it("refuses saved-false adopted Rust under trusted A", async () => {
		// Recurrence: #5469's session trust authorized a different workspace.
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		resources();
		saved(B, false);
		setProjectTrustState("trusted");
		setHostProjectTrustLoader(async () => sdk);
		const { touch, spawn } = setup();
		await touch();
		await touch();
		await flushLatencyLog();
		expect(spawn).not.toHaveBeenCalled();
		const { rows, skipped } = readNdjsonRows(getLatencyLogPath());
		expect(skipped).toBe(0);
		expect(
			rows.filter(
				(row) =>
					row.phase === "degradation_ledger" &&
					(row.metadata as { kind?: unknown })?.kind ===
						"lsp-registry-decision" &&
					String(row.filePath).includes(B),
			),
		).toHaveLength(1);
	});

	it("refuses missing settings export even with a saved trusted decision", async () => {
		// Recurrence: unsupported pi SDK shapes must fail closed before spawning.
		saved(B, true);
		setProjectTrustState("trusted");
		setHostProjectTrustLoader(async () => ({
			...sdk,
			SettingsManager: undefined,
		}));
		const { touch, spawn } = setup();
		await touch();
		expect(spawn).not.toHaveBeenCalled();
	});

	it("reads a root once per turn and observes a new decision next turn", async () => {
		// Recurrence: repeated sync/dispatch starts must not reread pi's locking store.
		resources();
		saved(B, false);
		setProjectTrustState("trusted");
		setHostProjectTrustLoader(async () => sdk);
		const read = vi.spyOn(sdk.ProjectTrustStore.prototype, "get");
		const { touch, spawn } = setup();
		await runWithTurnContext("5469", async () => {
			beginTurnContext("5469");
			await touch();
			await touch();
			expect(read).toHaveBeenCalledTimes(1);
			expect(spawn).not.toHaveBeenCalled();
			saved(B, true);
			beginTurnContext("5469");
			await touch();
			expect(read).toHaveBeenCalledTimes(2);
			expect(spawn).toHaveBeenCalledTimes(1);
		});
	});
	it("admits LSP transport and refuses compiler fallback", () => {
		// Recurrence: #5469 stripped the transport before the registry could answer.
		expect(
			filterGroupsForAdoptedRoot([
				{ mode: "first-success", runnerIds: ["lsp", "cpp-check"] },
			])[0]?.runnerIds,
		).toEqual(["lsp"]);
	});
});
