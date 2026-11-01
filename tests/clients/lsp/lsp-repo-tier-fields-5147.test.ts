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
 * `args: ["--global-flag"]`; project entry sets the field named):
 *   field            untrusted / unknown            trusted
 *   args             refused (argv has no project)  kept
 *   rootMarkers      refused                        kept
 *   covers           refused                        kept
 *   name,extensions  kept                           kept
 *   synthetic field  refused (unrecognized)         kept
 *   global only      unchanged (args reach argv)    unchanged
 * serverOverrides.<id>: command/env/initializationOptions stay refused, and a
 * field the table does not name is refused with its own record.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDegradationSummary } from "../../../clients/degradation-ledger.js";
import { resetDegradationLedger } from "../../../clients/degradation-ledger.js";
import {
	compileLspRegistry,
	loadLSPConfig,
	REPO_TIER_OVERRIDE_FIELDS,
	REPO_TIER_SERVER_FIELDS,
} from "../../../clients/lsp/config.js";
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
	if (originalPiLensHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = originalPiLensHome;
});

const STUB = `import fs from "node:fs";
const [record, ...rest] = process.argv.slice(2);
fs.writeFileSync(record, JSON.stringify(rest));
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
setInterval(() => {}, 1000);
`;

type Trust = "trusted" | "untrusted" | "unknown";

interface Arranged {
	project: string;
	record: string;
}

/** Writes the stub, the user's global config and the project's `.pi-lens.json`. */
function arrange(
	trust: Trust,
	projectServerFields: Record<string, unknown> | undefined,
	projectOverrides?: Record<string, unknown>,
): Arranged {
	const project = tempDir();
	const globalDir = tempDir();
	process.env.PI_LENS_HOME = globalDir;
	const stub = path.join(globalDir, "stub.mjs");
	const record = path.join(globalDir, "argv.json");
	fs.writeFileSync(stub, STUB);
	fs.writeFileSync(
		path.join(globalDir, "lsp.json"),
		JSON.stringify({
			servers: {
				stub: {
					name: "Global stub",
					extensions: [".stub"],
					command: [process.execPath, stub, record],
					args: ["--global-flag"],
				},
			},
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
	return { project, record };
}

async function compile(project: string) {
	const config = await loadLSPConfig(project);
	return compileLspRegistry(config, config.__provenance);
}

/** Starts the compiled `stub` server for real and reads the argv it saw. */
async function startedArgv(arranged: Arranged): Promise<string[]> {
	const registry = await compile(arranged.project);
	const server = registry.customServers.find((entry) => entry.id === "stub");
	if (!server) throw new Error("global stub server was not registered");
	const launch = await server.spawn(arranged.project);
	if (!launch) throw new Error("stub spawn was not admitted");
	pids.push(launch.process.pid);
	const raw = await waitFor(
		() =>
			fs.existsSync(arranged.record)
				? fs.readFileSync(arranged.record, "utf8")
				: "",
		(value) => value !== "",
	);
	return JSON.parse(raw) as string[];
}

function decisionFields(): string[] {
	return (
		getDegradationSummary()
			.find((group) => group.kind === "lsp-registry-decision")
			?.latestReasons.map((entry) => entry.reason) ?? []
	);
}

describe("untrusted project fields on a global LSP server (#5147)", () => {
	async function expectProjectArgsRefused(trust: Trust): Promise<void> {
		const arranged = arrange(trust, { args: ["--project-flag"] });
		const argv = await startedArgv(arranged);
		expect(argv).not.toContain("--project-flag");
		expect(decisionFields()).toContainEqual(
			expect.stringContaining("project LSP args refused for stub"),
		);
	}

	it("does not carry an untrusted project's args to the started child's argv", async () => {
		await expectProjectArgsRefused("untrusted");
	});

	it("does not carry an unknown-trust project's args to the started child's argv", async () => {
		await expectProjectArgsRefused("unknown");
	});

	it("carries a trusted project's args to the started child's argv", async () => {
		const arranged = arrange("trusted", { args: ["--project-flag"] });
		expect(await startedArgv(arranged)).toEqual(["--project-flag"]);
		expect(decisionFields()).toEqual([]);
	});

	it("starts a global-only config with the global args under every trust state", async () => {
		for (const trust of ["untrusted", "unknown", "trusted"] as const) {
			const arranged = arrange(trust, undefined);
			expect(await startedArgv(arranged), trust).toEqual(["--global-flag"]);
		}
		expect(decisionFields()).toEqual([]);
	});

	it("refuses project rootMarkers and covers, and keeps name and extensions", async () => {
		const arranged = arrange("untrusted", {
			name: "Project label",
			extensions: [".proj"],
			rootMarkers: ["Cargo.toml"],
			covers: ["shellcheck"],
		});
		const server = (await compile(arranged.project)).customServers.find(
			(entry) => entry.id === "stub",
		);
		expect(server?.name).toBe("Project label");
		expect(server?.extensions).toEqual([".proj"]);
		expect(server?.rootMarkers).toBeUndefined();
		expect(server?.covers).toBeUndefined();
		expect(decisionFields()).toEqual(
			expect.arrayContaining([
				expect.stringContaining("project LSP rootMarkers refused for stub"),
				expect.stringContaining("project LSP covers refused for stub"),
			]),
		);
	});

	it("keeps project rootMarkers and covers once pi trusts the project", async () => {
		const arranged = arrange("trusted", {
			rootMarkers: ["Cargo.toml"],
			covers: ["shellcheck"],
		});
		const server = (await compile(arranged.project)).customServers.find(
			(entry) => entry.id === "stub",
		);
		expect(server?.rootMarkers).toEqual(["Cargo.toml"]);
		expect(server?.covers).toEqual(["shellcheck"]);
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
			"project LSP unrecognized field refused for stub: pi project trust is untrusted",
		]);
	});

	it("keeps a field no table names once pi trusts the project", async () => {
		const arranged = arrange("trusted", { syntheticLaunchFlag: "--x" });
		await compile(arranged.project);
		expect(decisionFields()).toEqual([]);
	});

	it("decides every serverOverrides field as refused-without-trust", () => {
		expect(
			Object.values(REPO_TIER_OVERRIDE_FIELDS).filter((row) => row.admit),
		).toEqual([]);
	});

	it("refuses an untrusted serverOverrides field no table names, and keeps trusted ones", async () => {
		const overrides = {
			rust: { args: ["--project-flag"], syntheticLaunchFlag: true },
		};
		const untrusted = arrange("untrusted", undefined, overrides);
		const registry = await compile(untrusted.project);
		expect(registry.serverOverrides.get("rust")).toBeUndefined();
		expect(decisionFields()).toEqual([
			"project LSP unrecognized field refused for rust: pi project trust is untrusted",
		]);
		resetDegradationLedger();
		const trusted = arrange("trusted", undefined, overrides);
		await compile(trusted.project);
		expect(decisionFields()).toEqual([]);
	});
});
