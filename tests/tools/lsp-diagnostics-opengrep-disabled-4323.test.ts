/**
 * #4323: an explicit all-server check (`lens_diagnostics source=lsp`, MCP
 * `pilens_diagnostics`) started Opengrep although the operator had switched it
 * off with `--no-opengrep` or `opengrep.enabled=false`. The write-time runner
 * and `pilens_analyze` already honour the switch; the explicit check selected
 * servers without it.
 *
 * These cases drive the REAL `lsp_diagnostics` handler, the real LSPService
 * and real clients over stdio. Opengrep's command is overridden to a shim that
 * records each start in a marker file and then runs the shared fake server,
 * which answers every pull with one finding. The JSON server is the same fake,
 * answering clean; the YAML server's command points at a missing path, so a
 * primary-only YAML check reaches the clientless `getDiagnostics` fallback.
 *
 * Every case owns its state (#4391 F2): `beforeEach` empties the start marker
 * and the workspace diagnostics cache and replaces the LSP service, so no
 * Opengrep is warm and the start count is this case's alone. A case that needs a warm Opengrep or a first answer
 * makes its own unswitched call, which also proves the fixture would have
 * started it. The file passes in any order, alone, and under
 * `--sequence.shuffle`. The switched-off cases also pin the two other places a
 * switched-off scanner showed through: the blocker coverage claim and the
 * cache key the workspace sweep shares, plus warm-server and stored-row
 * shapes of the `lsp_navigation workspaceDiagnostics` route. Which servers
 * each route starts under each switch, through pi's and the MCP server's own
 * flag resolvers, is the matrix in
 * `tests/tools/diagnostics-route-switch-matrix.test.ts` (#4403).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { getLSPService, resetLSPService } from "../../clients/lsp/index.js";
import { clearWorkspaceDiagnosticsCache } from "../../clients/lsp/workspace-diagnostics-cache.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const env = setupTestEnvironment("pi-lens-4323-svc-");
// The real path: on macOS the tmpdir is a `/var` -> `/private/var` alias.
const workspace = fs.realpathSync(env.tmpDir);
const probe = path.join(workspace, "probe.json");
const secondProbe = path.join(workspace, "second.json");
const tsProbe = path.join(workspace, "probe.ts");
const yamlProbe = path.join(workspace, "probe.yaml");
const secondYamlProbe = path.join(workspace, "second.yaml");
const nested = path.join(workspace, "nested");
const startsMarker = path.join(workspace, "opengrep-starts.txt");
const OPENGREP_FINDING = "opengrep stand-in finding";
const SWEEP_FINDING = "finding cached by a workspace sweep";

/** The operator's switch, as both hosts resolve it. */
const noOpengrep = (name: string) => name === "no-opengrep";

function opengrepStarts(): number {
	if (!fs.existsSync(startsMarker)) return 0;
	return fs.readFileSync(startsMarker, "utf8").split("\n").filter(Boolean)
		.length;
}

type ConfirmedNoBlockers = { filePath: string; coveredSources?: string[] };

async function diagnose(
	params: Record<string, unknown>,
	getFlag?: (name: string) => boolean,
	confirmed?: ConfirmedNoBlockers[],
): Promise<{ text: string; details: Record<string, unknown> }> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const { getLSPService } = await import("../../clients/lsp/index.js");
	const result = (await createLspDiagnosticsTool(
		undefined,
		confirmed ? (info) => confirmed.push(info) : undefined,
		getLSPService,
		getFlag ? (name) => getFlag(name) : undefined,
	).execute(
		"probe-4323",
		{ serverScope: "all", waitMs: 3000, ...params },
		undefined,
		null,
		{ cwd: workspace },
	)) as {
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	};
	return {
		text: String(result.content[0]?.text),
		details: result.details ?? {},
	};
}

/**
 * `lsp_navigation operation=workspaceDiagnostics` for one file, or the
 * path-less snapshot of every running client's rows when `file` is undefined.
 * `view` asks for the envelope a case reads fields from; every other case takes
 * the default text.
 */
async function navigateDiagnostics(
	file: string | undefined,
	getFlag?: (name: string) => boolean,
	view?: "json",
): Promise<string> {
	const { createLspNavigationTool } =
		await import("../../tools/lsp-navigation.js");
	const result = (await createLspNavigationTool(
		(name) => name === "lens-lsp" || getFlag?.(name) === true,
	).execute(
		"nav-4323",
		{
			operation: "workspaceDiagnostics",
			...(file ? { path: file } : {}),
			...(view ? { view } : {}),
		},
		new AbortController().signal,
		null,
		{ cwd: workspace },
	)) as { content: Array<{ text?: string }> };
	return String(result.content[0]?.text);
}

describe("an explicit LSP check with Opengrep switched off (#4323)", () => {
	let service: ReturnType<typeof getLSPService> | undefined;
	const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;

	beforeAll(async () => {
		// Never fetch a real yaml-language-server for the missing YAML primary.
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		// Host-boundary stub: the command overrides are project config, which
		// #4248 admits only in a project pi has trusted.
		setProjectTrustState("trusted");
		const shim = (file: string, lines: string[]) => {
			fs.writeFileSync(
				file,
				[
					...lines,
					`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
					"",
				].join("\n"),
			);
		};
		const opengrepShim = path.join(workspace, "opengrep-server.mjs");
		shim(opengrepShim, [
			'import { appendFileSync } from "node:fs";',
			`appendFileSync(${JSON.stringify(startsMarker)}, process.pid + "\\n");`,
			'process.env.FAKE_LSP_RESPOND_PULL_WITH = "items";',
			'process.env.FAKE_LSP_DIAGNOSTIC_SOURCE = "Semgrep";',
			`process.env.FAKE_LSP_DIAGNOSTIC_MESSAGE = ${JSON.stringify(OPENGREP_FINDING)};`,
		]);
		const jsonShim = path.join(workspace, "json-server.mjs");
		shim(jsonShim, ['process.env.FAKE_LSP_RESPOND_PULL_WITH = "empty";']);
		fs.writeFileSync(
			path.join(workspace, "package.json"),
			'{"name":"synthetic-4323-fixture","private":true}\n',
		);
		// Opengrep roots at the nearest `.git` (clients/lsp/server.ts
		// `OpengrepServer`); without one it falls back to this process's cwd. The
		// shared fixture marker IS that `.git` (#4560).
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, ".pi-lens", "lsp.json"),
			JSON.stringify({
				serverOverrides: {
					json: { command: [process.execPath, jsonShim] },
					// #4956 F2: the primary a TypeScript probe needs; fallow, the opt-in
					// auxiliary on that file, keeps its real command and must never start.
					typescript: { command: [process.execPath, jsonShim] },
					yaml: {
						command: [
							path.join(workspace, "missing", "yaml-language-server"),
							"--stdio",
						],
					},
					opengrep: { command: [process.execPath, opengrepShim] },
				},
				disabledServers: ["ast-grep", "typos", "zizmor"],
			}),
		);
		fs.writeFileSync(tsProbe, "export const a = 1;\n");
		fs.writeFileSync(probe, '{"a": 1}\n');
		fs.writeFileSync(secondProbe, '{"b": 2}\n');
		fs.writeFileSync(yamlProbe, "a: 1\n");
		fs.writeFileSync(secondYamlProbe, "b: 2\n");
		fs.mkdirSync(nested);
		fs.writeFileSync(path.join(nested, "inner.json"), '{"c": 3}\n');
		const config = await import("../../clients/lsp/config.js");
		await config.initLSPConfig(workspace);
	});

	beforeEach(() => {
		// No case inherits a warm Opengrep, a start count, a tracked file or a
		// cached batch answer from another (#4391 F2). The reset tears the old
		// generation down; the new one waits for that before its first spawn (#850).
		fs.rmSync(startsMarker, { force: true });
		clearWorkspaceDiagnosticsCache(workspace);
		resetLSPService();
		service = getLSPService();
	});

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-4323-svc-", {
			beforeDrain: async () => {
				await service?.shutdown();
			},
		});
		resetProjectTrust();
		if (savedInstall === undefined)
			delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
		else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
	});

	it("does not start Opengrep for a single-file check", async () => {
		const confirmed: ConfirmedNoBlockers[] = [];
		const result = await diagnose({ path: probe }, noOpengrep, confirmed);

		expect(opengrepStarts()).toBe(0);
		expect(result.text).not.toContain(OPENGREP_FINDING);
		// The language server still answers; the switch narrows nothing else.
		expect(result.details.unconfirmed).not.toBe(true);
		// The clean answer may retire a language-server blocker, never an
		// Opengrep one: Opengrep was not asked.
		expect(confirmed.map((info) => info.coveredSources)).toEqual([["lsp"]]);
	});

	it("says a switched-off Opengrep did not run instead of reporting no findings", async () => {
		// Recurrence: "No auxiliary findings." read like a scanner result when
		// Opengrep was never started (#4391 F8).
		const result = await diagnose({ path: probe }, noOpengrep);

		expect(result.text).toBe(
			"Primary LSP (json): confirmed clean.\n\n" +
				"No auxiliary findings. Switched off, not run: opengrep.",
		);
	});

	it("keeps the plain no-findings line when no auxiliary was asked", async () => {
		// A primary-only check never asks Opengrep, switched off or not, so the
		// switch adds nothing to say.
		const result = await diagnose(
			{ path: probe, serverScope: "primary" },
			noOpengrep,
		);

		expect(result.text).toBe(
			"Primary LSP (json): confirmed clean.\n\nNo auxiliary findings.",
		);
	});

	it("names an enabled opt-in fallow as not run, and never claims its coverage (#4956 F2)", async () => {
		// Recurrence: the all-server door leaves fallow unstarted (an opt-in server
		// the door never starts), yet the covered set named it and the rendered line
		// read as its clean answer: the #4323/#4391 F8 shape on a new server.
		const confirmed: ConfirmedNoBlockers[] = [];
		const result = await diagnose(
			{ path: tsProbe },
			(name) => name === "lens-fallow" || noOpengrep(name),
			confirmed,
		);

		expect(result.text).toBe(
			"Primary LSP (typescript): confirmed clean.\n\n" +
				"No auxiliary findings. Switched off, not run: opengrep. Opt-in, not run by this check: fallow.",
		);
		expect(confirmed.map((info) => info.coveredSources)).toEqual([["lsp"]]);
	});

	it("keeps the plain report, and no fallow claim, while fallow is not enabled (#4956 F2)", async () => {
		// The report of an operator who never asked for fallow is the same bytes it
		// was before the server existed.
		const confirmed: ConfirmedNoBlockers[] = [];
		const result = await diagnose({ path: tsProbe }, noOpengrep, confirmed);

		expect(result.text).toBe(
			"Primary LSP (typescript): confirmed clean.\n\n" +
				"No auxiliary findings. Switched off, not run: opengrep.",
		);
		expect(confirmed.map((info) => info.coveredSources)).toEqual([["lsp"]]);
	});

	it("does not start Opengrep for a batch check", async () => {
		const confirmed: ConfirmedNoBlockers[] = [];
		const result = await diagnose(
			{ paths: [probe, secondProbe] },
			noOpengrep,
			confirmed,
		);

		expect(opengrepStarts()).toBe(0);
		expect(result.text).not.toContain(OPENGREP_FINDING);
		expect(confirmed.map((info) => info.coveredSources)).toEqual([
			["lsp"],
			["lsp"],
		]);
	});

	it("does not serve a workspace sweep's cache entry to a check with Opengrep switched off", async () => {
		// `mode=full` records under `all|opengrep`, before `pi-lens-ignore` is
		// applied. Seed that entry exactly as the sweep's writer does.
		const sweptA = path.join(workspace, "swept-a.json");
		const sweptB = path.join(workspace, "swept-b.json");
		fs.writeFileSync(sweptA, '{"d": 4}\n');
		fs.writeFileSync(sweptB, '{"e": 5}\n');
		// A sweep touches each file before it records, so the JSON server has
		// already heard Created for it; #4320 refuses a finding entry scanned at
		// or before that announcement. Let the server see the files first.
		await diagnose({ paths: [sweptA, sweptB] }, noOpengrep);
		const { buildScopeKey, createWorkspaceDiagnosticsCacheContext } =
			await import("../../clients/lsp/workspace-diagnostics-cache.js");
		const { workspaceFileCreatedAtFor } =
			await import("../../clients/lsp/workspace-diagnostics-session.js");
		const announcedAt = workspaceFileCreatedAtFor(
			(serverId) => serverId === "json",
			() => true,
		);
		const scannedAt = Math.max(Date.now(), announcedAt + 1);
		const sweepCache = createWorkspaceDiagnosticsCacheContext(workspace);
		for (const file of [sweptA, sweptB]) {
			const stat = fs.statSync(file);
			sweepCache.record(
				file,
				buildScopeKey("all", ["opengrep"]),
				[
					{
						range: {
							start: { line: 0, character: 1 },
							end: { line: 0, character: 4 },
						},
						severity: 1,
						message: SWEEP_FINDING,
						source: "json",
						// The sweep stamps each finding with its server (#2776); the
						// loader drops an entry without one.
						serverId: "json",
					},
				],
				stat.mtimeMs,
				undefined,
				stat.size,
				scannedAt,
			);
		}
		sweepCache.persist();

		const result = await diagnose({ paths: [sweptA, sweptB] }, noOpengrep);

		expect(result.text).not.toContain(SWEEP_FINDING);
		// No-drop: both files were still checked, by a fresh touch.
		expect(result.text).toContain("Files checked: 2");
		expect(opengrepStarts()).toBe(0);
	});

	it("does not start Opengrep through the primary-only fallback read", async () => {
		// No YAML server starts, so the touch acquires no client and the tool
		// falls back to an unscoped `getDiagnostics` read.
		const result = await diagnose(
			{ path: yamlProbe, serverScope: "primary" },
			noOpengrep,
		);

		expect(opengrepStarts()).toBe(0);
		expect(result.text).not.toContain(OPENGREP_FINDING);
	});

	it("does not name a switched-off Opengrep as a candidate in the unavailable text", async () => {
		// Recurrence: the YAML server is missing, so the check reports the
		// language server unavailable and lists the servers it could ask; a
		// switched-off Opengrep was listed although it was never asked (#4391 F5).
		const result = await diagnose({ path: yamlProbe }, noOpengrep);

		expect(result.text).toContain("LSP unavailable for");
		expect(result.text).toMatch(/ candidates=yaml\. /);
	});

	it("starts Opengrep and shows its finding when no switch is set", async () => {
		const result = await diagnose({ path: probe });

		expect(opengrepStarts()).toBeGreaterThan(0);
		expect(result.text).toContain(OPENGREP_FINDING);
	});

	it("shows Opengrep's finding through lsp_navigation when no switch is set", async () => {
		const text = await navigateDiagnostics(probe);

		expect(text).toContain(OPENGREP_FINDING);
	});

	it("leaves a running Opengrep's rows out of the path-less lsp_navigation snapshot", async () => {
		// The snapshot starts no server: start Opengrep with an unswitched check.
		await diagnose({ path: probe });
		const before = await navigateDiagnostics(undefined);
		expect(before).toContain(OPENGREP_FINDING);

		const after = await navigateDiagnostics(undefined, noOpengrep, "json");

		expect(after).not.toContain(OPENGREP_FINDING);
		// The JSON server is not switched off: the files it tracks stay in the
		// snapshot, so the switch drops Opengrep's rows and nothing else.
		// Both sides through one normalizer: snapshot keys use forward slashes.
		const { normalizeMapKey } = await import("../../clients/path-utils.js");
		const tracked = (
			JSON.parse(after) as { result: Array<{ filePath: string }> }
		).result.map((entry) => normalizeMapKey(entry.filePath));
		expect(tracked).toContain(normalizeMapKey(probe));
	});

	it("does not serve an Opengrep finding from a batch cached before the switch", async () => {
		// Without the switch, the batch caches Opengrep's finding for both files.
		const before = await diagnose({ paths: [probe, secondProbe] });
		expect(before.text).toContain(OPENGREP_FINDING);

		// Opengrep is warm now; the switch must still keep it out, and the
		// cached all-server answer must not stand in for the narrower check.
		const after = await diagnose({ paths: [probe, secondProbe] }, noOpengrep);

		expect(after.text).not.toContain(OPENGREP_FINDING);
	});

	// The YAML server never starts, so the cases below reach the clientless
	// `getDiagnostics` read. Each control first lets the warm Opengrep answer
	// there, which records its finding as the file's last known answer.
	it("does not show a warm Opengrep's last answer through the primary-only fallback", async () => {
		const before = await diagnose({ path: yamlProbe, serverScope: "primary" });
		expect(before.text).toContain(OPENGREP_FINDING);

		// With the switch the read acquires no client at all; the last known
		// answer it falls back to must not carry Opengrep's rows.
		const after = await diagnose(
			{ path: yamlProbe, serverScope: "primary" },
			noOpengrep,
		);

		expect(after.text).not.toContain(OPENGREP_FINDING);
	});

	it("does not serve a primary-only batch cached before the switch", async () => {
		// Without the switch the primary-only batch caches the fallback's
		// Opengrep finding for both files.
		const before = await diagnose({
			paths: [yamlProbe, secondYamlProbe],
			serverScope: "primary",
		});
		expect(before.text).toContain(OPENGREP_FINDING);

		const after = await diagnose(
			{ paths: [yamlProbe, secondYamlProbe], serverScope: "primary" },
			noOpengrep,
		);

		expect(after.text).not.toContain(OPENGREP_FINDING);
		// No-drop: both files are still checked.
		expect(after.text).toContain("Files checked: 2");
	});

	it("does not show a warm Opengrep's last answer through lsp_navigation", async () => {
		const before = await navigateDiagnostics(secondYamlProbe);
		expect(before).toContain(OPENGREP_FINDING);

		const after = await navigateDiagnostics(secondYamlProbe, noOpengrep);

		expect(after).not.toContain(OPENGREP_FINDING);
	});

	it("keeps the rows of servers it did not exclude from the last known answer", async () => {
		const { normalizeMapKey } = await import("../../clients/path-utils.js");
		const lsp = service as unknown as {
			lastKnownDiagnostics: Map<string, unknown[]>;
			getDiagnostics: (
				file: string,
				mode: "document",
				excludeServerIds: ReadonlySet<string>,
			) => Promise<Array<{ message: string }>>;
		};
		const thirdYaml = path.join(workspace, "third.yaml");
		fs.writeFileSync(thirdYaml, "c: 3\n");
		const row = (message: string, serverId?: string) => ({
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
			severity: 1,
			message,
			source: "stored",
			...(serverId ? { serverId } : {}),
		});
		// The YAML server's row, an Opengrep row, and a row with no server.
		const key = normalizeMapKey(thirdYaml);
		lsp.lastKnownDiagnostics.set(key, [
			row("yaml server's row", "yaml"),
			row(OPENGREP_FINDING, "opengrep"),
			row("row with no server"),
		]);

		// No client starts for this read: the YAML server is missing and
		// Opengrep is excluded, so it falls back to the last known answer.
		const answer = await lsp.getDiagnostics(
			thirdYaml,
			"document",
			new Set(["opengrep"]),
		);

		expect(answer.map((diagnostic) => diagnostic.message)).toEqual([
			"yaml server's row",
			"row with no server",
		]);
		// The shared store still holds all three for callers that did not
		// exclude Opengrep.
		expect(lsp.lastKnownDiagnostics.get(key)).toHaveLength(3);
	});

	it("still prunes an excluded server's deleted files while leaving its rows out", async () => {
		// Recurrence: skipping an excluded client before the prune would let its
		// deleted files' rows outlive them, for every caller that excludes it
		// (#4391 F4). Only this read prunes, so the client itself is the witness.
		const { normalizeMapKey } = await import("../../clients/path-utils.js");
		const gone = path.join(workspace, "gone.json");
		fs.writeFileSync(gone, '{"g": 7}\n');
		await diagnose({ path: gone });
		const opengrep = [
			...(
				service as unknown as {
					state: {
						clients: Map<
							string,
							{ serverId: string; getTrackedDiagnosticPaths: () => string[] }
						>;
					};
				}
			).state.clients.values(),
		].find((client) => client.serverId === "opengrep");
		const tracksGone = () =>
			opengrep
				?.getTrackedDiagnosticPaths()
				.some((tracked) => normalizeMapKey(tracked) === normalizeMapKey(gone));
		// The control: Opengrep is running and tracks the file before it goes.
		expect(tracksGone()).toBe(true);
		fs.rmSync(gone);

		const all = await service!.getAllDiagnostics(new Set(["opengrep"]));

		expect(tracksGone()).toBe(false);
		expect([...all.keys()].map(normalizeMapKey)).not.toContain(
			normalizeMapKey(gone),
		);
	});

	describe("through the actionable-warnings cold read", () => {
		/**
		 * A turn-end build with code actions on, so the loop pulls each file cold.
		 * A cold pull with nothing primed runs off the hook; wait for it.
		 */
		async function buildReport(
			files: string[],
			getFlag?: (name: string) => boolean,
		): Promise<void> {
			const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
				await import("../../clients/actionable-warnings.js");
			await buildActionableWarningsReport({
				cwd: workspace,
				sessionId: "actionable-4323",
				turnIndex: 1,
				files,
				modifiedRangesByFile: new Map(),
				dispatchWarnings: [],
				includeLspCodeActions: true,
				...(getFlag ? { getFlag } : {}),
			});
			await _awaitDeferredLspPullForTest();
		}

		it("does not start Opengrep for a cold file read after a primed one", async () => {
			// The in-band loop: a primed file is read from the service's last-known
			// store, which a real touch fills only when a server reported a finding
			// (the fixture's JSON server answers clean), so seed it as a touch would.
			const { normalizeMapKey } = await import("../../clients/path-utils.js");
			const { createHash } = await import("node:crypto");
			const key = normalizeMapKey(secondProbe);
			const lsp = service as unknown as {
				lastKnownDiagnostics: Map<string, unknown[]>;
				lastKnownContentHash: Map<string, string>;
			};
			lsp.lastKnownDiagnostics.set(key, [
				{
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
					severity: 2,
					message: "primed by an earlier touch",
					source: "json",
					serverId: "json",
				},
			]);
			lsp.lastKnownContentHash.set(
				key,
				createHash("sha256")
					.update(fs.readFileSync(secondProbe, "utf-8"))
					.digest("hex"),
			);

			await buildReport([secondProbe, probe], noOpengrep);

			expect(opengrepStarts()).toBe(0);
		});

		it("starts Opengrep when no switch is set", async () => {
			await buildReport([probe]);

			expect(opengrepStarts()).toBeGreaterThan(0);
		});
	});
});
