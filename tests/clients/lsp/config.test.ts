import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";
import { useConfigPath } from "../../support/global-config.js";
const setConfigPath = useConfigPath();

// #1333: these config/telemetry warnings no longer reach the terminal — pi owns
// it — they go to the ndjson sink in `clients/extension-log.ts`. The sink mock
// below forwards each entry's message to `console.error` so the assertions in
// this file keep covering what they were written to cover (message content and
// the warn-once dedup contract) without re-deriving every expectation. The
// "no raw terminal write" half of the invariant is enforced repo-wide by
// tests/clients/extension-terminal-silence.test.ts.
vi.mock("../../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: { message: string }) => console.error(entry.message),
	};
});

const dirs: string[] = [];
const defaultGlobalDir = process.env.PI_LENS_HOME;

function tmpDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	if (defaultGlobalDir === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = defaultGlobalDir;
	// #2418 review round 3, S3. The ignored-config warn latch is
	// process-lifetime and shared by all three loaders, so without an explicit
	// clear these cases only stayed independent because every fixture happened
	// to land in a fresh mkdtemp path — a property of the fixture, not of the
	// test. The loader now exports the same reset seam lens-config and
	// project-lens-config do.
	const { resetLSPConfigWarnCache } =
		await import("../../../clients/lsp/config.js");
	resetLSPConfigWarnCache();
});

describe("loadLSPConfig global configuration (#870)", () => {
	it("applies global configuration when the project has no config", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-");
		const globalDir = tmpDir("pi-lens-lsp-global-");
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(
			path.join(globalDir, "lsp.json"),
			JSON.stringify({
				servers: {
					global: {
						name: "Global",
						extensions: [".global"],
						command: "global-lsp",
					},
				},
				disabledServers: ["typescript"],
				warmFiles: ["src/global.ts"],
			}),
		);

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		await expect(loadLSPConfig(projectDir)).resolves.toMatchObject({
			servers: { global: { command: "global-lsp" } },
			disabledServers: ["typescript"],
			warmFiles: ["src/global.ts"],
		});
	});

	it("merges maps by id, replaces project-owned array fields, and unions denials", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-");
		const globalDir = tmpDir("pi-lens-lsp-global-");
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(
			path.join(globalDir, "lsp.json"),
			JSON.stringify({
				servers: {
					shared: { name: "Global", extensions: [".g"], command: "global" },
					globalOnly: {
						name: "Global only",
						extensions: [".go"],
						command: "global-only",
					},
				},
				serverOverrides: {
					rust: { initializationOptions: { check: { command: "check" } } },
					go: { initializationOptions: { gofumpt: true } },
				},
				disabledServers: ["typescript"],
				warmFiles: ["global.ts"],
			}),
		);
		fs.mkdirSync(path.join(projectDir, ".pi-lens"));
		fs.writeFileSync(
			path.join(projectDir, ".pi-lens", "lsp.json"),
			JSON.stringify({
				servers: {
					shared: { name: "Project", extensions: [".p"], command: "project" },
					projectOnly: {
						name: "Project only",
						extensions: [".po"],
						command: "project-only",
					},
				},
				serverOverrides: {
					rust: { initializationOptions: { check: { command: "clippy" } } },
					nix: { initializationOptions: { nixpkgs: { expr: "global" } } },
				},
				disabledServers: [],
				warmFiles: ["project.ts"],
			}),
		);

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		const config = await loadLSPConfig(projectDir);

		expect(Object.keys(config.servers ?? {}).sort()).toEqual([
			"globalOnly",
			"projectOnly",
			"shared",
		]);
		expect(config.servers?.shared.command).toBe("project");
		expect(Object.keys(config.serverOverrides ?? {}).sort()).toEqual([
			"go",
			"nix",
			"rust",
		]);
		expect(config.serverOverrides?.rust.initializationOptions).toEqual({
			check: { command: "clippy" },
		});
		// `disabledServers` is the ONE array field that does NOT follow the
		// project-replaces-global rule the rest of this case pins (#2427). It is a
		// DENIAL, and `config-core/deny.ts` resolves it as the union of every
		// tier's entries — so the project's `[]` above expresses nothing, and the
		// operator's global denial survives. Before #2427 this assertion read
		// `toEqual([])`, which is to say it pinned repository content silently
		// re-enabling a server the operator had turned off; #2415 AC 3 forbids
		// exactly that, and `docs/configuration.md` documents the exception.
		expect(config.disabledServers).toEqual(["typescript"]);
		expect(config.warmFiles).toEqual(["project.ts"]);
	});

	it("degrades a malformed global file to built-in defaults", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-");
		const globalDir = tmpDir("pi-lens-lsp-global-");
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(path.join(globalDir, "lsp.json"), "{ invalid");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		await expect(loadLSPConfig(projectDir)).resolves.toEqual({});
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining("ignoring invalid LSP config"),
		);
	});

	it("does not leak a token from a malformed config into the warning (#2431)", async () => {
		// The literal shape from #2431's evidence: Node's own JSON.parse
		// SyntaxError embeds a slice of the source text, so an unquoted value
		// next to a real-shaped credential leaked straight through as `reason`
		// before this fix.
		const TOKEN = `ghp_${"A".repeat(36)}`;
		const projectDir = tmpDir("pi-lens-lsp-project-");
		const globalDir = tmpDir("pi-lens-lsp-global-");
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(path.join(globalDir, "lsp.json"), `{"piToken": ${TOKEN}}`);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		await expect(loadLSPConfig(projectDir)).resolves.toEqual({});
		expect(error).toHaveBeenCalledTimes(1);
		const [message] = error.mock.calls[0];
		expect(message).not.toContain(TOKEN);
		expect(message).not.toContain("ghp_");

		const { getDegradationSummary } =
			await import("../../../clients/degradation-ledger.js");
		const group = getDegradationSummary().find(
			(g) => g.kind === "config-ignored",
		);
		const globalConfigPath = path.join(globalDir, "lsp.json");
		const ledgerEntry = group?.latestReasons.find(
			(entry) => entry.subject === globalConfigPath,
		);
		expect(ledgerEntry).toBeDefined();
		expect(ledgerEntry?.reason).not.toContain(TOKEN);
		expect(ledgerEntry?.reason).not.toContain("ghp_");
		// #2451: locality recovered end to end through the real production
		// wiring (`readConfigDocument` -> `reportConfigReadFailure`), not just
		// at the `normalizeParseErrorReason` unit level.
		expect(ledgerEntry?.reason).toBe("SyntaxError at line 1 col 13");
	});

	it("warns once per broken file, and again after the latch is reset", async () => {
		// The seam S3 asks for, exercised rather than merely exported: the same
		// path read twice nags once, and a caller that explicitly re-arms the
		// latch (a new session's test, or this file's own afterEach) sees it
		// again. Nothing here relies on the fixture path being unique.
		const projectDir = tmpDir("pi-lens-lsp-project-");
		const globalDir = tmpDir("pi-lens-lsp-global-");
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(path.join(globalDir, "lsp.json"), "{ invalid");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const { loadLSPConfig, resetLSPConfigWarnCache } =
			await import("../../../clients/lsp/config.js");
		resetLSPConfigWarnCache();
		await loadLSPConfig(projectDir);
		await loadLSPConfig(projectDir);
		expect(error).toHaveBeenCalledTimes(1);

		resetLSPConfigWarnCache();
		await loadLSPConfig(projectDir);
		expect(error).toHaveBeenCalledTimes(2);
	});

	it("treats a missing global file as a silent no-op", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-");
		process.env.PI_LENS_HOME = tmpDir("pi-lens-lsp-global-");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		await expect(loadLSPConfig(projectDir)).resolves.toEqual({});
		expect(error).not.toHaveBeenCalled();
	});
});

/**
 * #2426, at the public loader rather than at the resolver seam.
 *
 * Both cases below are RED on pre-#2426 `loadLSPConfig`: the walk ran to the
 * filesystem root with no `$HOME` stop, and the candidate list took the first
 * hit, which put a deprecated location ahead of the canonical one.
 */
describe("loadLSPConfig walk confinement and canonical precedence (#2426)", () => {
	it("does not adopt a legacy LSP config from at or above HOME", async () => {
		// Cross-form paths per the read-guard path-key rule: the ceiling is
		// supplied in `/` form and the cwd in native form, so a ceiling that only
		// holds when both were spelled the same way does not pass here.
		const root = tmpDir("pi-lens-lsp-ceiling-");
		const home = path.join(root, "home");
		const projectDir = path.join(home, "proj", "src");
		fs.mkdirSync(projectDir, { recursive: true });
		process.env.PI_LENS_HOME = tmpDir("pi-lens-lsp-global-");

		// Above HOME.
		fs.mkdirSync(path.join(root, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".pi-lens", "lsp.json"),
			JSON.stringify({ warmFiles: ["from-above-home"] }),
		);
		// And IN HOME, which is equally off limits.
		fs.writeFileSync(
			path.join(home, "pi-lsp.json"),
			JSON.stringify({ warmFiles: ["from-home"] }),
		);

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		await expect(
			loadLSPConfig(projectDir, home.replace(/\\/g, "/")),
		).resolves.toEqual({});

		// Mutation guard: the same fixture with a config BELOW the ceiling is
		// still read, so the two assertions above cannot pass by reading nothing.
		fs.writeFileSync(
			path.join(home, "proj", ".pi-lens.json"),
			JSON.stringify({ lsp: { warmFiles: ["from-project"] } }),
		);
		await expect(
			loadLSPConfig(projectDir, home.replace(/\\/g, "/")),
		).resolves.toEqual({ warmFiles: ["from-project"] });
	});

	it("lets the canonical .pi-lens.json beat a leftover .pi-lens/lsp.json", async () => {
		const root = tmpDir("pi-lens-lsp-canonical-");
		const home = path.join(root, "home");
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(path.join(projectDir, ".pi-lens"), { recursive: true });
		process.env.PI_LENS_HOME = tmpDir("pi-lens-lsp-global-");

		fs.writeFileSync(
			path.join(projectDir, ".pi-lens", "lsp.json"),
			JSON.stringify({ warmFiles: ["legacy"], disabledServers: ["typos"] }),
		);
		fs.writeFileSync(
			path.join(projectDir, ".pi-lens.json"),
			JSON.stringify({ lsp: { warmFiles: ["canonical"] } }),
		);

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		const config = await loadLSPConfig(projectDir, home);
		expect(config.warmFiles).toEqual(["canonical"]);
		// The legacy file is still READ — deprecation, not removal — so a key the
		// user has not migrated yet keeps working.
		expect(config.disabledServers).toEqual(["typos"]);
	});
});

/**
 * In-flight ABA release (#1968, kit-driven white-box probe — sibling of
 * dead-code-client's/knip-client's bare-`.finally` release, same shape).
 *
 * `initLSPConfig`'s in-flight map cleared with a bare delete-by-key. The race
 * needs a SECOND WRITER replacing the map entry mid-flight — the public API
 * alone cannot produce it today (single set site; microtask FIFO orders every
 * observer after A's cleanup) — so this test simulates that writer directly.
 * `initLSPConfig` registers the map entry synchronously (before its first
 * internal `await loadLSPConfig(cwd)` settles), so the successor can be
 * installed with zero awaits between the call and the injection. Red on the
 * pre-fix bare `.finally` delete: A's cleanup evicted B and the third caller
 * started a duplicate config load.
 */
describe("initLSPConfig in-flight ABA release (#1968)", () => {
	it("a late-settling init does not evict its mid-flight successor", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-aba-");
		const { initLSPConfig, _peekConfigInFlightForTests } =
			await import("../../../clients/lsp/config.js");

		const buildA = initLSPConfig(projectDir);
		// Synchronous: the map entry is already registered here, before A's
		// `await loadLSPConfig(cwd)` has had a chance to resolve.
		const inFlight = _peekConfigInFlightForTests();
		expect(inFlight.size).toBe(1);
		const key = [...inFlight.keys()][0]!;

		// B replaces the entry under the same key while A is still in flight.
		let resolveSuccessor: () => void;
		const successor = new Promise<void>((resolve) => {
			resolveSuccessor = resolve;
		});
		inFlight.set(key, successor);

		await buildA; // A settles

		// B's entry survived A's cleanup.
		expect(inFlight.get(key)).toBe(successor);

		resolveSuccessor!();
		await successor;
	});

	// Mutation-proof companion: pins that a normal, uncontested settlement
	// still empties the slot, so a mutant that makes the identity guard
	// permanently `false` (never releases) reds here. Checked by KEY, not
	// overall map size — the sibling test above leaves a synthetic successor
	// entry under its OWN key that nothing but a real `initLSPConfig` call for
	// that same cwd would ever clear.
	it("a normally-settling init still cleans up its own entry", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-clean-");
		const { initLSPConfig, _peekConfigInFlightForTests } =
			await import("../../../clients/lsp/config.js");

		const inFlight = _peekConfigInFlightForTests();
		const before = new Set(inFlight.keys());
		const pass = initLSPConfig(projectDir);
		// Synchronous: the map entry is already registered here, exactly as the
		// ABA test above relies on.
		const key = [...inFlight.keys()].find((k) => !before.has(k))!;
		expect(key).toBeDefined();

		await pass;
		expect(inFlight.has(key)).toBe(false);
	});
});

/**
 * The deny union, and the by-id merge, must span BOTH SPELLINGS of every LSP
 * key (#2427 review round 2, F1).
 *
 * `disabledServers` exists at two schema nodes — the canonical
 * `/lsp/disabledServers` and the legacy root `/disabledServers` — and before
 * this round they were unioned INDEPENDENTLY: two nodes, two deny resolutions,
 * neither seeing the other's tiers. `lspSectionOf` then let the canonical
 * spelling overwrite the legacy one per key, so a global denial written in the
 * legacy spelling VANISHED the moment any project file mentioned the canonical
 * one — including to say `[]`. That is the same operator-denial-lifted-by-
 * repository-content defect #2415 AC 3 forbids, arriving through the migration
 * rather than through the merge strategy.
 *
 * The fix is at the source: a document's legacy root LSP keys are normalized
 * into the `lsp` namespace before the resolution sees them, so there is ONE
 * node per key and `merge()`'s deny/object semantics apply across every tier
 * and every spelling at once. These cases are the proof, driven through the
 * production loader rather than through the merger.
 */
describe("loadLSPConfig — the deny union spans key spellings (#2427 round 2)", () => {
	/** Lay out a global home + project dir and load through the real loader. */
	async function loadWith(files: Record<string, unknown>): Promise<{
		disabledServers?: string[];
		servers?: Record<string, { command: string }>;
		serverOverrides?: Record<string, unknown>;
		warmFiles?: string[];
	}> {
		const home = tmpDir("pi-lens-lsp-spelling-");
		for (const [relative, content] of Object.entries(files)) {
			const target = path.join(home, relative);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, JSON.stringify(content));
		}
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(projectDir, { recursive: true });
		process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
		setConfigPath(path.join(home, ".pi-lens", "config.json"));
		const { loadLSPConfig, resetLSPConfigWarnCache } =
			await import("../../../clients/lsp/config.js");
		resetLSPConfigWarnCache();
		return (await loadLSPConfig(projectDir, home)) as never;
	}

	// Fixture paths, assembled rather than spelled: the layout keys are
	// relative to the fake home the helper above lays out.
	const GLOBAL_LEGACY = [".pi-lens", "lsp.json"].join("/");
	const GLOBAL_CANONICAL = [".pi-lens", "config.json"].join("/");
	const PROJECT_CANONICAL = ["proj", ".pi-lens.json"].join("/");

	/** A canonical-namespace deny document. */
	function deny(...ids: string[]): Record<string, unknown> {
		return { lsp: { disabledServers: ids } };
	}

	/** The same denial written at the legacy ROOT of a file. */
	function denyAtRoot(...ids: string[]): Record<string, unknown> {
		return { disabledServers: ids };
	}

	/** A one-entry custom-server map, keyed by id. */
	function serverEntry(id: string, command: string): Record<string, unknown> {
		const spec: Record<string, unknown> = {};
		spec.name = id;
		spec.extensions = [`.${id}`];
		spec.command = command;
		const map: Record<string, unknown> = {};
		map[id] = spec;
		return map;
	}

	/** A one-entry serverOverrides map, keyed by server id. */
	function override(id: string): Record<string, unknown> {
		const initializationOptions: Record<string, unknown> = {};
		initializationOptions[id] = true;
		const entry: Record<string, unknown> = {};
		entry.initializationOptions = initializationOptions;
		const map: Record<string, unknown> = {};
		map[id] = entry;
		return map;
	}

	function sorted(ids: string[] | undefined): string[] {
		return [...(ids ?? [])].sort();
	}

	// Case A — global denial in an LSP-SCOPED legacy file, project clears it in
	// the canonical namespace.
	it("a global legacy lsp file denial survives a canonical project clear", async () => {
		const files: Record<string, unknown> = {};
		files[GLOBAL_LEGACY] = denyAtRoot("typos");
		files[PROJECT_CANONICAL] = deny();
		const config = await loadWith(files);
		expect(config.disabledServers).toEqual(["typos"]);
	});

	// Case B — global denial written at the legacy ROOT of the CANONICAL global
	// file, project clears it in the canonical namespace.
	it("a global root-spelled denial survives a canonical project clear", async () => {
		const files: Record<string, unknown> = {};
		files[GLOBAL_CANONICAL] = denyAtRoot("typos");
		files[PROJECT_CANONICAL] = deny();
		const config = await loadWith(files);
		expect(config.disabledServers).toEqual(["typos"]);
	});

	// Case C — the union across spellings GROWS. The global denial must not
	// vanish because the project denied something else in the other spelling.
	it("unions across spellings instead of replacing the legacy one", async () => {
		const files: Record<string, unknown> = {};
		files[GLOBAL_LEGACY] = denyAtRoot("typos");
		files[PROJECT_CANONICAL] = deny("rust");
		const config = await loadWith(files);
		expect(sorted(config.disabledServers)).toEqual(["rust", "typos"]);
	});

	// Case C-prime — the mirror image: canonical global, legacy project. A user
	// who migrated their GLOBAL file first must not lose the denial either.
	it("unions when the tiers swap spellings", async () => {
		const files: Record<string, unknown> = {};
		files[GLOBAL_CANONICAL] = deny("typos");
		files[PROJECT_CANONICAL] = denyAtRoot("rust");
		const config = await loadWith(files);
		expect(sorted(config.disabledServers)).toEqual(["rust", "typos"]);
	});

	// Case G — the same split silently CLOBBERED the by-id object merge. A
	// half-migrated pair of files lost one side servers entirely.
	it("merges servers and serverOverrides by id across spellings", async () => {
		const globalDoc: Record<string, unknown> = {};
		globalDoc.servers = serverEntry("globalOnly", "global-only");
		globalDoc.serverOverrides = override("rust");
		globalDoc.warmFiles = ["global.ts"];
		const lspSection: Record<string, unknown> = {};
		lspSection.servers = serverEntry("projectOnly", "project-only");
		lspSection.serverOverrides = override("go");
		const projectDoc: Record<string, unknown> = {};
		projectDoc.lsp = lspSection;
		const files: Record<string, unknown> = {};
		files[GLOBAL_LEGACY] = globalDoc;
		files[PROJECT_CANONICAL] = projectDoc;
		const config = await loadWith(files);
		expect(Object.keys(config.servers ?? {}).sort()).toEqual([
			"globalOnly",
			"projectOnly",
		]);
		expect(Object.keys(config.serverOverrides ?? {}).sort()).toEqual([
			"go",
			"rust",
		]);
		// A non-deny array still follows the ordinary rule: the project owns it
		// when it writes it, and inherits the global one when it does not.
		expect(config.warmFiles).toEqual(["global.ts"]);
	});

	// The canonical spelling still WINS a collision inside ONE document, which
	// is the rule lspSectionOf documented and the normalization must preserve.
	it("keeps canonical-wins-per-key inside a single document", async () => {
		const lspSection: Record<string, unknown> = {};
		lspSection.warmFiles = ["from-canonical"];
		const projectDoc: Record<string, unknown> = {};
		projectDoc.warmFiles = ["from-root"];
		projectDoc.lsp = lspSection;
		const files: Record<string, unknown> = {};
		files[PROJECT_CANONICAL] = projectDoc;
		const config = await loadWith(files);
		expect(config.warmFiles).toEqual(["from-canonical"]);
	});
});
