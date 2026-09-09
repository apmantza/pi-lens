/**
 * `effectiveConfig()` — the "why is X running / selected" query (#2427).
 *
 * Everything here drives the PRODUCTION path: real config files on disk, the
 * real `resolvePiLensConfig` + `initLSPConfig` sequence, and the real LSP
 * registry. Nothing is hand-fed a shaped resolution — the point of the surface
 * is that its answer and the runtime's answer are the same computation, and a
 * test that supplied its own resolution would prove the opposite.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// Statically imported, NOT `await import()` inside the first test body. Both
// spellings work — each of these reads `PI_LENS_HOME` lazily, per call — but a
// dynamic import pays for the whole module graph (config resolution, the LSP
// registry, the dispatch plan) inside the first `it()`, where it counts
// against `testTimeout`. That is ~5s on this graph, i.e. a 5000ms default that
// passes or fails on machine load rather than on behavior.
import {
	effectiveConfig,
	type EffectiveConfigView,
	type EffectiveFileView,
	type EffectiveServerDecision,
	isEffectiveFileViewError,
} from "../../clients/effective-config.js";
import {
	explainServersForFile,
	initLSPConfig,
	isServerDisabled,
	loadLSPConfig,
	resetLSPConfigStateForTests,
	resetLSPConfigWarnCache,
	type ServerSelection,
} from "../../clients/lsp/config.js";
import {
	isOutsideAllSessionRoots,
	isSessionRootRegistered,
} from "../../clients/lsp/session-roots.js";
// The production rewriter, so an expected provenance path is derived by the
// same function the view uses rather than spelled as a literal that would
// agree with a wrong implementation on one platform.
import { homeRelativePath } from "../../clients/path-utils.js";
import { removeTempDirSync } from "./test-utils.js";

// The extension log is an ndjson sink, not the terminal; a fixture that
// deliberately carries a legacy location would otherwise spray test output.
// CAPTURED rather than discarded (#2427 review round 2, F6): the surface
// contract is that asking a question fires no user-facing notice, and a mock
// that throws the notices away cannot tell a suppressed one from an absent one.
const logSink = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: { message: string }) => {
			logSink.messages.push(entry.message);
		},
	};
});

const tempRoots: string[] = [];

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) removeTempDirSync(root);
	}
});

interface Layout {
	/** Files written relative to the FAKE HOME. */
	readonly files: Readonly<Record<string, unknown>>;
	/** Project directory, relative to the fake home. */
	readonly startDir: string;
}

/**
 * Lay a fixture home out on disk and run `effectiveConfig` against it exactly
 * the way a session does: `PI_LENS_HOME` / `PI_LENS_CONFIG_PATH` point the
 * global tier at the fixture, and `homeDir` is the ceiling the project walk
 * stops at (also the `$HOME` the redaction rewrites against).
 */
async function viewFor(
	layout: Layout,
	options: { file?: string } = {},
): Promise<{
	view: EffectiveConfigView;
	home: string;
	projectDir: string;
}> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-effcfg-"));
	tempRoots.push(home);
	for (const [relative, content] of Object.entries(layout.files)) {
		const target = path.join(home, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, JSON.stringify(content, null, 2));
	}
	const projectDir = path.join(home, layout.startDir);
	fs.mkdirSync(projectDir, { recursive: true });

	const previousHome = process.env.PI_LENS_HOME;
	const previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
	process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
	process.env.PI_LENS_CONFIG_PATH = path.join(home, ".pi-lens", "config.json");

	resetLSPConfigStateForTests();
	resetLSPConfigWarnCache();

	try {
		const view = await effectiveConfig({
			cwd: projectDir,
			homeDir: home,
			redact: true,
			...(options.file === undefined ? {} : { file: options.file }),
		});
		return { view, home, projectDir };
	} finally {
		if (previousHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = previousHome;
		if (previousConfigPath === undefined)
			delete process.env.PI_LENS_CONFIG_PATH;
		else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
	}
}

/**
 * Narrow `view.file` to the resolved shape. Every test in this file below
 * the dedicated #2520 confinement `describe` queries a `file` inside `cwd`,
 * so it never sees the `{ error }` rejection shape — this throws instead of
 * silently coercing past it if one ever did, which would mean the FIXTURE,
 * not the assertion, needs fixing.
 */
function resolvedFile(
	view: EffectiveConfigView,
): EffectiveFileView | undefined {
	const file = view.file;
	if (file === undefined) return undefined;
	if (isEffectiveFileViewError(file)) {
		throw new Error(`effectiveConfig rejected the file: ${file.error}`);
	}
	return file;
}

/** Fixture layout keys, assembled so no literal path appears in the source. */
const GLOBAL_CONFIG = [".pi-lens", "config.json"].join("/");
const PROJECT_CONFIG = ["proj", ".pi-lens.json"].join("/");
const LEGACY_PROJECT_LSP = ["proj", "pi-lsp.json"].join("/");
const TYPOS_POINTER = ["", "lsp", "disabledServers", "0"].join("/");
const MARKSMAN_POINTER = ["", "lsp", "disabledServers", "1"].join("/");

/**
 * The command the WORKSPACE-ROOT layer gives `shared`, and the command the
 * NESTED layer redefines it to. Distinct strings because the whole question
 * F-R4-1 raised is which of the two the query reports (#2427 review round 5).
 */
const ROOT_COMMAND = "root-shared-lsp";
const SUB_COMMAND = "sub-shared-lsp";

/** One custom-server definition, identical but for the command. */
function sharedServer(command: string): Record<string, unknown> {
	return {
		name: "Shared LSP",
		extensions: [".md"],
		command,
		args: ["--stdio"],
		rootMarkers: ["package.json"],
	};
}

/** A canonical-namespace document denying one server. */
function denyDoc(...ids: string[]): Record<string, unknown> {
	const lsp: Record<string, unknown> = { disabledServers: ids };
	const document: Record<string, unknown> = {};
	document.lsp = lsp;
	return document;
}

describe("effectiveConfig — provenance of the resolution", () => {
	it("names the file and tier every resolved leaf came from, without carrying values", async () => {
		const { view } = await viewFor({
			files: {
				".pi-lens/config.json": { maxProjectFiles: 8000 },
				"proj/.pi-lens.json": { ignore: ["dist/**"] },
			},
			startDir: "proj",
		});

		expect(view.documents.map((entry) => entry.tier)).toEqual([
			"global",
			"project",
		]);
		const byKey = new Map(view.provenance.map((entry) => [entry.key, entry]));
		expect(byKey.get("/maxProjectFiles")?.tier).toBe("global");
		expect(byKey.get("/ignore")?.tier).toBe("project");
		// Sources only. A value that reached this projection would be a leak the
		// shape is supposed to make impossible.
		expect(JSON.stringify(view.provenance)).not.toContain("8000");
		expect(JSON.stringify(view.provenance)).not.toContain("dist/**");
		expect(view.provenanceCounts.global).toBeGreaterThan(0);
		expect(view.provenanceCounts.project).toBeGreaterThan(0);
		expect(view.provenanceCounts.cli).toBe(0);
	});

	it("counts records by their stable code instead of re-rendering the prose", async () => {
		const { view } = await viewFor({
			// A legacy ROOT key inside a canonical file: one PILENS_CFG_0002 per
			// (file, key), and no user-facing warning fired by the question itself.
			files: { "proj/.pi-lens.json": { disabledServers: ["typos"] } },
			startDir: "proj",
		});
		expect(view.recordCounts.PILENS_CFG_0002).toBeGreaterThanOrEqual(1);
	});
});

describe("effectiveConfig — why is X running (#2415 AC)", () => {
	/**
	 * THE acceptance criterion: a global deny that a project file tries to
	 * clear resolves to DENIED, attributed to the global tier.
	 *
	 * Before #2427 this scenario resolved the other way through the production
	 * loader — `loadLSPConfig` returned `disabledServers: []` attributed to
	 * `project`, so repository content re-enabled a server the operator had
	 * turned off. The deny machinery existed (`config-core/deny.ts`, #2440) but
	 * no schema node annotated it, so `merge()` never reached it.
	 */
	it("reports a globally denied server as denied, with the GLOBAL provenance, when the project tries to re-enable it", async () => {
		const { view } = await viewFor(
			{
				files: {
					".pi-lens/config.json": { lsp: { disabledServers: ["typos"] } },
					"proj/.pi-lens.json": { lsp: { disabledServers: [] } },
				},
				startDir: "proj",
			},
			{ file: "notes.md" },
		);

		const typos = resolvedFile(view)?.servers.find(
			(entry) => entry.id === "typos",
		);
		expect(typos).toBeDefined();
		expect(typos?.selected).toBe(false);
		expect(typos?.reason).toBe("disabled-by-config");
		expect(typos?.decidedBy?.tier).toBe("global");
		// The MEMBER pointer, not the array: the union is built from several
		// tiers and each surviving member carries the provenance of the tier that
		// contributed it (#2427 review round 2, F2).
		expect(typos?.decidedBy?.key).toBe(TYPOS_POINTER);
		// And the resolution itself agrees — the view is not reporting a decision
		// the merge did not make.
		const leaf = view.provenance.find(
			(entry) => entry.key === "/lsp/disabledServers",
		);
		expect(leaf?.tier).toBe("global");
	});

	it("the LOADER agrees — `loadLSPConfig` hands the runtime the denied set, not the project's empty one", async () => {
		// The view is only worth having if it describes what actually runs. This
		// asserts the same scenario one layer down, at the production loader that
		// feeds `initLSPConfig`'s disable set: pre-#2427 it returned `[]` here.
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-effcfg-"));
		tempRoots.push(home);
		const global = path.join(home, ".pi-lens", "config.json");
		fs.mkdirSync(path.dirname(global), { recursive: true });
		fs.writeFileSync(
			global,
			JSON.stringify({ lsp: { disabledServers: ["typos"] } }),
		);
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, ".pi-lens.json"),
			JSON.stringify({ lsp: { disabledServers: [] } }),
		);

		const previousHome = process.env.PI_LENS_HOME;
		const previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
		process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
		process.env.PI_LENS_CONFIG_PATH = global;
		try {
			resetLSPConfigWarnCache();
			expect((await loadLSPConfig(projectDir, home)).disabledServers).toEqual([
				"typos",
			]);
		} finally {
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			if (previousConfigPath === undefined)
				delete process.env.PI_LENS_CONFIG_PATH;
			else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
		}
	});

	it("a server the project denies is denied too — the union only ever grows", async () => {
		const { view } = await viewFor(
			{
				files: {
					".pi-lens/config.json": { lsp: { disabledServers: ["typos"] } },
					"proj/.pi-lens.json": { lsp: { disabledServers: ["marksman"] } },
				},
				startDir: "proj",
			},
			{ file: "notes.md" },
		);
		const denied = new Set(
			resolvedFile(view)
				?.servers.filter((entry) => entry.reason === "disabled-by-config")
				.map((entry) => entry.id),
		);
		expect(denied.has("typos")).toBe(true);
		expect(denied.has("marksman")).toBe(true);
	});

	/**
	 * PER-MEMBER attribution (#2427 review round 2, F2).
	 *
	 * The deny union is one array built from several tiers, so one provenance
	 * entry cannot describe it: round 1 read the entry at the ARRAY pointer and
	 * stamped it on every disabled server, which reported the project-tier
	 * denial of marksman as a global one. The answer to "why can I not turn
	 * this back on" is per member, so the provenance is per member.
	 */
	it("attributes each denied server to the tier that actually denied IT", async () => {
		const files: Record<string, unknown> = {};
		files[GLOBAL_CONFIG] = denyDoc("typos");
		files[PROJECT_CONFIG] = denyDoc("marksman");
		const layout: Layout = { files, startDir: "proj" };
		const result = await viewFor(layout, { file: "notes.md" });
		const servers = resolvedFile(result.view)?.servers ?? [];
		const byId = new Map(servers.map((entry) => [entry.id, entry] as const));
		expect(byId.get("typos")?.reason).toBe("disabled-by-config");
		expect(byId.get("marksman")?.reason).toBe("disabled-by-config");
		expect(byId.get("typos")?.decidedBy?.tier).toBe("global");
		expect(byId.get("marksman")?.decidedBy?.tier).toBe("project");
		// And each names the member it is the provenance OF, not the array.
		expect(byId.get("typos")?.decidedBy?.key).toBe(TYPOS_POINTER);
		expect(byId.get("marksman")?.decidedBy?.key).toBe(MARKSMAN_POINTER);
	});

	it("says why a server did NOT attach, distinguishing a denial from a mismatch", async () => {
		const { view } = await viewFor(
			{
				files: {
					".pi-lens/config.json": { lsp: { disabledServers: ["typos"] } },
				},
				startDir: "proj",
			},
			{ file: "notes.md" },
		);
		const reasons = new Map(
			resolvedFile(view)?.servers.map((entry) => [entry.id, entry.reason]),
		);
		expect(reasons.get("typos")).toBe("disabled-by-config");
		// A Rust server has nothing to do with a markdown file, and that is a
		// different answer from "you turned it off".
		expect(reasons.get("rust")).toBe("extension-mismatch");
		expect(resolvedFile(view)?.language).toBe("markdown");
	});

	/**
	 * The GATE ORDER, made non-vacuous (#2427 review round 2, F5).
	 *
	 * `selectionReason` documents that "you turned it off" outranks "this file
	 * is not yours" — a server the operator disabled reports
	 * `disabled-by-config` even when the extension would not have matched
	 * anyway. Every case that existed for it disabled a server the file DID
	 * match, so the documented order was never exercised and moving the disable
	 * check below the extension check left the suite green.
	 *
	 * Here `rust` is disabled and the file is markdown, so the two gates
	 * disagree and only the order can decide.
	 */
	it("reports a disabled server as disabled even when the extension would not match", async () => {
		const files: Record<string, unknown> = {};
		files[GLOBAL_CONFIG] = denyDoc("rust");
		const layout: Layout = { files, startDir: "proj" };
		const result = await viewFor(layout, { file: "notes.md" });
		const rust = resolvedFile(result.view)?.servers.find(
			(entry) => entry.id === "rust",
		);
		expect(rust).toBeDefined();
		expect(rust?.selected).toBe(false);
		expect(rust?.reason).toBe("disabled-by-config");
		// And the ordinary mismatch answer is still reachable, so this is a
		// discrimination test rather than a constant.
		const python = resolvedFile(result.view)?.servers.find(
			(entry) => entry.id === "python",
		);
		expect(python?.reason).toBe("extension-mismatch");
	});

	it("resolves the file's language and the runners that would dispatch for it", async () => {
		const { view } = await viewFor(
			{ files: {}, startDir: "proj" },
			{ file: "main.py" },
		);
		expect(resolvedFile(view)?.language).toBe("python");
		expect(resolvedFile(view)?.kind).toBe("python");
		expect(resolvedFile(view)?.tools.length).toBeGreaterThan(0);
		for (const tool of resolvedFile(view)?.tools ?? []) {
			expect([
				"selected",
				"not-registered-for-kind",
				"no-dispatch-plan",
			]).toContain(tool.reason);
		}
	});
});

describe("effectiveConfig — redaction is unconditional", () => {
	it("never carries an env value, an argv tail, or an absolute $HOME path", async () => {
		const { view, home, projectDir } = await viewFor(
			{
				files: {
					"proj/.pi-lens.json": {
						lsp: {
							servers: {
								"secret-server": {
									name: "Secret",
									extensions: [".md"],
									command: "my-lsp",
									args: ["--stdio", "--token", "ARGV_SECRET_ZZZ"],
									env: { AUTH_TOKEN: "ENV_SECRET_ZZZ" },
								},
							},
						},
					},
				},
				startDir: "proj",
			},
			{ file: "notes.md" },
		);

		const serialized = JSON.stringify(view);
		expect(serialized).not.toContain("ARGV_SECRET_ZZZ");
		expect(serialized).not.toContain("ENV_SECRET_ZZZ");
		// The absolute fixture $HOME must not appear anywhere: every path is
		// rewritten home-relative.
		expect(serialized).not.toContain(JSON.stringify(home).slice(1, -1));
		expect(view.cwd.startsWith("~/")).toBe(true);
		expect(resolvedFile(view)?.path.startsWith("~/")).toBe(true);
		for (const document of view.documents) {
			expect(document.file.startsWith("~/")).toBe(true);
		}

		// What DOES survive is the part that answers the question: the server
		// exists, it came from the project file, and this is the binary.
		const custom = resolvedFile(view)?.servers.find(
			(entry) => entry.id === "secret-server",
		);
		expect(custom?.spec?.command).toBe("my-lsp");
		expect(custom?.spec?.argvCount).toBe(4);
		expect(custom?.spec?.envNames).toEqual(["AUTH_TOKEN"]);
		expect(custom?.decidedBy?.tier).toBe("project");
		expect(projectDir).toContain("proj");
	});

	it("reports a legacy config location as legacy rather than silently reading it", async () => {
		const { view } = await viewFor({
			files: { "proj/pi-lsp.json": { disabledServers: ["typos"] } },
			startDir: "proj",
		});
		const legacy = view.documents.filter((document) => document.legacy);
		expect(legacy.length).toBe(1);
		expect(legacy[0].file.endsWith("pi-lsp.json")).toBe(true);
	});
});

describe("effectiveConfig — asking must not report (#2427 rule 2)", () => {
	/**
	 * The per-file path drives `initLSPConfig`, and that used to fire the
	 * loader deprecation notices and consume the process-lifetime warn-once
	 * latch (review round 2, F6). A QUESTION that answers itself by
	 * warning the user — and then leaves the session-start load with nothing
	 * left to say — is the opposite of the surface contract.
	 */
	it("does not fire a legacy-location notice, and leaves the latch for the loader", async () => {
		const files: Record<string, unknown> = {};
		files[LEGACY_PROJECT_LSP] = { disabledServers: ["typos"] };
		const layout: Layout = { files, startDir: "proj" };
		logSink.messages.length = 0;
		const result = await viewFor(layout, { file: "notes.md" });
		// The view still SEES the legacy document and still counts its record.
		expect(result.view.documents.some((d) => d.legacy)).toBe(true);
		expect(result.view.recordCounts.PILENS_CFG_0003).toBeGreaterThanOrEqual(1);
		expect(logSink.messages).toEqual([]);

		// And the latch is untouched: the loader that OWNS the notice still says
		// it. This is the half that a bare "no output" assertion would miss —
		// suppressing by consuming the latch looks identical from inside the
		// query and is exactly the defect.
		const previousHome = process.env.PI_LENS_HOME;
		const previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
		process.env.PI_LENS_HOME = path.join(result.home, ".pi-lens");
		process.env.PI_LENS_CONFIG_PATH = path.join(
			result.home,
			".pi-lens",
			"config.json",
		);
		try {
			await loadLSPConfig(result.projectDir, result.home);
		} finally {
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			if (previousConfigPath === undefined)
				delete process.env.PI_LENS_CONFIG_PATH;
			else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
		}
		expect(logSink.messages.join("\n")).toContain("deprecated");
	});
});

/**
 * A QUESTION MUST CHANGE NO SESSION STATE (#2427 review round 3, N2).
 *
 * The per-file half used to answer by calling `initLSPConfig(cwd)`, which is
 * the session-root registry's single writer and the per-root config store's
 * only producer. Both are session DECLARATIONS — "this process serves this
 * root, and here is its resolved server config" — so routing a read-only query
 * through them inverted the surface's own contract in two ways:
 *
 *  1. It enrolled a caller-supplied foreign directory as a served LSP root,
 *     permanently widening the #2052 access gate for a tree the session never
 *     opened.
 *  2. It wrote the per-root config store. Enough queries against other
 *     directories EVICT a live root's config, after which `getConfigForFile`
 *     falls back to EMPTY and the operator's `disabledServers` denial silently
 *     lifts. Before #2518 the store was a separate 32-entry LRU beside a
 *     128-entry registry, so `shouldInitializeSessionRoot` never re-initialized
 *     the evicted root either; now the eviction takes the registration with it,
 *     but a query that writes the store still enrolls a foreign root.
 *
 * The fix is that the query derives its own registered config from
 * `loadLSPConfig(..., { report: false })` and hands it to
 * `explainServersForFile`, so there is no write to delete later.
 */
describe("effectiveConfig — asking changes no session state (#2427 round 3)", () => {
	interface RootScenario {
		readonly home: string;
		readonly liveRoot: string;
		readonly foreignDir: string;
		/**
		 * A directory NESTED under `liveRoot` with its own `.pi-lens.json` —
		 * `repo/sub/.pi-lens.json` layering (config.ts header point 3). It
		 * denies `marksman` (P-E) and adds a custom server, `sub-only`, that
		 * exists nowhere else (P-F). The runtime registers config at exactly
		 * this directory for a file inside it —
		 * `ensureLSPConfigInitialized(path.dirname(filePath))` in
		 * `runtime-tool-call.ts:699-703` — never at `liveRoot`.
		 */
		readonly subDir: string;
		/**
		 * The WORKSPACE-ROOT `.pi-lens.json` — the only project document a
		 * resolution taken at `liveRoot` can see.
		 */
		readonly liveConfig: string;
		/**
		 * The NESTED `.pi-lens.json` — the document the runtime actually
		 * decides a file under `sub` from.
		 */
		readonly subConfig: string;
		readonly restore: () => void;
	}

	/**
	 * One fixture home with a GLOBAL deny, a directory a session really
	 * initializes, and a second directory only ever named by a query. The env
	 * pin is held across the whole scenario rather than per call: the defect is
	 * about state that survives between calls, so a helper that reset the
	 * registry each time could not observe it.
	 */
	function rootScenario(): RootScenario {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-effcfg-r-"));
		tempRoots.push(home);
		const globalConfig = path.join(home, ".pi-lens", "config.json");
		const liveRoot = path.join(home, "live");
		const foreignDir = path.join(home, "foreign");
		const subDir = path.join(liveRoot, "sub");
		for (const dir of [
			path.dirname(globalConfig),
			liveRoot,
			foreignDir,
			subDir,
		]) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const ids = ["typos"];
		const denySection = { disabledServers: ids };
		const denyDocument: Record<string, unknown> = { lsp: denySection };
		fs.writeFileSync(globalConfig, JSON.stringify(denyDocument));

		// The WORKSPACE-ROOT layer. It defines `shared` with the ROOT command,
		// which the nested layer below redefines: this is the document a
		// resolution taken at `liveRoot` reads, and the one the runtime does
		// NOT decide from for a file under `sub`.
		const liveConfig = path.join(liveRoot, ".pi-lens.json");
		const liveDocument: Record<string, unknown> = {
			lsp: { servers: { shared: sharedServer(ROOT_COMMAND) } },
		};
		fs.writeFileSync(liveConfig, JSON.stringify(liveDocument));

		// The nested layer P13 exists to prove reachable: a project-level deny
		// (P-E), a custom server found NOWHERE else (P-F), and a REDEFINITION of
		// the root's `shared` (P-G) — all scoped to `sub` alone, so a query
		// derived from `liveRoot` sees none of the three.
		const subConfig = path.join(subDir, ".pi-lens.json");
		const subDocument: Record<string, unknown> = {
			lsp: {
				disabledServers: ["marksman"],
				servers: {
					"sub-only": {
						name: "Sub Only LSP",
						extensions: [".md"],
						command: "sub-only-lsp",
						args: ["--stdio"],
						rootMarkers: ["package.json"],
					},
					shared: sharedServer(SUB_COMMAND),
				},
			},
		};
		fs.writeFileSync(subConfig, JSON.stringify(subDocument));

		const previousHome = process.env.PI_LENS_HOME;
		const previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
		process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
		process.env.PI_LENS_CONFIG_PATH = globalConfig;
		resetLSPConfigStateForTests();
		resetLSPConfigWarnCache();
		const restore = (): void => {
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			if (previousConfigPath === undefined)
				delete process.env.PI_LENS_CONFIG_PATH;
			else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
			resetLSPConfigStateForTests();
		};
		return {
			home,
			liveRoot,
			foreignDir,
			subDir,
			liveConfig,
			subConfig,
			restore,
		};
	}

	/** P11: the queried cwd never becomes a served root. */
	it("does not enrol the queried directory as a session root", async () => {
		const scenario = rootScenario();
		try {
			// A session declares exactly ONE root, the way every real entry point
			// does. The registry is non-empty, so the #2052 gate is live and
			// declining is possible at all (it fails OPEN on an empty registry).
			await initLSPConfig(scenario.liveRoot);
			expect(isSessionRootRegistered(scenario.liveRoot)).toBe(true);
			expect(isSessionRootRegistered(scenario.foreignDir)).toBe(false);

			await effectiveConfig(queryFor(scenario.foreignDir, scenario.home));

			expect(isSessionRootRegistered(scenario.foreignDir)).toBe(false);
			// And the gate still refuses a file under it — asking about a tree is
			// not the same as the session serving that tree.
			const foreignFile = path.join(scenario.foreignDir, "notes.md");
			expect(isOutsideAllSessionRoots(foreignFile)).toBe(true);
		} finally {
			scenario.restore();
		}
	});

	/** P12: the LRU is never written, so a live root's config cannot be evicted. */
	it("leaves a live root's denial intact after 40 queries elsewhere", async () => {
		const scenario = rootScenario();
		try {
			await initLSPConfig(scenario.liveRoot);
			const liveFile = path.join(scenario.liveRoot, "notes.md");
			expect(isServerDisabled("typos", liveFile)).toBe(true);

			// More than the LRU's 32 slots. Every directory is a SIBLING of the
			// live root, so none of them is an ancestor that could legitimately
			// answer for `liveFile`.
			for (let index = 0; index < 40; index += 1) {
				const other = path.join(scenario.home, `other-${index}`);
				fs.mkdirSync(other, { recursive: true });
				await effectiveConfig(queryFor(other, scenario.home));
			}

			// The operator's denial is still in force ...
			expect(isServerDisabled("typos", liveFile)).toBe(true);
			// ... and the root is still served, so nothing has to reinitialize
			// it — which `shouldInitializeSessionRoot` would not do anyway.
			expect(isSessionRootRegistered(scenario.liveRoot)).toBe(true);
		} finally {
			scenario.restore();
		}
	}, 60_000);

	/**
	 * P13: deriving the config instead of reading the session registry must not
	 * change the ANSWER — including for a NESTED `.pi-lens.json` the runtime
	 * only reaches because it registers config at the FILE's OWN directory,
	 * never at the workspace root (#2427 review round 4, F1).
	 *
	 * `repo/sub/.pi-lens.json` layers a project-level deny (`marksman`, P-E)
	 * and a custom server that exists nowhere else (`sub-only`, P-F) onto the
	 * global deny (`typos`) that already covers the whole tree. The session
	 * mirrors what the runtime actually does for a tool call on a file under
	 * `sub`: it registers `liveRoot` once (session start) AND `subDir`
	 * separately (`ensureLSPConfigInitialized(path.dirname(filePath))`,
	 * `runtime-tool-call.ts:699-703`) — it never re-registers `liveRoot` for
	 * that call. `getConfigForFile` then answers with the deepest match,
	 * `subDir`.
	 *
	 * Before F1, the query derived its config from `cwd` (`liveRoot`) alone,
	 * which `resolvePiLensConfig` only walks UPWARD from — `subDir` is a
	 * CHILD of `liveRoot`, so its `.pi-lens.json` was never read. The query
	 * then answered `marksman` as `selected` (a denial the session enforces,
	 * silently under-reported) and omitted `sub-only` entirely (an addition
	 * the session serves, silently absent) — the differential this test pins.
	 */
	it("answers exactly what the session path answers for a nested config", async () => {
		const scenario = rootScenario();
		try {
			const subFile = path.join(scenario.subDir, "notes.md");
			await initLSPConfig(scenario.liveRoot);
			await initLSPConfig(scenario.subDir);
			const session = explainServersForFile(subFile).map(registryDecision);
			// Non-vacuous on all three axes: the full registry, the global deny,
			// the nested deny, and the nested addition.
			expect(session.length).toBeGreaterThan(30);
			expect(session.some(isDeniedTypos)).toBe(true);
			expect(session.some(isDeniedMarksman)).toBe(true);
			expect(session.some(isSelectedSubOnly)).toBe(true);

			const view = await nestedView(scenario);
			const queried = (resolvedFile(view)?.servers ?? []).map(viewDecision);
			expect(queried.map(core)).toEqual(session);
		} finally {
			scenario.restore();
		}
	});

	/**
	 * P14 — the SPEC the view reports is the definition the runtime would
	 * spawn (#2427 review round 5, F-R4-1).
	 *
	 * Round 4 moved the LSP load to the file's own directory but left every
	 * other fact — the spec, the provenance, the documents — read off a SECOND
	 * resolution taken at the workspace root. With `shared` defined at
	 * `liveRoot` and redefined at `liveRoot/sub`, that split is directly
	 * observable: the gates answer from the nested definition while the
	 * reported `spec.command` names the root's. A user reading this surface
	 * to answer "what is actually being launched" got the wrong binary.
	 */
	it("reports the spec the runtime would spawn, not the workspace root's", async () => {
		const scenario = rootScenario();
		try {
			// What the RUNTIME registers for a file under `sub`: the production
			// loader at `path.dirname(filePath)`, the directory
			// `ensureLSPConfigInitialized` uses in `runtime-tool-call.ts`.
			const runtime = await loadLSPConfig(scenario.subDir, scenario.home, {
				report: false,
			});
			const runtimeCommand = runtime.servers?.shared?.command;
			// Non-vacuous on both sides: the nested layer really does win here,
			// and the workspace root really does say something else.
			expect(runtimeCommand).toBe(SUB_COMMAND);
			const atRoot = await loadLSPConfig(scenario.liveRoot, scenario.home, {
				report: false,
			});
			expect(atRoot.servers?.shared?.command).toBe(ROOT_COMMAND);

			const view = await nestedView(scenario);
			const shared = (resolvedFile(view)?.servers ?? [])
				.map(viewDecision)
				.find((entry) => entry.id === "shared");
			expect(shared).toBeDefined();
			expect(shared?.specCommand).toBe(runtimeCommand);
			// ... and the provenance names the file that carries THAT command.
			expect(shared?.decidedByFile).toBe(
				homeRelativePath(scenario.subConfig, scenario.home),
			);
			expect(shared?.decidedByTier).toBe("nested-project");
		} finally {
			scenario.restore();
		}
	});

	/**
	 * P15 — a nested denial is attributed to the file that denied IT.
	 *
	 * Round 2's F2 misattribution, reopened by the second resolution root, and
	 * failing in the most misleading direction available. The workspace-root
	 * resolution's deny union is `["typos"]` (global), so `marksman` has no
	 * member entry there; `provenanceFor` walks up to the ARRAY entry and
	 * hands back the GLOBAL file. The operator is then told to edit a
	 * machine-global config to re-enable a server their own
	 * `sub/.pi-lens.json` turned off — which docs/configuration.md instructs
	 * them to do verbatim.
	 */
	it("attributes a nested denial to the nested file, not to the global deny", async () => {
		const scenario = rootScenario();
		try {
			const view = await nestedView(scenario);
			const byId = new Map(
				(resolvedFile(view)?.servers ?? [])
					.map(viewDecision)
					.map((entry) => [entry.id, entry] as const),
			);
			const marksman = byId.get("marksman");
			expect(marksman?.reason).toBe("disabled-by-config");
			expect(marksman?.decidedByTier).toBe("nested-project");
			expect(marksman?.decidedByFile).toBe(
				homeRelativePath(scenario.subConfig, scenario.home),
			);
			// The global denial is still the global file's — the fix must not
			// simply move every attribution to the nearest document.
			const typos = byId.get("typos");
			expect(typos?.reason).toBe("disabled-by-config");
			expect(typos?.decidedByTier).toBe("global");
		} finally {
			scenario.restore();
		}
	});

	/**
	 * P16 — `documents` names every file the answer was resolved from.
	 *
	 * The AC asks for the file behind every decision; a list that omits the
	 * nested layer cannot support the decisions the same view reports from it.
	 */
	it("lists the nested document the file answer was resolved from", async () => {
		const scenario = rootScenario();
		try {
			const view = await nestedView(scenario);
			const files = view.documents.map((document) => document.file);
			expect(files).toContain(
				homeRelativePath(scenario.liveConfig, scenario.home),
			);
			expect(files).toContain(
				homeRelativePath(scenario.subConfig, scenario.home),
			);
		} finally {
			scenario.restore();
		}
	});

	/**
	 * The query the runtime's nested case corresponds to: the workspace root as
	 * `cwd`, a file one directory down.
	 */
	async function nestedView(
		scenario: RootScenario,
	): Promise<EffectiveConfigView> {
		return effectiveConfig({
			cwd: scenario.liveRoot,
			homeDir: scenario.home,
			redact: true as const,
			file: path.join("sub", "notes.md"),
		});
	}

	function queryFor(cwd: string, homeDir: string) {
		const file = "notes.md";
		return { cwd, homeDir, redact: true as const, file };
	}

	interface Decision {
		readonly id: string;
		readonly selected: boolean;
		readonly reason: string;
	}

	function registryDecision(entry: ServerSelection): Decision {
		const id = entry.server.id;
		const selected = entry.selected;
		const reason = entry.reason;
		return { id, selected, reason };
	}

	/**
	 * The view's answer for one server INCLUDING the three facts round 4 left
	 * reading a different resolution from the one the gates were evaluated
	 * against: which file decided, which tier that was, and which command the
	 * reported spec names (#2427 review round 5, F-R4-1).
	 */
	interface ViewedDecision extends Decision {
		readonly decidedByFile?: string;
		readonly decidedByTier?: string;
		readonly specCommand?: string;
	}

	function viewDecision(entry: EffectiveServerDecision): ViewedDecision {
		const id = entry.id;
		const selected = entry.selected;
		const reason = entry.reason;
		return {
			id,
			selected,
			reason,
			...(entry.decidedBy?.file === undefined
				? {}
				: { decidedByFile: entry.decidedBy.file }),
			...(entry.decidedBy?.tier === undefined
				? {}
				: { decidedByTier: entry.decidedBy.tier }),
			...(entry.spec?.command === undefined
				? {}
				: { specCommand: entry.spec.command }),
		};
	}

	/**
	 * The registry can only answer id/selected/reason — provenance is a
	 * property of the RESOLUTION, not of the LSP gate — so the equality against
	 * the session path narrows to what both sides know.
	 */
	function core(entry: ViewedDecision): Decision {
		const id = entry.id;
		const selected = entry.selected;
		const reason = entry.reason;
		return { id, selected, reason };
	}

	function isDeniedTypos(entry: Decision): boolean {
		const denied = entry.reason === "disabled-by-config";
		return entry.id === "typos" && denied;
	}

	function isDeniedMarksman(entry: Decision): boolean {
		const denied = entry.reason === "disabled-by-config";
		return entry.id === "marksman" && denied;
	}

	function isSelectedSubOnly(entry: Decision): boolean {
		return entry.id === "sub-only" && entry.selected;
	}
});

/**
 * CONFINE, not assume (#2520). Before this fix, `effectiveConfig` resolved
 * the per-file half from the FILE's own directory unconditionally — correct
 * when `file` is inside `cwd` (the whole point of the nested-config tests
 * above), silently wrong when it is not: a sibling tree's `.pi-lens.json`
 * answered for the query while `view.cwd` still named the unrelated
 * workspace, `documents` omitted the workspace's own config, and the
 * "SUPERSET of the workspace's" invariant the module doc claims did not hold.
 */
/**
 * The rejection message names the `cwd` it was measured against (home-
 * relative, like every other path this module reports) plus the remedy — an
 * agent seeing `{ error }` with no `cwd` and no next step has no way to tell
 * a real mistake from a workspace boundary it should re-query around (#2520
 * round 2, F3).
 */
function outsideCwdError(homeRelativeCwd: string): { error: string } {
	return {
		error:
			`file is outside cwd (${homeRelativeCwd}); query with cwd set ` +
			"to the file's own workspace instead",
	};
}

describe("effectiveConfig — a file outside cwd is rejected, not silently resolved (#2520)", () => {
	it("returns an informative { error } instead of a foreign tree's answer", async () => {
		const home = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-effcfg-confine-"),
		);
		tempRoots.push(home);
		const ws = path.join(home, "ws");
		const foreign = path.join(home, "foreign");
		fs.mkdirSync(ws, { recursive: true });
		fs.mkdirSync(foreign, { recursive: true });
		const wsConfig = path.join(ws, ".pi-lens.json");
		const foreignConfig = path.join(foreign, ".pi-lens.json");
		fs.writeFileSync(wsConfig, JSON.stringify({}));
		fs.writeFileSync(
			foreignConfig,
			JSON.stringify({ lsp: { disabledServers: ["typos"] } }),
		);

		const previousHome = process.env.PI_LENS_HOME;
		const previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
		process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
		process.env.PI_LENS_CONFIG_PATH = path.join(
			home,
			".pi-lens",
			"config.json",
		);
		resetLSPConfigStateForTests();
		resetLSPConfigWarnCache();
		try {
			const view = await effectiveConfig({
				cwd: ws,
				homeDir: home,
				redact: true,
				// An absolute path into a SIBLING tree — not under `ws` at all.
				file: path.join(foreign, "notes.md"),
			});

			// `cwd` still names the workspace the caller actually asked about —
			// the confinement must not silently re-root the answer at `foreign`.
			expect(view.cwd).toBe(homeRelativePath(ws, home));
			expect(view.file).toEqual(outsideCwdError(homeRelativePath(ws, home)));
			// The workspace's OWN document is what this view is resolved from —
			// never the foreign tree's, and never omitted.
			const files = view.documents.map((document) => document.file);
			expect(files).toContain(homeRelativePath(wsConfig, home));
			expect(files).not.toContain(homeRelativePath(foreignConfig, home));
		} finally {
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			if (previousConfigPath === undefined)
				delete process.env.PI_LENS_CONFIG_PATH;
			else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
			resetLSPConfigStateForTests();
		}
	});

	/**
	 * The DOCUMENTED trade (docs/configuration.md, #2520 round 2 F3): a sibling
	 * PACKAGE inside the SAME monorepo — sharing a real repo root, not two
	 * unrelated temp trees like the foreign-tree case above — is still
	 * rejected. Confinement is measured against `cwd`, not "shares a git/repo
	 * ancestor with `cwd`", so `cwd` at `repo/packages/a` and `file` under
	 * `repo/packages/b` has no containment relationship even though both
	 * nest under `repo` — the caller wants package `b`'s answer, and gets it
	 * by re-querying with `cwd` set to `repo/packages/b`, per the remedy in
	 * the error itself.
	 */
	it("rejects a sibling package in the same monorepo, not just an unrelated foreign tree", async () => {
		const { view, home, projectDir } = await viewFor(
			{
				files: {
					"repo/.pi-lens.json": {},
					"repo/packages/a/.pi-lens.json": {},
					"repo/packages/b/.pi-lens.json": {
						lsp: { disabledServers: ["typos"] },
					},
				},
				startDir: "repo/packages/a",
			},
			{ file: path.join("..", "b", "notes.md") },
		);

		expect(view.file).toEqual(
			outsideCwdError(homeRelativePath(projectDir, home)),
		);
		// Package `b`'s document never leaks into an answer scoped to `a`.
		const files = view.documents.map((document) => document.file);
		expect(files).not.toContain(
			homeRelativePath(path.join(home, "repo/packages/b/.pi-lens.json"), home),
		);
	});

	it("still answers normally for a file nested INSIDE cwd (confinement must not reject the common case)", async () => {
		const { view } = await viewFor(
			{ files: { "proj/.pi-lens.json": {} }, startDir: "proj" },
			{ file: path.join("sub", "notes.md") },
		);
		expect(view.file).toBeDefined();
		expect(view.file && "error" in view.file).toBe(false);
	});
});
