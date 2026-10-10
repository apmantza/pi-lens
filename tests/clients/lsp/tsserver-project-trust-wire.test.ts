// flake-shape: real-process-spawn — #4299 F1/F3: only the real typescript-language-server resolver can expose implicit workspace compiler forks; a launcher double hid the security defect.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../../clients/latency-logger.js";
import { withEnv } from "../../support/with-env.js";
import {
	setProjectTrustState,
	resetProjectTrust,
} from "../../../clients/project-trust.js";
import { resolveAnalysisRoot } from "../../../clients/analysis-root.js";
import { resetLSPConfigStateForTests } from "../../../clients/lsp/config.js";
import { LSPService } from "../../../clients/lsp/index.js";
import {
	getServerById,
	resetLspLaunchAvailabilityGeneration,
} from "../../../clients/lsp/server.js";
import {
	resetDegradationLedger,
	getDegradationSummary,
} from "../../../clients/degradation-ledger.js";

const { compiler, wrapper, selectedRoot, initOverride } = vi.hoisted(() => ({
	compiler: { value: "tsc" as string | undefined },
	wrapper: { value: "" },
	selectedRoot: { value: "" },
	initOverride: { value: undefined as Record<string, unknown> | undefined },
}));
// Installation/discovery is the external tool boundary. The launcher, wrapper,
// trust, service, client, root ownership and degradation store remain real.
vi.mock("../../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/installer/index.js")
	>()),
	ensureTool: async (id: string) =>
		id === "typescript-language-server"
			? wrapper.value
			: id === "typescript"
				? compiler.value
				: undefined,
}));
vi.mock("../../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/config.js")>()),
	getServerInitOverride: () =>
		initOverride.value
			? { initializationOptions: initOverride.value }
			: undefined,
	getServersForFileWithConfig: () => [
		{ ...TypeScriptServer, root: async () => selectedRoot.value },
	],
}));
const TypeScriptServer = getServerById("typescript")!;
const require = createRequire(import.meta.url);
const realWrapper = require.resolve("typescript-language-server/lib/cli.mjs");
const originalCwd = process.cwd();
let tmp: string;
let restoreEnv: () => void;
let service: LSPService | undefined;

function compilerTree(root: string, label: string, version = "5.9.3") {
	const pkg = path.join(root, "node_modules", "typescript");
	fs.mkdirSync(path.join(pkg, "lib"), { recursive: true });
	fs.writeFileSync(
		path.join(pkg, "package.json"),
		JSON.stringify({ name: "typescript", version }),
	);
	const marker = path.join(tmp, `${label}.marker`);
	// Package fixture is intentionally hostile. A tiny IPC protocol responder
	// supplies a barrier: a definition reply proves the fork has executed.
	// Wrapper 5.3.0, git SHA 589044479e4bc2bffb796b593242136f5323b582,
	// cli.mjs NodeTsServerProcessFactory.fork uses IPC for >=4.9.
	fs.writeFileSync(
		path.join(pkg, "lib", "tsserver.js"),
		`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");
process.on("message", req => { if (req.type === "request") process.send({seq:0,type:"response",request_seq:req.seq,command:req.command,success:true,body:[]}); });
`,
	);
	const bin = path.join(root, "node_modules", ".bin");
	fs.mkdirSync(bin, { recursive: true });
	const tsc = path.join(bin, "tsc");
	fs.writeFileSync(tsc, "");
	return { marker, tsc };
}
function project(root: string) {
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), "{}");
	fs.writeFileSync(path.join(root, "tsconfig.json"), "{}");
	const file = path.join(root, "main.ts");
	fs.writeFileSync(file, "const x = 1;");
	return file;
}
async function attach(session: string, root: string, file: string) {
	selectedRoot.value = root;
	service = new LSPService(undefined, session);
	const spawned = await service.getClientForFile(file);
	if (spawned) {
		await spawned.client.notify.open(
			file,
			fs.readFileSync(file, "utf8"),
			"typescript",
		);
		await spawned.client.definition(file, 0, 0);
	}
	return spawned;
}
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ts-trust-wire-"));
	// Real projects must sit outside the OS-temp artifact classifier. Keep
	// the named fixture root tracked, but give children their own temp folder.
	const childTmp = path.join(tmp, "os-temp");
	fs.mkdirSync(childTmp);
	restoreEnv = withEnv({
		TMPDIR: childTmp,
		TEMP: childTmp,
		TMP: childTmp,
		PI_LENS_HOME: path.join(tmp, "home"),
		PILENS_DATA_DIR: path.join(tmp, "data"),
		PI_LENS_TEST_MODE: "0",
		PI_LENS_DISABLE_TOOL_INSTALL: "1",
		PI_LENS_DISABLE_LSP_INSTALL: "1",
	});
	// Absolute wrapper path outside the project, through the real launcher.
	wrapper.value = realWrapper;
	compiler.value = "tsc";
	initOverride.value = undefined;
	resetLSPConfigStateForTests();
	resetDegradationLedger();
	resetLspLaunchAvailabilityGeneration();
});
afterEach(async () => {
	await service?.shutdown();
	service = undefined;
	process.chdir(originalCwd);
	restoreEnv();
	resetProjectTrust();
	resetLSPConfigStateForTests();
	removeTempDirSync(tmp);
});

describe("real wrapper effective compiler trust (#4299)", () => {
	it.each(["unknown", "untrusted", "trusted"] as const)(
		"%s trust controls the real project compiler fork",
		async (trust) => {
			const root = path.join(tmp, "project");
			const file = project(root);
			const hostile = compilerTree(root, "hostile");
			process.chdir(root);
			setProjectTrustState(trust);
			const spawned = await attach(root, root, file);
			expect(fs.existsSync(hostile.marker)).toBe(trust === "trusted");
			expect(Boolean(spawned)).toBe(trust === "trusted");
			if (trust === "unknown") {
				const decisions = getDegradationSummary().filter(
					(row) => row.kind === "lsp-registry-decision",
				);
				expect(decisions.length).toBeGreaterThan(0);
				await flushLatencyLog();
				const rows = fs
					.readFileSync(getLatencyLogPath(), "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(rows).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							phase: "degradation_ledger",
							metadata: expect.objectContaining({
								kind: "lsp-registry-decision",
								subject: decisions[0]!.latestReasons[0]!.subject,
								trust: "unknown",
								count: 1,
							}),
						}),
					]),
				);
			}
		},
	);
	it("refuses a hoisted cwd compiler outside the nested LSP root (#4299 F2)", async () => {
		const session = path.join(tmp, "repo");
		project(session);
		const root = path.join(session, "packages", "app");
		const file = project(root);
		const hoisted = compilerTree(session, "hoisted");
		compilerTree(root, "decoy");
		process.chdir(session);
		setProjectTrustState("unknown");
		expect(await attach(session, root, file)).toBeUndefined();
		expect(fs.existsSync(hoisted.marker)).toBe(false);
	});
	it("refuses adopted project code even in a trusted session (#4242/#4299)", async () => {
		const session = path.join(tmp, "session");
		project(session);
		const root = path.join(tmp, "adopted");
		const file = project(root);
		const hostile = compilerTree(root, "adopted");
		expect(resolveAnalysisRoot(file, session)).toBe("adopted");
		process.chdir(session);
		setProjectTrustState("trusted");
		expect(await attach(session, root, file)).toBeUndefined();
		expect(fs.existsSync(hostile.marker)).toBe(false);
	});
	it("forces an absolute managed compiler through the real wrapper under unknown trust", async () => {
		const root = path.join(tmp, "project");
		const file = project(root);
		const hostile = compilerTree(root, "hostile");
		const managed = compilerTree(path.join(tmp, "managed"), "managed");
		compiler.value = managed.tsc;
		process.chdir(root);
		setProjectTrustState("unknown");
		expect(await attach(root, root, file)).toBeDefined();
		expect(fs.existsSync(managed.marker)).toBe(true);
		expect(fs.existsSync(hostile.marker)).toBe(false);
	});
	it("preserves the admitted compiler over configuration hints for a trusted adopted root", async () => {
		const session = path.join(tmp, "session");
		project(session);
		const root = path.join(tmp, "adopted");
		const file = project(root);
		const hostile = compilerTree(root, "override-hostile");
		const managed = compilerTree(path.join(tmp, "managed"), "override-managed");
		compiler.value = managed.tsc;
		initOverride.value = {
			tsserver: {
				path: path.join(
					root,
					"node_modules",
					"typescript",
					"lib",
					"tsserver.js",
				),
			},
		};
		expect(resolveAnalysisRoot(file, session)).toBe("adopted");
		process.chdir(session);
		setProjectTrustState("trusted");
		expect(await attach(session, root, file)).toBeDefined();
		expect(fs.existsSync(managed.marker)).toBe(true);
		expect(fs.existsSync(hostile.marker)).toBe(false);
	});

	it("does not derive a compiler from bare PATH tsc relative to cwd", async () => {
		const root = path.join(tmp, "project");
		const file = project(root);
		// typescriptDirsForTsc("tsc") would search ../typescript from cwd.
		const sibling = compilerTree(path.join(tmp, "sibling"), "sibling");
		fs.renameSync(
			path.join(tmp, "sibling", "node_modules", "typescript"),
			path.join(tmp, "typescript"),
		);
		process.chdir(root);
		setProjectTrustState("unknown");
		expect(await attach(root, root, file)).toBeUndefined();
		expect(fs.existsSync(sibling.marker)).toBe(false);
	});
	it("refuses project ancestry above the session directory under unknown trust", async () => {
		const repo = path.join(tmp, "repo");
		project(repo);
		const session = path.join(repo, "packages", "app");
		const file = project(session);
		const hostile = compilerTree(repo, "ancestor");
		process.chdir(session);
		setProjectTrustState("unknown");
		expect(await attach(session, session, file)).toBeUndefined();
		expect(fs.existsSync(hostile.marker)).toBe(false);
	});
	it("classifies the real compiler behind a managed symlink", async (context) => {
		const root = path.join(tmp, "project");
		const file = project(root);
		const hostile = compilerTree(root, "linked-hostile");
		const managedRoot = path.join(tmp, "managed");
		const managed = compilerTree(managedRoot, "linked-managed");
		compiler.value = managed.tsc;
		const candidate = path.join(
			managedRoot,
			"node_modules",
			"typescript",
			"lib",
			"tsserver.js",
		);
		fs.unlinkSync(candidate);
		try {
			fs.symlinkSync(
				path.join(root, "node_modules", "typescript", "lib", "tsserver.js"),
				candidate,
			);
		} catch (error) {
			context.skip(
				`filesystem cannot create the compiler symlink: ${String(error)}`,
			);
		}
		process.chdir(root);
		setProjectTrustState("unknown");
		expect(await attach(root, root, file)).toBeUndefined();
		expect(fs.existsSync(hostile.marker)).toBe(false);
	});

	it("gates an absolute discovery path inside the session outside the LSP root", async () => {
		const session = path.join(tmp, "session");
		project(session);
		const root = path.join(session, "packages", "app");
		const file = project(root);
		const disguised = compilerTree(path.join(session, "tools"), "disguised");
		compiler.value = disguised.tsc;
		process.chdir(session);
		setProjectTrustState("unknown");
		expect(await attach(session, root, file)).toBeUndefined();
		expect(fs.existsSync(disguised.marker)).toBe(false);
	});

	it("never lets invalid explicit compiler metadata fall back to the workspace", async () => {
		const root = path.join(tmp, "project");
		const file = project(root);
		const hostile = compilerTree(root, "hostile");
		const managed = compilerTree(path.join(tmp, "managed"), "invalid", "");
		compiler.value = managed.tsc;
		process.chdir(root);
		setProjectTrustState("unknown");
		expect(await attach(root, root, file)).toBeUndefined();
		expect(fs.existsSync(hostile.marker)).toBe(false);
	});
});
