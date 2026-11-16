// flake-shape: real-process-spawn — a server that dies or answers -32801 mid-codeAction is observed through a real JSON-RPC connection to a real child; the fully serialized wall-clock-budget lane runs it.
/**
 * #5258 (shape 10): `LSPClient.codeAction` answered `[]` for a request nobody
 * answered, so "could not ask" read as "no actions". The persistent re-verify
 * retires a carried warning whose lookup returns no action, so a server that
 * died or answered ContentModified mid-lookup retired a warning that was never
 * re-observed (the false clean this issue tracks).
 *
 * The contract now: an array (empty included, and a server's own `null`) is
 * the server's answer; `undefined` is no answer. These cases drive the real
 * client and, through the real LSPService and `runPersistentReverify`, the
 * verdict that retires a warning, against the shared fake server
 * (`FAKE_LSP_CODE_ACTION_REPLY`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getServersForFileWithConfig } = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
}));

import { resetDegradationLedger } from "../../../clients/degradation-ledger.js";
import { _setServersForFileForTests } from "../../../clients/lsp/config.js";
import type { ActionableWarningsReport } from "../../../clients/actionable-warnings.js";
import { createLSPClient } from "../../../clients/lsp/client.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { runPersistentReverify } from "../../../clients/persistent-reverify.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { removeTempDirSync } from "../test-utils.js";

type Reply = "default" | "null" | "exit" | "content-modified" | "malformed";

describe("a codeAction nobody answered is not an empty list (#5258)", () => {
	let tmp: string;
	let service: LSPService;

	beforeEach(() => {
		_setServersForFileForTests(getServersForFileWithConfig);
		tmp = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-codeaction-5258-")),
		);
		resetDegradationLedger();
		service = new LSPService();
	});
	afterEach(async () => {
		_setServersForFileForTests(undefined);
		await service.shutdown();
		removeTempDirSync(tmp);
	});

	const env = (reply: Reply) => ({
		...process.env,
		FAKE_LSP_CODE_ACTION_REPLY: reply,
		// A warning the actionable-warnings lane carries, keyed `fake-rust:FAKE1001`.
		FAKE_LSP_DIAGNOSTIC_SEVERITY: "2",
		FAKE_LSP_DIAGNOSTIC_SOURCE: "fake-rust",
		FAKE_LSP_DIAGNOSTIC_MESSAGE: "unused",
	});

	function register(reply: Reply): string {
		const filePath = path.join(tmp, "main.fkr");
		fs.writeFileSync(filePath, "fn main() {}\n");
		const server = {
			id: "fake-rust",
			name: "fake-rust",
			extensions: [".fkr"],
			idleEviction: "resident",
			root: async () => tmp,
			spawn: async () => ({
				process: await spawnFakeLspServer({ cwd: tmp, env: env(reply) }),
				source: "test",
			}),
		};
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".fkr") ? [server] : [],
		);
		return filePath;
	}

	function carriedReport(filePath: string): ActionableWarningsReport {
		const stamp = new Date().toISOString();
		return {
			generatedAt: stamp,
			scope: "turn_delta",
			sessionId: "s1",
			turnIndex: 1,
			deltaOnly: true,
			includeLspCodeActions: false,
			files: [
				{
					filePath,
					displayPath: "main.fkr",
					origin: "deferred",
					generatedAt: stamp,
					warnings: [
						{
							id: "w1",
							filePath,
							displayPath: "main.fkr",
							line: 1,
							severity: "warning",
							tool: "fake-rust",
							source: "fake-rust",
							code: "FAKE1001",
							rule: "fake-rust:FAKE1001",
							message: "unused",
							actions: [],
							suppressed: false,
							origin: "lsp",
						},
					],
				},
			],
			summary: {
				warnings: 1,
				unsuppressed: 1,
				suppressed: 0,
				files: 1,
				actions: 0,
				autoFixEligible: 0,
			},
		};
	}

	async function reverify(reply: Reply) {
		const filePath = register(reply);
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(filePath, past, past);
		return runPersistentReverify({
			report: carriedReport(filePath),
			cwd: tmp,
			lspService: service as never,
			budgetMs: 10_000,
		});
	}

	async function clientAnswer(reply: Reply) {
		const file = path.join(tmp, "a.ts");
		fs.writeFileSync(file, "function greet() {}\n");
		fs.writeFileSync(path.join(tmp, "package.json"), "{}");
		const proc = await spawnFakeLspServer({ cwd: tmp, env: env(reply) });
		const client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: tmp,
		});
		try {
			await client.notify.open(file, "function greet() {}\n", "typescript");
			return await client.codeAction(file, 0, 0, 0, 5);
		} finally {
			await client.shutdown();
		}
	}

	// The control and the three unanswered shapes, at the wire.
	it("an answered list, or the server's own null, is an answer", async () => {
		expect((await clientAnswer("default"))?.map((a) => a.title)).toEqual([
			"Replace greeting",
		]);
		expect(await clientAnswer("null")).toEqual([]);
	}, 20_000);

	it("a server that exits mid-request is no answer, not an empty list", async () => {
		expect(await clientAnswer("exit")).toBeUndefined();
	}, 20_000);

	it("a ContentModified reply is no answer, not an empty list", async () => {
		expect(await clientAnswer("content-modified")).toBeUndefined();
	}, 20_000);

	it("a reply that is not a list is no answer, not an empty list", async () => {
		expect(await clientAnswer("malformed")).toBeUndefined();
	}, 20_000);

	it("a dead client is no answer, not an empty list", async () => {
		const file = path.join(tmp, "a.ts");
		fs.writeFileSync(file, "function greet() {}\n");
		const proc = await spawnFakeLspServer({ cwd: tmp, env: env("default") });
		const client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: tmp,
		});
		await client.shutdown();
		expect(await client.codeAction(file, 0, 0, 0, 5)).toBeUndefined();
	}, 20_000);

	// The verdict that retires a carried warning.
	it("the re-verify retires a warning whose lookup the server answered with no action", async () => {
		const result = await reverify("null");
		expect(result.outcomes.map((o) => o.outcome)).toEqual(["clean"]);
		expect(result.replacementFiles[0]?.warnings).toEqual([]);
	}, 30_000);

	async function expectKept(reply: Reply) {
		const result = await reverify(reply);
		expect(result.outcomes.map((o) => o.outcome)).toEqual(["unconfirmed"]);
		expect(result.replacementFiles[0]?.warnings).toHaveLength(1);
	}

	it("the re-verify keeps a carried warning when the server exits mid-lookup", async () => {
		await expectKept("exit");
	}, 30_000);

	it("the re-verify keeps a carried warning when the server answers ContentModified", async () => {
		await expectKept("content-modified");
	}, 30_000);
});
