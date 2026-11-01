/**
 * #5147 — an untrusted project cannot choose the argv (or any other launch
 * field) of a server the user declared in their own global config.
 *
 * Recurrence this prevents: `compileLspRegistry` named the three fields it
 * thought dangerous (`command`, `env`, `initializationOptions`) and let every
 * other field of a repo tier through. `args` reached the started child's argv,
 * so a cloned repo's `.pi-lens.json` chose the flags of the user's own binary.
 * The gate now names the fields a repo tier may set without trust and refuses
 * every other, so a field added later is refused until someone admits it.
 *
 * Nothing below the registry is doubled: the real config load, the real
 * `compileLspRegistry`, and the real `launchLSP` start a stub child that
 * records its own argv to a file. No language server is involved.
 *
 * State table (global entry `stub`: `command: [node, stub.mjs, <record>]`,
 * `args: ["--global-flag", "--sandbox"]`, env GLOBAL_ENV; the project entry
 * sets the field named). Round 2 (fail closed): a refused field may have
 * shadowed the user's own value because the merge keeps the winner only, so
 * the server is not registered at all, as a refused `command` already was.
 *   field                         untrusted / unknown        trusted
 *   args, env, initOptions,
 *   rootMarkers, covers,
 *   extensions, command,
 *   synthetic field               stub not registered        kept
 *   name                          registered, global argv    kept
 *   global only                   unchanged                  unchanged
 * serverOverrides.<id> (round 4): an untrusted or unknown project's refused
 * field drops the repo tier's contribution only. The user's global entry for
 * that id applies field by field (a shadowed global value is restored), and a
 * field with no global value falls back to the catalog default. The built-in
 * is never disabled for a repo field.
 *   field set by          trusted        untrusted / unknown
 *   global only           global         global
 *   repo only             repo           catalog default + 1 record
 *   both                  repo wins      global (restored) + 1 record
 * A server entry with no `extensions` array (V2: `{"name":"x"}`) is not
 * registered, so server selection never iterates `undefined`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDegradationSummary } from "../../../clients/degradation-ledger.js";
import { resetDegradationLedger } from "../../../clients/degradation-ledger.js";
import { lspPrimaryCoversFile } from "../../../clients/dispatch/runners/utils/runner-helpers.js";
import type { DispatchContext } from "../../../clients/dispatch/types.js";
import {
	compileLspRegistry,
	explainServersForFile,
	getServersForFileWithConfig,
	initLSPConfig,
	loadLSPConfig,
	REPO_TIER_OVERRIDE_FIELDS,
	REPO_TIER_SERVER_FIELDS,
	resetLSPConfigStateForTests,
} from "../../../clients/lsp/config.js";
import { aggregateServersForFile } from "../../../clients/lsp/grouping.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import { waitFor } from "../interleaving-kit.js";
import { removeTempDirSync } from "../test-utils.js";

const dirs: string[] = [];
const pids: number[] = [];
const originalPiLensHome = process.env.PI_LENS_HOME;

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5147-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const pid of pids.splice(0)) {
		try {
			process.kill(pid);
		} catch {
			// already gone
		}
	}
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	resetProjectTrust();
	resetDegradationLedger();
	resetLSPConfigStateForTests();
	if (originalPiLensHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = originalPiLensHome;
});

const STUB = `import fs from "node:fs";
const [record, ...rest] = process.argv.slice(2);
const env = {};
for (const key of ["GLOBAL_ENV", "PROJECT_ENV"]) env[key] = process.env[key] ?? null;
fs.writeFileSync(record, JSON.stringify({ argv: rest, env }));
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
setInterval(() => {}, 1000);
`;

type Trust = "trusted" | "untrusted" | "unknown";

interface Arranged {
	project: string;
	record: string;
	/** The file the stub writes when the global rust override starts it. */
	overrideRecord: string;
	/** The user's global `serverOverrides.rust.command`, a wrapper argv. */
	globalOverrideCommand: string[];
}

/** Writes the stub, the user's global config and the project's `.pi-lens.json`. */
function arrange(
	trust: Trust,
	projectServerFields: Record<string, unknown> | undefined,
	projectOverrides?: Record<string, unknown>,
	options: { globalOverride?: boolean } = {},
): Arranged {
	const project = tempDir();
	const globalDir = tempDir();
	process.env.PI_LENS_HOME = globalDir;
	const stub = path.join(globalDir, "stub.mjs");
	const globalOverride = path.join(globalDir, "override-argv.json");
	const record = path.join(globalDir, "argv.json");
	fs.writeFileSync(stub, STUB);
	const globalOverrideCommand = [process.execPath, stub, globalOverride];
	fs.writeFileSync(
		path.join(globalDir, "lsp.json"),
		JSON.stringify({
			servers: {
				stub: {
					name: "Global stub",
					extensions: [".stub"],
					command: [process.execPath, stub, record],
					args: ["--global-flag", "--sandbox"],
					env: { GLOBAL_ENV: "g" },
				},
			},
			...(options.globalOverride === false
				? {}
				: {
						serverOverrides: {
							rust: {
								command: globalOverrideCommand,
								env: { GLOBAL_ENV: "g" },
								initializationOptions: { globalOpt: 1 },
							},
						},
					}),
		}),
	);
	const lsp: Record<string, unknown> = {};
	if (projectServerFields) lsp.servers = { stub: projectServerFields };
	if (projectOverrides) lsp.serverOverrides = projectOverrides;
	if (Object.keys(lsp).length > 0) {
		fs.writeFileSync(
			path.join(project, ".pi-lens.json"),
			JSON.stringify({ lsp }),
		);
	}
	if (trust === "unknown") resetProjectTrust();
	else setProjectTrustState(trust);
	return {
		project,
		record,
		overrideRecord: globalOverride,
		globalOverrideCommand,
	};
}

async function compile(project: string) {
	const config = await loadLSPConfig(project);
	return compileLspRegistry(config, config.__provenance);
}

/**
 * Starts the compiled `stub` server for real and reads the argv it saw, or
 * undefined when the registry did not register it for this project.
 */
async function startedArgv(arranged: Arranged): Promise<string[] | undefined> {
	const registry = await compile(arranged.project);
	const server = registry.customServers.find((entry) => entry.id === "stub");
	if (!server) return undefined;
	return (await started(server, arranged.project, arranged.record)).argv;
}

interface StubLaunch {
	argv: string[];
	env: Record<string, string | null>;
}

/** Starts `server` for real and reads what the stub child recorded. */
async function started(
	server: {
		spawn(root: string): Promise<{ process: { pid?: number } } | undefined>;
	},
	root: string,
	record: string,
): Promise<StubLaunch> {
	const launch = await server.spawn(root);
	if (!launch) throw new Error("stub spawn was not admitted");
	if (launch.process.pid !== undefined) pids.push(launch.process.pid);
	const raw = await waitFor(
		() => (fs.existsSync(record) ? fs.readFileSync(record, "utf8") : ""),
		(value) => value !== "",
	);
	return JSON.parse(raw) as StubLaunch;
}

function decisionFields(): string[] {
	return (
		getDegradationSummary()
			.find((group) => group.kind === "lsp-registry-decision")
			?.latestReasons.map((entry) => entry.reason) ?? []
	);
}

const GLOBAL_ARGV = ["--global-flag", "--sandbox"];

describe("untrusted project fields on a global LSP server (#5147)", () => {
	// Recurrence: r1 refused only the repo's value, so an untrusted `args` left
	// the user's `--sandbox` flag out of the argv (the stub started on `[]`) and
	// one untrusted `env` key dropped the whole global env. The server must not
	// start at all.
	async function expectNotStarted(
		trust: Trust,
		fields: Record<string, unknown>,
		field: string,
	): Promise<void> {
		const arranged = arrange(trust, fields);
		expect(await startedArgv(arranged), `${trust} ${field}`).toBeUndefined();
		expect(fs.existsSync(arranged.record), `${trust} ${field} record`).toBe(
			false,
		);
		expect(decisionFields()).toContainEqual(
			expect.stringContaining(`project LSP ${field} refused for stub`),
		);
		expect(decisionFields()).toContainEqual(
			expect.stringContaining("the stub entry is not applied for this project"),
		);
	}

	it("does not start the global server when an untrusted project sets args", async () => {
		await expectNotStarted("untrusted", { args: ["--project-flag"] }, "args");
	});

	it("does not start the global server when an unknown-trust project sets args", async () => {
		await expectNotStarted("unknown", { args: ["--project-flag"] }, "args");
	});

	it("does not start the global server when an untrusted project sets empty args", async () => {
		await expectNotStarted("untrusted", { args: [] }, "args");
	});

	it("does not start the global server when an untrusted project sets one env key", async () => {
		await expectNotStarted("untrusted", { env: { PROJECT_ENV: "p" } }, "env");
	});

	it("carries a trusted project's args to the started child's argv", async () => {
		const arranged = arrange("trusted", { args: ["--project-flag"] });
		expect(await startedArgv(arranged)).toEqual(["--project-flag"]);
		expect(decisionFields()).toEqual([]);
	});

	it("starts a global-only config with the global args under every trust state", async () => {
		for (const trust of ["untrusted", "unknown", "trusted"] as const) {
			const arranged = arrange(trust, undefined);
			expect(await startedArgv(arranged), trust).toEqual(GLOBAL_ARGV);
			fs.rmSync(arranged.record, { force: true });
		}
		expect(decisionFields()).toEqual([]);
	});

	it("starts the global server on its own argv when the project sets only name", async () => {
		const arranged = arrange("untrusted", { name: "Project label" });
		const registry = await compile(arranged.project);
		expect(
			registry.customServers.find((entry) => entry.id === "stub")?.name,
		).toBe("Project label");
		expect(await startedArgv(arranged)).toEqual(GLOBAL_ARGV);
		expect(decisionFields()).toEqual([]);
	});

	// Recurrence: every refused field must turn the server off, not only the
	// two argv/env fields the r1 probe showed.
	it("does not register the global server for any other refused field", async () => {
		const refusedFields: Array<[string, Record<string, unknown>]> = [
			["initializationOptions", { initializationOptions: { x: 1 } }],
			["rootMarkers", { rootMarkers: ["Cargo.toml"] }],
			["covers", { covers: ["shellcheck"] }],
			["extensions", { extensions: [".env"] }],
			["command", { command: "project-binary" }],
			["unrecognized field", { syntheticLaunchFlag: "--x" }],
		];
		for (const trust of ["untrusted", "unknown"] as const) {
			for (const [field, fields] of refusedFields) {
				resetDegradationLedger();
				await expectNotStarted(trust, fields, field);
			}
		}
	});

	it("keeps every project field on the global server once pi trusts the project", async () => {
		const arranged = arrange("trusted", {
			extensions: [".proj"],
			rootMarkers: ["Cargo.toml"],
			covers: ["shellcheck"],
		});
		const server = (await compile(arranged.project)).customServers.find(
			(entry) => entry.id === "stub",
		);
		expect(server?.extensions).toEqual([".proj"]);
		expect(server?.rootMarkers).toEqual(["Cargo.toml"]);
		expect(server?.covers).toEqual(["shellcheck"]);
		expect(decisionFields()).toEqual([]);
	});

	// Recurrence: the gate listed dangerous fields, so a field nobody listed
	// passed. A field the admitted table does not name is refused and recorded
	// once, without echoing the repo's key into the record.
	it("refuses a field no table names, and records it under one fixed label", async () => {
		const arranged = arrange("untrusted", {
			syntheticLaunchFlag: "--x",
			anotherSyntheticFlag: 1,
		});
		expect(Object.keys(REPO_TIER_SERVER_FIELDS)).not.toContain(
			"syntheticLaunchFlag",
		);
		await compile(arranged.project);
		const reasons = decisionFields();
		expect(reasons).toEqual([
			"project LSP unrecognized field refused for stub: pi project trust is untrusted; the stub entry is not applied for this project",
		]);
	});

	it("keeps a field no table names once pi trusts the project", async () => {
		const arranged = arrange("trusted", { syntheticLaunchFlag: "--x" });
		await compile(arranged.project);
		expect(decisionFields()).toEqual([]);
	});

	// Recurrence: `extensions` was admitted in r1, so a repo could route its
	// `.env` to the user's server or unroute it with `[]`. Only `name` is left.
	it("admits only name from a repo tier on lsp.servers", () => {
		expect(
			Object.entries(REPO_TIER_SERVER_FIELDS)
				.filter(([, row]) => row.admit)
				.map(([field]) => field),
		).toEqual(["name"]);
	});

	it("decides every serverOverrides field as refused-without-trust", () => {
		expect(
			Object.values(REPO_TIER_OVERRIDE_FIELDS).filter((row) => row.admit),
		).toEqual([]);
	});
});

describe("untrusted project serverOverrides on a catalog server (#5147)", () => {
	async function builtinFor(
		trust: Trust,
		fields: Record<string, unknown>,
		options: { globalOverride?: boolean } = {},
	) {
		const arranged = arrange(trust, undefined, { rust: fields }, options);
		const registry = await compile(arranged.project);
		const file = path.join(arranged.project, "x.rs");
		return {
			arranged,
			registry,
			reason: explainServersForFile(file, registry).find(
				(entry) => entry.server.id === "rust",
			)?.reason,
		};
	}

	const refusedOverride = (field: string, trust: Trust) =>
		`project LSP ${field} refused for rust: pi project trust is ${trust}; the project's rust override is not applied`;

	// Recurrence (verify V1 on 627196a6c): any refused repo field dropped the
	// whole override, so a repo removed the user's global wrapper `command`
	// by setting one env key, and rust-analyzer started unwrapped.
	it("keeps the user's global wrapper command when an untrusted project sets an override env", async () => {
		for (const trust of ["untrusted", "unknown"] as const) {
			resetDegradationLedger();
			const { arranged, registry, reason } = await builtinFor(trust, {
				env: { PROJECT_ENV: "p" },
			});
			expect(registry.serverOverrides.get("rust"), trust).toEqual({
				command: arranged.globalOverrideCommand,
				env: { GLOBAL_ENV: "g" },
				initializationOptions: { globalOpt: 1 },
			});
			expect(registry.disabledServerIds.has("rust"), trust).toBe(false);
			expect(reason, trust).toBe("selected");
			const rust = registry.registeredServers.find((s) => s.id === "rust");
			if (!rust) throw new Error("rust is not registered");
			expect(
				await started(rust, arranged.project, arranged.overrideRecord),
				trust,
			).toEqual({ argv: [], env: { GLOBAL_ENV: "g", PROJECT_ENV: null } });
			expect(decisionFields(), trust).toEqual([
				refusedOverride("env override", trust),
			]);
		}
	});

	// Recurrence: a repo `command` that shadows the user's global command must
	// neither stay nor take the global value with it; the global one applies.
	it("restores the user's global command when an untrusted project shadows it", async () => {
		for (const trust of ["untrusted", "unknown"] as const) {
			resetDegradationLedger();
			const { arranged, registry } = await builtinFor(trust, {
				command: ["project-rust", "--stdio"],
				initializationOptions: { globalOpt: 2, projectOpt: true },
			});
			expect(registry.serverOverrides.get("rust"), trust).toEqual({
				command: arranged.globalOverrideCommand,
				env: { GLOBAL_ENV: "g" },
				initializationOptions: { globalOpt: 1 },
			});
			expect(decisionFields(), trust).toEqual([
				refusedOverride("command override", trust),
				refusedOverride("initializationOptions", trust),
			]);
		}
	});

	// Recurrence: round 2 turned the built-in off for any refused override
	// field; with no global value the built-in runs on its catalog defaults.
	it("runs the built-in on catalog defaults for a repo-only initializationOptions override", async () => {
		for (const trust of ["untrusted", "unknown"] as const) {
			resetDegradationLedger();
			const { registry, reason } = await builtinFor(
				trust,
				{ initializationOptions: { check: { command: "clippy" } } },
				{ globalOverride: false },
			);
			expect(registry.serverOverrides.get("rust"), trust).toBeUndefined();
			expect(registry.disabledServerIds.has("rust"), trust).toBe(false);
			expect(
				registry.registeredServers.find((s) => s.id === "rust"),
				trust,
			).toBe(
				compileLspRegistry({}).registeredServers.find((s) => s.id === "rust"),
			);
			expect(reason, trust).toBe("selected");
			expect(decisionFields(), trust).toEqual([
				refusedOverride("initializationOptions", trust),
			]);
		}
	});

	it("applies the project's override fields over the global ones once pi trusts the project", async () => {
		const { registry } = await builtinFor("trusted", {
			command: ["project-rust", "--stdio"],
			env: { PROJECT_ENV: "p" },
		});
		expect(registry.serverOverrides.get("rust")).toEqual({
			command: ["project-rust", "--stdio"],
			env: { GLOBAL_ENV: "g", PROJECT_ENV: "p" },
			initializationOptions: { globalOpt: 1 },
		});
		expect(decisionFields()).toEqual([]);
	});

	it("refuses an untrusted override field no table names, and keeps trusted ones", async () => {
		const overrides = {
			args: ["--project-flag"],
			syntheticLaunchFlag: true,
		};
		const untrusted = await builtinFor("untrusted", overrides);
		expect(untrusted.registry.serverOverrides.get("rust")?.command).toEqual(
			untrusted.arranged.globalOverrideCommand,
		);
		expect(decisionFields()).toEqual([
			refusedOverride("unrecognized field", "untrusted"),
		]);
		resetDegradationLedger();
		const trusted = await builtinFor("trusted", overrides);
		expect(trusted.registry.serverOverrides.get("rust")?.command).toBeDefined();
		expect(decisionFields()).toEqual([]);
	});

	it("keeps the user's global override and the catalog server when the project sets none", async () => {
		const { registry, reason } = await builtinFor("untrusted", {});
		expect(registry.disabledServerIds.has("rust")).toBe(false);
		expect(registry.serverOverrides.get("rust")?.command).toEqual([
			process.execPath,
			expect.stringContaining("stub.mjs"),
			expect.stringContaining("override-argv.json"),
		]);
		expect(reason).toBe("selected");
	});
});

describe("a server entry without extensions (#5147 verify V2)", () => {
	// Recurrence: an untrusted repo's `lsp.servers.x = {"name":"x"}` registered
	// a server with no `extensions`, and every server selection for any file
	// then threw "server.extensions is not iterable" from the selection gate
	// (`fileMatchReason`), in each caller below.
	it("does not register it, so server selection for a file does not throw", async () => {
		const arranged = arrange("untrusted", undefined);
		fs.writeFileSync(
			path.join(arranged.project, ".pi-lens.json"),
			JSON.stringify({ lsp: { servers: { x: { name: "x" } } } }),
		);
		await initLSPConfig(arranged.project);
		const file = path.join(arranged.project, "main.rs");
		const ctx = { filePath: file } as unknown as DispatchContext;
		expect(
			getServersForFileWithConfig(file).map((server) => server.id),
		).not.toContain("x");
		expect(() => lspPrimaryCoversFile(ctx, "shellcheck")).not.toThrow();
		expect(
			aggregateServersForFile(file).map((server) => server.id),
		).not.toContain("x");
		expect(decisionFields()).toEqual([]);
	});
});
