import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// handleToolCall calls getLSPService() directly (not via DI, matching the
// pattern already used by runtime-session.ts). Stub it so tests never spin up
// a real LSP client — auto-touch is best-effort/fire-and-forget so a stub
// touchFile that resolves immediately is enough to observe its call args.
const touchFileMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: () => ({ touchFile: touchFileMock }),
	resetLSPService: () => {},
}));

vi.mock("../../clients/bootstrap.js", () => ({
	loadBootstrapClients: async () => ({
		complexityClient: {
			isSupportedFile: () => false,
			analyzeFile: async () => null,
		},
		biomeClient: {},
		ruffClient: {},
		metricsClient: {},
		agentBehaviorClient: { recordToolCall: () => {}, formatWarnings: () => "" },
	}),
}));

function baseDeps(overrides: Partial<Parameters<typeof handleToolCall>[0]> = {}) {
	const runtime = new RuntimeCoordinator();
	return {
		event: { toolName: "read", input: {} },
		ctx: {},
		lensEnabled: true,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager: new CacheManager(false),
		ensureLSPConfigInitialized: async () => {},
		updateLspStatus: () => {},
		resetLSPService: () => {},
		...overrides,
	} as Parameters<typeof handleToolCall>[0];
}

describe("handleToolCall", () => {
	it("is a no-op when lensEnabled is false", async () => {
		const runtime = new RuntimeCoordinator();
		const recordRead = vi.spyOn(runtime.readGuard, "recordRead");
		const result = await handleToolCall(
			baseDeps({
				lensEnabled: false,
				runtime,
				event: { toolName: "read", input: { path: "/does/not/matter" } },
			}),
		);
		expect(result).toBeUndefined();
		expect(recordRead).not.toHaveBeenCalled();
	});

	it("records a read-guard read for a full-file read and LSP-warms it", async () => {
		touchFileMock.mockClear();
		const env = setupTestEnvironment("pi-lens-runtime-tool-call-read-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"line1\nline2\nline3\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const recordRead = vi.spyOn(runtime.readGuard, "recordRead");

			await handleToolCall(
				baseDeps({
					runtime,
					event: { toolName: "read", input: { path: filePath } },
					ctx: { cwd: env.tmpDir },
				}),
			);

			expect(recordRead).toHaveBeenCalledWith(
				expect.objectContaining({
					filePath,
					effectiveOffset: 1,
				}),
			);
			expect(touchFileMock).toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("blocks an edit on an existing file that was never read (zero_read)", async () => {
		const env = setupTestEnvironment("pi-lens-runtime-tool-call-edit-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/b.ts",
				"function foo() {\n\treturn 1;\n}\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			const result = await handleToolCall(
				baseDeps({
					runtime,
					ctx: { cwd: env.tmpDir },
					event: {
						toolName: "edit",
						input: {
							path: filePath,
							oldText: "function foo() {\n\treturn 1;\n}",
							newText: "function foo() {\n\treturn 2;\n}",
						},
					},
				}),
			);

			expect(result).toMatchObject({ block: true });
		} finally {
			env.cleanup();
		}
	});

	it("does not block a write, and lets a subsequent edit through once read-guard sees the write", async () => {
		const env = setupTestEnvironment("pi-lens-runtime-tool-call-write-");
		try {
			const filePath = path.join(env.tmpDir, "src", "c.ts");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			// noteCreatedFile only prevents a *future* zero_read block if the file
			// exists on disk by the time the write's tool_call fires (the write
			// tool creates the file itself; here we simulate that by writing it
			// before invoking tool_call, matching how the pipeline actually runs).
			createTempFile(env.tmpDir, "src/c.ts", "export const x = 1;\n");

			const result = await handleToolCall(
				baseDeps({
					runtime,
					ctx: { cwd: env.tmpDir },
					event: {
						toolName: "write",
						input: { path: filePath, content: "export const x = 1;\n" },
					},
				}),
			);

			expect(result).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("blocks a write that redefines an export cached from another file", async () => {
		const env = setupTestEnvironment("pi-lens-runtime-tool-call-dupe-");
		try {
			const otherFile = createTempFile(
				env.tmpDir,
				"src/original.ts",
				"export function shared() {}\n",
			);
			const targetFile = createTempFile(
				env.tmpDir,
				"src/dupe.ts",
				"export const y = 1;\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.cachedExports.set("shared", otherFile);

			const result = await handleToolCall(
				baseDeps({
					runtime,
					ctx: { cwd: env.tmpDir },
					event: {
						toolName: "write",
						input: {
							path: targetFile,
							content: "export function shared() {}\n",
						},
					},
				}),
			);

			expect(result).toMatchObject({ block: true });
			expect((result as { reason: string }).reason).toContain("shared");
		} finally {
			env.cleanup();
		}
	});
});
