/**
 * #4403: the LSP scripts' one reading of a touch (scripts/lib/touch-result.mjs)
 * takes a touch that no server answered as "no client ready", a disabled
 * primary included, and a wrapped answer as an answer.
 *
 * Recurrences:
 * - Since PR #4411, `touchFile` returns the `primary-unavailable` verdict with
 *   no diagnostics, not `undefined`, when the operator disabled a primary and
 *   nothing else answered. The smoke handshake lane read that as an answer, so
 *   PR #4450's handshake job failed the official Docker row ("expected
 *   alternate docker-official, got no warm client") on a runner without the
 *   binary, where it had reported the row unavailable (#4465).
 * - Since #1179 the answer is a `{ diags }` wrapper; bench-lsp still tested
 *   `Array.isArray` and reported every installed server unavailable.
 * - #4466 review F1: an auxiliary requested but never started read as a clean
 *   answer, so bench-lsp timed spawns that did not happen.
 *
 * The real LSPService with the smoke rows' own touch options. Server commands
 * are project overrides: a path that does not exist, or the shared fake server,
 * which answers with one finding.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { touchAnsweredDiagnostics } from "../../scripts/lib/touch-result.mjs";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const PREFIX = "pi-lens-4403-smoke-";

type TouchResult = Parameters<typeof touchAnsweredDiagnostics>[0];
type Service = {
	touchFile: (
		file: string,
		content: string,
		options: Record<string, unknown>,
	) => Promise<TouchResult>;
	getWarmClientForFile: (
		file: string,
	) => Promise<{ info: { id: string } } | undefined>;
	getAliveServerIds: () => string[];
	shutdown: () => Promise<void>;
};
let service: Service | undefined;
const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;

/**
 * A workspace whose `.pi-lens/lsp.json` points each named server at the fake
 * server, or at a missing binary, and turns off `disabled` plus the
 * auxiliaries no case asks for.
 */
async function workspace(options: {
	file: string;
	content: string;
	fake: string[];
	missing?: string[];
	/** #5727: fake servers that hold their first pull past the touch's wait. */
	slow?: string[];
	/** #5727: fake servers that never answer a pull. */
	silent?: string[];
	disabled: string[];
}) {
	const root = fs.realpathSync(setupTestEnvironment(PREFIX).tmpDir);
	// The shared fixture marker supplies the `.git` root `NearestRoot` walks to
	// (#4560); planting a second one threw EEXIST and skipped this suite.
	fs.mkdirSync(path.join(root, ".pi-lens"));
	const serverOverrides = Object.fromEntries([
		...options.fake.map((id) => [
			id,
			{ command: [process.execPath, fakeServer] },
		]),
		...(options.missing ?? []).map((id) => [
			id,
			{ command: [path.join(root, "missing", id)] },
		]),
		...(options.slow ?? []).map((id) => [
			id,
			{
				command: [process.execPath, fakeServer],
				env: {
					FAKE_LSP_DELAY_FIRST_PULL: "1",
					FAKE_LSP_DELAY_AFTER_FIRST_PULL_MS: "20000",
				},
			},
		]),
		...(options.silent ?? []).map((id) => [
			id,
			{
				command: [process.execPath, fakeServer],
				env: { FAKE_LSP_HANG_METHODS: "textDocument/diagnostic" },
			},
		]),
	]);
	fs.writeFileSync(
		path.join(root, ".pi-lens", "lsp.json"),
		JSON.stringify({
			serverOverrides,
			disabledServers: [...options.disabled, "ast-grep", "opengrep", "zizmor"],
		}),
	);
	const file = path.join(root, options.file);
	fs.writeFileSync(file, options.content);
	process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
	// Host-boundary stub: project command overrides need a trusted project.
	setProjectTrustState("trusted");
	const config = await import("../../clients/lsp/config.js");
	config.resetLSPConfigStateForTests();
	await config.initLSPConfig(root);
	const lsp = await import("../../clients/lsp/index.js");
	lsp.resetLSPService();
	service = lsp.getLSPService() as unknown as Service;
	return { file, content: options.content };
}

/** The `dockerfile-official` smoke row: `docker` off, as the row writes it. */
function dockerfileRow(official: "missing" | "fake", fake: string[] = []) {
	return workspace({
		file: "Dockerfile",
		content: "FROM alpine:3.16.1\nCMD ls\n",
		fake: official === "fake" ? ["docker-official", ...fake] : fake,
		missing: official === "missing" ? ["docker-official"] : [],
		disabled: ["docker"],
	});
}

/** The touch `runLspHandshake` sends, with or without auxiliaries. */
function rowTouch(auxiliaryServerIds?: string[]) {
	return {
		diagnostics: "document",
		collectDiagnostics: true,
		clientScope: auxiliaryServerIds ? "with-auxiliary" : "primary",
		...(auxiliaryServerIds ? { auxiliaryServerIds } : {}),
		maxClientWaitMs: 15_000,
		maxDiagnosticsWaitMs: 4_000,
		source: "smoke-lsp",
	};
}

afterEach(async () => {
	await service?.shutdown();
	service = undefined;
});

afterAll(async () => {
	await cleanupTestEnvironmentsDrained(PREFIX);
	resetProjectTrust();
	if (savedInstall === undefined)
		delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
	else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
});

describe("the LSP scripts' reading of a touch (#4403)", () => {
	it("reads a disabled primary whose alternate is missing as no client ready", async () => {
		const row = await dockerfileRow("missing");
		const options = rowTouch();

		const touched = await service!.touchFile(row.file, row.content, options);

		expect(touched).toMatchObject({
			inconclusiveReason: "primary-unavailable",
			disabledPrimaryServerIds: ["docker"],
		});
		expect(
			touchAnsweredDiagnostics(touched, options, service!),
		).toBeUndefined();
	}, 30_000);

	it("reads the alternate's answer as an answer", async () => {
		const row = await dockerfileRow("fake");
		const options = rowTouch();

		const touched = await service!.touchFile(row.file, row.content, options);

		expect(touchAnsweredDiagnostics(touched, options, service!)).toEqual([
			expect.objectContaining({ serverId: "docker-official" }),
		]);
		expect((await service!.getWarmClientForFile(row.file))?.info.id).toBe(
			"docker-official",
		);
	}, 30_000);

	it("keeps a running auxiliary's findings when no primary answered", async () => {
		const notes = await workspace({
			file: "notes.md",
			content: "# Notes\n",
			fake: ["typos"],
			disabled: ["marksman"],
		});
		const options = rowTouch(["typos"]);

		const touched = await service!.touchFile(
			notes.file,
			notes.content,
			options,
		);

		expect(touched).toMatchObject({
			inconclusiveReason: "primary-unavailable",
		});
		expect(touchAnsweredDiagnostics(touched, options, service!)).toEqual([
			expect.objectContaining({ serverId: "typos" }),
		]);
	}, 30_000);

	it("reads a requested auxiliary that never started as no client ready", async () => {
		// typos is configured but does not attach to a Dockerfile, the shape
		// bench-lsp met for an auxiliary whose tool is not installed.
		const row = await dockerfileRow("missing", ["typos"]);
		const options = rowTouch(["typos"]);

		const touched = await service!.touchFile(row.file, row.content, options);

		expect(touched).toMatchObject({
			diags: [],
			inconclusiveReason: "primary-unavailable",
		});
		// #5727: an auxiliary that never started answered nothing, so a recorded
		// blocker of its own has no answer to be judged by.
		expect(touched).not.toHaveProperty("answeredServerIds");
		expect(service!.getAliveServerIds()).not.toContain("typos");
		expect(
			touchAnsweredDiagnostics(touched, options, service!),
		).toBeUndefined();
	}, 30_000);

	// #5727: the evidence that retires an auxiliary's own recorded blocker while
	// the runner reached no verdict. The write-time carry kept every recorded row
	// of the `lsp` runner whenever the primary did not answer, although the
	// auxiliary had answered these bytes; the touch names the auxiliaries whose
	// answer is bound to them, and only those.
	it("names the auxiliary that answered when no primary could start (#5727)", async () => {
		const notes = await workspace({
			file: "notes.md",
			content: "# Notes\n",
			fake: ["typos"],
			missing: ["marksman"],
			disabled: [],
		});

		const touched = await service!.touchFile(
			notes.file,
			notes.content,
			rowTouch(["typos"]),
		);

		expect(touched).toMatchObject({
			inconclusive: true,
			inconclusiveReason: "primary-unavailable",
			inconclusiveServerIds: ["marksman"],
			answeredServerIds: ["typos"],
		});
	}, 30_000);

	it("names the auxiliary that answered when the primary's answer did not arrive (#5727)", async () => {
		const notes = await workspace({
			file: "notes.md",
			content: "# Notes\n",
			fake: ["typos"],
			slow: ["marksman"],
			disabled: [],
		});

		const touched = await service!.touchFile(
			notes.file,
			notes.content,
			rowTouch(["typos"]),
		);

		expect(touched).toMatchObject({
			inconclusive: true,
			inconclusiveReason: "diagnostics-wait",
			inconclusiveServerIds: ["marksman"],
			answeredServerIds: ["typos"],
		});
	}, 30_000);

	// #5812 r5 (verify V1): a write the primary answered retires a pending
	// auxiliary row only when that auxiliary answered too, so a conclusive
	// touch names it as well; the list was set on inconclusive touches only,
	// and no write ever retired an ast-grep or opengrep row.
	it("names the auxiliary that answered beside a primary that answered (#5812)", async () => {
		const notes = await workspace({
			file: "notes.md",
			content: "# Notes\n",
			fake: ["marksman", "typos"],
			disabled: [],
		});

		const touched = await service!.touchFile(
			notes.file,
			notes.content,
			rowTouch(["typos"]),
		);

		expect(touched).not.toHaveProperty("inconclusive");
		expect(touched).toMatchObject({ answeredServerIds: ["typos"] });
	}, 30_000);

	it("does not name an auxiliary that stayed silent beside a primary that answered (#5812)", async () => {
		const notes = await workspace({
			file: "notes.md",
			content: "# Notes\n",
			fake: ["marksman"],
			silent: ["typos"],
			disabled: [],
		});

		const touched = await service!.touchFile(
			notes.file,
			notes.content,
			rowTouch(["typos"]),
		);

		expect(touched).not.toHaveProperty("inconclusive");
		expect(touched).toMatchObject({ unconfirmedServerIds: ["typos"] });
		expect(touched).not.toHaveProperty("answeredServerIds");
	}, 30_000);

	// The other half: an auxiliary that was acquired but did not answer is not
	// named, and the inconclusive touch names no coverage gap for it either, so
	// only the answered list can say an auxiliary answered.
	it("does not name an auxiliary that did not answer when no primary could start (#5727)", async () => {
		const notes = await workspace({
			file: "notes.md",
			content: "# Notes\n",
			missing: ["marksman"],
			fake: [],
			silent: ["typos"],
			disabled: [],
		});

		const touched = await service!.touchFile(
			notes.file,
			notes.content,
			rowTouch(["typos"]),
		);

		expect(touched).toMatchObject({
			inconclusive: true,
			inconclusiveReason: "primary-unavailable",
		});
		expect(service!.getAliveServerIds()).toContain("typos");
		expect(touched).not.toHaveProperty("answeredServerIds");
		expect(touched).not.toHaveProperty("unconfirmedServerIds");
	}, 30_000);
});
