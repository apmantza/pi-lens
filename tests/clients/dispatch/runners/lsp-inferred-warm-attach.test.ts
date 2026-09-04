/**
 * #1645 review F2: under warm attach the per-edit runner must NOT probe project
 * membership.
 *
 * Warm attach means diagnostics came from an already-running remote session over
 * IPC, with no local client for this file. Probing there forces a language-server
 * spawn to answer a render-path question, and the answer belongs to the freshly
 * spawned server rather than the warm session that produced the diagnostics.
 * Both make the probe worse than useless.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeLspServiceDouble } from "../../../support/lsp-service-double.js";

const mocked = vi.hoisted(() => ({
	service: null as unknown,
	attachedDiagnostics: vi.fn(),
	attachedCodeActions: vi.fn(),
}));

vi.mock("../../../../clients/warm-attach.js", () => ({
	isWarmAttached: () => true,
	tryWarmAttachedDiagnostics: (...args: unknown[]) =>
		mocked.attachedDiagnostics(...args),
	tryWarmAttachedCodeActions: (...args: unknown[]) =>
		mocked.attachedCodeActions(...args),
}));

vi.mock("../../../../clients/lsp/index.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../../../clients/lsp/index.js")
	>("../../../../clients/lsp/index.js");
	return { ...actual, getLSPService: () => mocked.service };
});

import lspRunner from "../../../../clients/dispatch/runners/lsp.js";

const INFERRED_BODY = { configFileName: "/dev/null/inferredProject1*" };

function makeService() {
	return makeLspServiceDouble({
		executeReadOnlyCommandOnLiveClient: vi.fn(async () => ({
			executed: true,
			result: { success: true, body: INFERRED_BODY },
		})),
		executeCommand: vi.fn(async () => ({
			executed: true,
			result: { success: true, body: INFERRED_BODY },
		})),
		getAdvertisedCommands: vi.fn(async () => ["typescript.tsserverRequest"]),
		supportsLSP: vi.fn(() => true),
		codeAction: vi.fn(async () => []),
	});
}

describe("LSP dispatch runner — warm attach skips the membership probe (#1645 F2)", () => {
	let cwd: string;

	beforeEach(() => {
		mocked.attachedDiagnostics.mockReset();
		mocked.attachedCodeActions.mockReset();
		mocked.attachedCodeActions.mockResolvedValue({ available: false });
		mocked.service = makeService();
		cwd = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-warm-attach-")),
		);
	});

	it("never probes project membership on the warm-attach path", async () => {
		const file = path.join(cwd, "orphan.test.ts");
		fs.writeFileSync(file, "describe('x', () => {});\n");
		mocked.attachedDiagnostics.mockResolvedValue({
			available: true,
			response: {
				diagnostics: [
					{
						severity: 1,
						message: "Cannot find name 'describe'.",
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 8 },
						},
						source: "typescript",
						code: 2582,
					},
				],
			},
		});

		const result = await lspRunner.run({
			filePath: file,
			cwd,
			fileRole: "test",
			pi: { getFlag: () => undefined },
		} as never);

		// The finding still renders (unchanged pre-#1640 authority on this path)…
		expect(result.diagnostics.length).toBeGreaterThan(0);
		// …but not one byte of probe traffic was spent to decide that.
		const service = mocked.service as ReturnType<typeof makeService>;
		expect(service.executeReadOnlyCommandOnLiveClient).not.toHaveBeenCalled();
		expect(service.executeCommand).not.toHaveBeenCalled();
		expect(service.getAdvertisedCommands).not.toHaveBeenCalled();
	});
});
