import { beforeEach, describe, expect, it, vi } from "vitest";

const { serviceHolder, logLatency } = vi.hoisted(() => ({
	serviceHolder: { current: null as unknown },
	logLatency: vi.fn(),
}));

vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency,
}));
vi.mock("../../clients/lsp/index.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/lsp/index.js")>();
	return { ...actual, getLSPService: () => serviceHolder.current };
});

import { LSPService } from "../../clients/lsp/index.js";
import type { LSPOperationSupport } from "../../clients/lsp/client.js";
import { createLspNavigationTool } from "../../tools/lsp-navigation.js";

const support = (workspaceSymbol: boolean): LSPOperationSupport => ({
	definition: false,
	typeDefinition: false,
	declaration: false,
	references: false,
	hover: false,
	signatureHelp: false,
	documentSymbol: false,
	workspaceSymbol,
	codeAction: false,
	codeActionResolve: false,
	rename: false,
	willRenameFiles: false,
	didRenameFiles: false,
	implementation: false,
	callHierarchy: false,
});

function client(workspaceSymbol: boolean) {
	return {
		isAlive: () => true,
		getOperationSupport: () => support(workspaceSymbol),
		workspaceSymbol: vi.fn(async () =>
			workspaceSymbol ? [{ name: "servedByTypescript", kind: 12 }] : [],
		),
	};
}

function injectClient(service: LSPService, key: string, value: unknown): void {
	(
		service as unknown as { state: { clients: Map<string, unknown> } }
	).state.clients.set(key, value);
}

describe("workspace-scope LSP client attribution (#1854)", () => {
	beforeEach(() => {
		logLatency.mockReset();
	});

	it("records the serving client when two real primary map entries can disagree", async () => {
		const json = client(false);
		const typescript = client(true);
		const service = new LSPService();
		injectClient(service, "json:C:/workspace", json);
		injectClient(service, "typescript:C:/workspace", typescript);
		serviceHolder.current = service;

		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const result = await tool.execute(
			"workspace-attribution",
			{ operation: "workspaceSymbol", query: "servedByTypescript" },
			new AbortController().signal,
			null,
			{ cwd: "C:/workspace" },
		);

		expect(result.isError).toBeUndefined();
		expect(json.workspaceSymbol).not.toHaveBeenCalled();
		expect(typescript.workspaceSymbol).toHaveBeenCalledOnce();

		const record = logLatency.mock.calls
			.map(([entry]) => entry as Record<string, unknown>)
			.find((entry) => entry.phase === "lsp_navigation_result");
		expect(record).toBeDefined();
		expect(record?.metadata).toMatchObject({
			workspaceScopeAttribution: {
				getOperationSupport: {
					baseClientId: "json",
					contributors: { workspaceSymbol: "typescript" },
				},
				workspaceSymbol: "typescript",
			},
		});
		expect(record?.metadata).not.toMatchObject({
			workspaceScopeAttribution: { workspaceSymbol: "json" },
		});
	});
});
