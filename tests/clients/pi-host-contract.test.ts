/**
 * pi host-contract regressions (#1655).
 *
 * Every case here is written against what pi ACTUALLY does, read out of the
 * pinned `@earendil-works/pi-coding-agent` build rather than out of an
 * imagined event shape. Several assertions read the host's own compiled
 * source, so the contract stays auditable against upstream: when pi changes,
 * these fail and name the drift instead of silently going vacuous.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	normalizeHostToolPath,
	resolveHostPathVariants,
	resolveHostToolPath,
} from "../../clients/path-utils.js";
import {
	readHostModelIdentity,
	RuntimeCoordinator,
} from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const touchFileMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: () =>
		makeLspServiceDouble({
			touchFile: touchFileMock,
			getWarmClientForFile: vi.fn().mockResolvedValue(undefined),
		}),
	resetLSPService: () => {},
}));

vi.mock("../../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("../support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		complexityClient: {
			isSupportedFile: () => false,
			analyzeFile: async () => null,
		},
		biomeClient: {},
		ruffClient: {},
		metricsClient: {},
		agentBehaviorClient: { recordToolCall: () => {}, formatWarnings: () => "" },
	}));
});

const readGuardLogEntries: Array<Record<string, unknown>> = [];
vi.mock("../../clients/read-guard-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/read-guard-logger.js")>();
	return {
		...actual,
		logReadGuardEvent: (entry: Record<string, unknown>) => {
			readGuardLogEntries.push(entry);
		},
	};
});

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const HOST_DIST = path.join(
	repoRoot,
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
	"dist",
);

function readHostSource(relative: string): string {
	const file = path.join(HOST_DIST, relative);
	// Deliberately not skipped when missing: a vanished host build must fail
	// loudly, not quietly turn every assertion below into a no-op (shape 7).
	expect(
		fs.existsSync(file),
		`pinned host build missing: ${file} — is @earendil-works/pi-coding-agent installed?`,
	).toBe(true);
	return fs.readFileSync(file, "utf-8");
}

function baseDeps(
	overrides: Partial<Parameters<typeof handleToolCall>[0]> = {},
): Parameters<typeof handleToolCall>[0] {
	return {
		event: { toolName: "read", input: {} },
		ctx: {},
		lensEnabled: true,
		getFlag: () => false,
		dbg: () => {},
		runtime: new RuntimeCoordinator(),
		cacheManager: new CacheManager(false),
		ensureLSPConfigInitialized: async () => {},
		updateLspStatus: () => {},
		resetLSPService: () => {},
		...overrides,
	} as Parameters<typeof handleToolCall>[0];
}

beforeEach(() => {
	resetDegradationLedger();
	readGuardLogEntries.length = 0;
	touchFileMock.mockClear();
});

describe("#1655 item 1 — a throwing tool_call handler must not block the tool", () => {
	it("pi's emitToolCall really has no per-handler catch (the premise)", () => {
		const runner = readHostSource(path.join("core", "extensions", "runner.js"));
		const emitToolCall = runner.slice(runner.indexOf("async emitToolCall("));
		const body = emitToolCall.slice(
			0,
			emitToolCall.indexOf("async emitUserBash("),
		);
		expect(body).toContain("await handler(event, ctx)");
		expect(body).not.toContain("catch");

		// ...and the sibling emit paths DO catch, which is what makes tool_call
		// the one unguarded seam rather than a general host property.
		const emitToolResult = runner.slice(
			runner.indexOf("async emitToolResult("),
			runner.indexOf("async emitToolCall("),
		);
		expect(emitToolResult).toContain("catch");

		// The caller turns an escaped throw into a refused user tool call.
		const session = readHostSource(path.join("core", "agent-session.js"));
		expect(session).toContain("Extension failed, blocking execution");
	});

	it("absorbs a handler-internal throw and records one degradation", async () => {
		const boom = new Error("handler exploded");
		const result = await handleToolCall(
			baseDeps({
				event: { toolName: "edit", input: { path: "/tmp/x.ts" } },
				getFlag: () => {
					throw boom;
				},
			}),
		);

		// `undefined` is "pi-lens has no opinion" — the tool proceeds.
		expect(result).toBeUndefined();
		const group = getDegradationSummary().find(
			(entry) => entry.kind === "tool-call-handler-throw",
		);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons.at(-1)).toMatchObject({
			subject: "edit",
			reason: "handler exploded",
		});
	});

	it("records the repeat throw once per tool name", async () => {
		const deps = () =>
			baseDeps({
				event: { toolName: "read", input: { path: "/tmp/x.ts" } },
				getFlag: () => {
					throw new Error("still broken");
				},
			});
		await handleToolCall(deps());
		await handleToolCall(deps());
		await handleToolCall(deps());

		const group = getDegradationSummary().find(
			(entry) => entry.kind === "tool-call-handler-throw",
		);
		expect(group?.count).toBe(1);
	});
});

describe("#1655 item 2 — pi-lens must not type tool_result fields pi never sets", () => {
	/** The keys pi's `afterToolCall` assigns on the tool_result event literal. */
	const HOST_TOOL_RESULT_KEYS = [
		"type",
		"toolName",
		"toolCallId",
		"input",
		"content",
		"details",
		"isError",
		"usage",
	];

	it("pins the host-shape fixture against pi's own build", () => {
		const session = readHostSource(path.join("core", "agent-session.js"));
		const hook = session.slice(session.indexOf("afterToolCall = async"));
		const literalStart = hook.indexOf("emitToolResult({");
		const literal = hook.slice(
			literalStart,
			hook.indexOf("})", literalStart) + 2,
		);
		// `key: value` plus the shorthand form pi uses for `isError,`.
		const assigned = [...literal.matchAll(/^\s+(\w+)\s*[:,]/gm)].map(
			(match) => match[1],
		);
		expect(new Set(assigned)).toEqual(new Set(HOST_TOOL_RESULT_KEYS));
	});

	it("declares no ToolResultEvent field the host never assigns", () => {
		const source = fs.readFileSync(
			path.join(repoRoot, "clients", "runtime-tool-result.ts"),
			"utf-8",
		);
		const start = source.indexOf("interface ToolResultEvent {");
		expect(start).toBeGreaterThan(-1);
		const body = source.slice(start, source.indexOf("\n}", start));
		const declared = [...body.matchAll(/^\t(\w+)\??:/gm)].map(
			(match) => match[1],
		);
		expect(declared.length).toBeGreaterThan(0);
		const vacuous = declared.filter(
			(field) => !HOST_TOOL_RESULT_KEYS.includes(field),
		);
		expect(vacuous).toEqual([]);
	});

	it("leaves no setTelemetryIdentity call gated on a tool_result field", () => {
		const source = fs.readFileSync(
			path.join(repoRoot, "clients", "runtime-tool-result.ts"),
			"utf-8",
		);
		// The identity source is the runtime, populated from the host ctx —
		// never the event, which carries none of these.
		expect(source).not.toMatch(/if \(event\.model \|\| event\.provider/);
		expect(source).not.toMatch(/event\.session\?\.id/);
	});

	it("reads telemetry identity from the ctx, never from event fields", () => {
		const source = fs.readFileSync(path.join(repoRoot, "index.ts"), "utf-8");
		// The old reader. pi sets none of these on session_start or tool_result,
		// so it adopted nothing and `telemetryModel` stayed "unknown" all session.
		expect(source).not.toMatch(/raw\.sessionId \?\? raw\.session\?\.id/);
		expect(source).not.toContain("updateRuntimeIdentityFromEvent");
		expect(source).toContain("readHostModelIdentity(ctx)");
	});

	it("derives model and provider from ctx.model", () => {
		expect(
			readHostModelIdentity({
				model: { id: "claude-sonnet-4-5", provider: "anthropic" },
			}),
		).toEqual({ model: "claude-sonnet-4-5", provider: "anthropic" });
	});

	it("degrades to no identity on a host with no model or a stale ctx", () => {
		expect(readHostModelIdentity({})).toEqual({
			model: undefined,
			provider: undefined,
		});
		expect(readHostModelIdentity(undefined)).toEqual({
			model: undefined,
			provider: undefined,
		});
		// `ctx.model` is a guarded getter: on a replaced runner it throws.
		const stale = {
			get model(): never {
				throw new Error("Extension runtime is no longer active");
			},
		};
		expect(() => readHostModelIdentity(stale)).not.toThrow();
		expect(readHostModelIdentity(stale)).toEqual({});
	});

	it("never re-pins the session id outside session_start's guarded seam", () => {
		const source = fs.readFileSync(path.join(repoRoot, "index.ts"), "utf-8");
		const start = source.indexOf("function updateRuntimeIdentityFromCtx");
		// Guard the guard: a renamed function must fail here, not silently make
		// the assertion below vacuous (defect shape 7).
		expect(start, "updateRuntimeIdentityFromCtx not found").toBeGreaterThan(-1);
		// A concurrent in-process secondary's tool_result must not overwrite the
		// parent's stable session id — `setSessionLifecycle` owns it, behind the
		// #473 guard.
		const body = source.slice(start, source.indexOf("\n}", start));
		expect(body).not.toContain("sessionId");
	});

	it("forwards no vacuous identity fields onto a synthetic tool_result", () => {
		const source = fs.readFileSync(
			path.join(repoRoot, "clients", "runtime-tool-call.ts"),
			"utf-8",
		);
		expect(source).not.toMatch(
			/provider: \(event as \{ provider\?: string \}\)/,
		);
		expect(source).not.toMatch(
			/sessionId: \(event as \{ sessionId\?: string \}\)/,
		);
	});
});

describe("#1655 item 3 — call-time input must not be re-read after handoff", () => {
	it("reports the batch width the call arrived with, not the mutated one", async () => {
		const env = setupTestEnvironment("pi-lens-1655-item3-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/batch.ts",
				"const a = 1;\nconst b = 2;\nconst c = 3;\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			// pi hands the SAME mutable `input` object to every handler in turn,
			// and pi-lens rewrites it in place further down its own handler. Model
			// that with a mutation that lands after the handler has already read
			// the batch once — `ensureLSPConfigInitialized` is awaited early, well
			// before the read-guard verdict that logs the summary.
			const input = {
				path: filePath,
				edits: [
					{ oldText: "const a = 1;", newText: "const a = 9;" },
					{ oldText: "const b = 2;", newText: "const b = 9;" },
					{ oldText: "const c = 3;", newText: "const c = 9;" },
				],
			};

			await handleToolCall(
				baseDeps({
					runtime,
					event: { toolName: "edit", input },
					ctx: { cwd: env.tmpDir },
					ensureLSPConfigInitialized: async () => {
						input.edits.splice(1);
					},
				}),
			);

			const summaries = readGuardLogEntries.filter(
				(entry) => entry.event === "edit_batch_summary",
			);
			expect(summaries.length).toBeGreaterThan(0);
			for (const entry of summaries) {
				const summary = (entry.metadata as { editBatchSummary?: unknown })
					?.editBatchSummary as
					| { requestedIndexes?: number[]; requestedTotal?: number }
					| undefined;
				if (!summary?.requestedIndexes) continue;
				// The indexes were always snapshotted; the totals used to be
				// re-read from the live object, so the two disagreed.
				expect(summary.requestedTotal).toBe(3);
			}
		} finally {
			env.cleanup();
		}
	});
});

describe("#1655 item 4 — the tool cwd basis", () => {
	it("pins that ctx.cwd and the tools' construction cwd are the same host field", () => {
		const session = readHostSource(path.join("core", "agent-session.js"));
		// Tools are built with the session's `_cwd` and frozen there...
		expect(session).toMatch(/createAllToolDefinitions\(this\._cwd/);
		// ...and the very same field is what `ctx.cwd` projects.
		expect(session).toMatch(/new ExtensionRunner\([^)]*this\._cwd/);
		// Assigned once, at construction. If a future host ever reassigns it,
		// this fails and every ctx.cwd-based path resolution needs re-reading.
		const assignments = session.match(/this\._cwd\s*=/g) ?? [];
		expect(assignments.length).toBe(1);

		const runner = readHostSource(path.join("core", "extensions", "runner.js"));
		expect((runner.match(/this\.cwd\s*=/g) ?? []).length).toBe(1);
	});

	it("pins that pi's bash tool takes no cwd argument", () => {
		const bash = readHostSource(path.join("core", "tools", "bash.js"));
		const schema = bash.slice(
			bash.indexOf("const bashSchema"),
			bash.indexOf("bashToolSystemPromptContribution"),
		);
		expect(schema).toContain("command:");
		expect(schema).not.toContain("cwd:");
	});
});

describe("#1655 item 5 — pi's unicode path-variant ladder", () => {
	it("pins the host ladder this mirrors", () => {
		const hostPaths = readHostSource(
			path.join("core", "tools", "path-utils.js"),
		);
		expect(hostPaths).toContain("tryMacOSScreenshotPath");
		expect(hostPaths).toContain("tryNFDVariant");
		expect(hostPaths).toContain("tryCurlyQuoteVariant");
		expect(hostPaths).toContain('"\\u202F"');
		expect(hostPaths).toContain("\\u2019");
	});

	it("tries the host's four variants in the host's order", () => {
		// Composed e-acute so the NFD candidate genuinely differs, a straight
		// quote so the curly one does, and " AM." so the narrow-NBSP one does.
		const naive = "/p/Capture d'écran AM.png";
		const tried: string[] = [];
		const resolution = resolveHostPathVariants(naive, (candidate) => {
			tried.push(candidate);
			return false;
		});
		expect(resolution.unresolved).toBe(true);
		expect(resolution.triedVariants).toEqual([
			"narrow-nbsp",
			"nfd",
			"curly-quote",
			"nfd-curly-quote",
		]);
		expect(tried[0]).toBe(naive);
		expect(tried[1]).toBe("/p/Capture d'écran AM.png");
		expect(tried[2]).toBe(naive.normalize("NFD"));
		expect(tried[3]).toBe("/p/Capture d’écran AM.png");
		expect(tried[4]).toBe(naive.normalize("NFD").replaceAll("'", "’"));
	});

	it("skips a candidate identical to the naive resolve", () => {
		// Pure ASCII, no quote, no AM/PM: every candidate equals the naive
		// resolve, so nothing beyond it is probed.
		const tried: string[] = [];
		const resolution = resolveHostPathVariants("/p/plain.ts", (candidate) => {
			tried.push(candidate);
			return false;
		});
		expect(resolution.triedVariants).toEqual([]);
		expect(tried).toEqual(["/p/plain.ts"]);
		expect(resolution.unresolved).toBe(true);
	});

	it("reports no variant when the naive resolve already exists", () => {
		const resolution = resolveHostPathVariants("/p/plain.ts", () => true);
		expect(resolution).toEqual({
			path: "/p/plain.ts",
			unresolved: false,
			triedVariants: [],
		});
	});

	it("resolves a tool_call whose path pi would only find via a curly quote", async () => {
		const env = setupTestEnvironment("pi-lens-1655-item5-");
		try {
			// The file on disk carries U+2019, exactly as macOS writes it.
			const onDisk = createTempFile(
				env.tmpDir,
				"src/Capture d’ecran.ts",
				"export const shot = 1;\n",
			);
			// The agent types the straight apostrophe. pi's resolveReadPath finds
			// the file; a naive path.resolve does not.
			const typed = path.join(env.tmpDir, "src", "Capture d'ecran.ts");
			expect(fs.existsSync(typed)).toBe(false);

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const recordRead = vi.spyOn(runtime.readGuard, "recordRead");

			await handleToolCall(
				baseDeps({
					runtime,
					event: { toolName: "read", input: { path: typed } },
					ctx: { cwd: env.tmpDir },
				}),
			);

			expect(recordRead).toHaveBeenCalledWith(
				expect.objectContaining({ filePath: onDisk }),
			);
			expect(
				getDegradationSummary().find(
					(entry) => entry.kind === "path-variant-unresolved",
				),
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("records path-variant-unresolved when no variant matches", async () => {
		const env = setupTestEnvironment("pi-lens-1655-item5-miss-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const missing = path.join(env.tmpDir, "src", "gone d'ecran.ts");

			await handleToolCall(
				baseDeps({
					runtime,
					event: { toolName: "read", input: { path: missing } },
					ctx: { cwd: env.tmpDir },
				}),
			);

			const group = getDegradationSummary().find(
				(entry) => entry.kind === "path-variant-unresolved",
			);
			expect(group?.count).toBe(1);
			expect(group?.latestReasons.at(-1)?.reason).toContain("curly-quote");
		} finally {
			env.cleanup();
		}
	});

	it("stays silent for a write to a file that does not exist yet", async () => {
		const env = setupTestEnvironment("pi-lens-1655-item5-write-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			await handleToolCall(
				baseDeps({
					runtime,
					event: {
						toolName: "write",
						input: { path: path.join(env.tmpDir, "src", "new d'ecran.ts") },
					},
					ctx: { cwd: env.tmpDir },
				}),
			);

			expect(
				getDegradationSummary().find(
					(entry) => entry.kind === "path-variant-unresolved",
				),
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});

/**
 * Review round 1 on PR #1680. Three findings, each reproduced before it was
 * fixed. The probes are the reviewer's, not paraphrases of them.
 */
describe("#1655 review F1 — the base resolution pi runs BEFORE the ladder", () => {
	it("pins that pi's read resolver starts from resolveToCwd, not a bare resolve", () => {
		const hostPaths = readHostSource(
			path.join("core", "tools", "path-utils.js"),
		);
		const resolveRead = hostPaths.slice(
			hostPaths.indexOf("export function resolveReadPath("),
		);
		// The FIRST thing resolveReadPath does is resolveToCwd — the ladder only
		// ever runs on what that produced.
		expect(resolveRead.slice(0, resolveRead.indexOf("fileExists"))).toContain(
			"resolveToCwd(filePath, cwd)",
		);
		expect(hostPaths).toContain("normalizeUnicodeSpaces: true");
		expect(hostPaths).toContain("stripAtPrefix: true");

		// ...and those options are honoured by normalizePath, in this order.
		const hostUtils = readHostSource(path.join("utils", "paths.js"));
		expect(hostUtils).toContain(
			"const UNICODE_SPACES = /[\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000]/g",
		);
		expect(hostUtils).toContain('normalized.startsWith("@")');
		expect(hostUtils).toContain("normalizeWindowsShellPath");
		expect(hostUtils).toContain("fileURLToPath(normalized)");
	});

	it("folds pi's unicode space class exactly", () => {
		// Every code point in pi's UNICODE_SPACES, and nothing outside it.
		for (const code of [
			0x00a0, 0x2000, 0x2005, 0x200a, 0x202f, 0x205f, 0x3000,
		]) {
			expect(
				normalizeHostToolPath(`a${String.fromCharCode(code)}b`, {
					normalizeUnicodeSpaces: true,
				}),
			).toBe("a b");
		}
		// Folding is opt-in, exactly as it is in pi.
		expect(normalizeHostToolPath("a\u00a0b")).toBe("a\u00a0b");
	});

	it("strips the @ mention prefix only when asked, and only one", () => {
		expect(normalizeHostToolPath("@src/a.ts", { stripAtPrefix: true })).toBe(
			"src/a.ts",
		);
		expect(normalizeHostToolPath("@@src/a.ts", { stripAtPrefix: true })).toBe(
			"@src/a.ts",
		);
		expect(normalizeHostToolPath("@src/a.ts")).toBe("@src/a.ts");
	});

	it("converts a file:// URL and degrades on a malformed one", () => {
		const target = path.resolve(path.join("some", "dir", "a.ts"));
		expect(normalizeHostToolPath(pathToFileURL(target).href)).toBe(target);
		// pi lets a malformed file: URL throw out of normalizePath. pi-lens is
		// advisory instrumentation on the same event and must not take the
		// handler down over one.
		expect(() => normalizeHostToolPath("file://")).not.toThrow();
	});

	it("resolves a relative path against the cwd and an absolute one on its own", () => {
		const cwd = path.resolve(path.join("base", "dir"));
		expect(resolveHostToolPath("a.ts", cwd)).toBe(path.join(cwd, "a.ts"));
		const absolute = path.resolve(path.join("elsewhere", "b.ts"));
		expect(resolveHostToolPath(absolute, cwd)).toBe(absolute);
	});

	// The reviewer's three probe shapes, each driven end-to-end through the real
	// handler. pi resolves all three; pre-fix pi-lens resolved none of them, and
	// said nothing about any of them.
	const probes: Array<{
		label: string;
		fileName: string;
		typed: (dir: string, resolved: string) => string;
	}> = [
		{
			label: "a non-breaking space where the file has a plain space",
			fileName: "note a.ts",
			// Typed with U+00A0; the file on disk has a plain U+0020.
			typed: (dir) => path.join(dir, "src", "note\u00a0a.ts"),
		},
		{
			label: "an @-prefixed mention path",
			fileName: "at.ts",
			typed: (dir, resolved) => `@${path.relative(dir, resolved)}`,
		},
		{
			label: "a file:// URL",
			fileName: "url.ts",
			typed: (_dir, resolved) => pathToFileURL(resolved).href,
		},
	];

	for (const probe of probes) {
		it(`resolves ${probe.label}`, async () => {
			const env = setupTestEnvironment("pi-lens-1655-f1-");
			try {
				const onDisk = createTempFile(
					env.tmpDir,
					`src/${probe.fileName}`,
					"export const probe = 1;\n",
				);
				const typed = probe.typed(env.tmpDir, onDisk);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				const recordRead = vi.spyOn(runtime.readGuard, "recordRead");

				await handleToolCall(
					baseDeps({
						runtime,
						event: { toolName: "read", input: { path: typed } },
						ctx: { cwd: env.tmpDir },
					}),
				);

				expect(recordRead).toHaveBeenCalledWith(
					expect.objectContaining({ filePath: onDisk }),
				);
				expect(
					getDegradationSummary().find(
						(entry) => entry.kind === "path-variant-unresolved",
					),
				).toBeUndefined();
			} finally {
				env.cleanup();
			}
		});
	}

	it("records the miss even when no variant differed from the resolved path", async () => {
		const env = setupTestEnvironment("pi-lens-1655-f1-silent-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			// Plain ASCII, no quote, no AM/PM: every ladder candidate collapses
			// onto the resolved path, so nothing is "tried". Gating the
			// degradation on that list being non-empty is what made this whole
			// class of miss silent.
			const missing = path.join(env.tmpDir, "src", "gone.ts");

			await handleToolCall(
				baseDeps({
					runtime,
					event: { toolName: "read", input: { path: missing } },
					ctx: { cwd: env.tmpDir },
				}),
			);

			const group = getDegradationSummary().find(
				(entry) => entry.kind === "path-variant-unresolved",
			);
			expect(group?.count).toBe(1);
			expect(group?.latestReasons.at(-1)?.reason).toContain(
				"no variant differed",
			);
		} finally {
			env.cleanup();
		}
	});
});

describe("#1655 review F2 — bookkeeping must not discard a block verdict", () => {
	it("still blocks an unread edit when the attribution cleanup throws", async () => {
		const env = setupTestEnvironment("pi-lens-1655-f2-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/guarded.ts",
				"function foo() {\n\treturn 1;\n}\n",
			);
			const beforeSession = new Date(Date.now() - 1000);
			fs.utimesSync(filePath, beforeSession, beforeSession);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			// #1642's cleanup runs only AFTER the read guard has returned a final
			// block. A throw out of it must not reach the #1655 outer catch, which
			// answers "pi-lens has no opinion" — and would let the edit run.
			const takeToolCallAttribution = vi
				.spyOn(runtime, "takeToolCallAttribution")
				.mockImplementation(() => {
					throw new Error("attribution cache exploded");
				});

			const result = await handleToolCall(
				baseDeps({
					runtime,
					ctx: { cwd: env.tmpDir },
					event: {
						toolName: "edit",
						toolCallId: "call-f2",
						input: {
							path: filePath,
							oldText: "function foo() {\n\treturn 1;\n}",
							newText: "function foo() {\n\treturn 2;\n}",
						},
					},
				}),
			);

			expect(takeToolCallAttribution).toHaveBeenCalled();
			// The verdict survives its own telemetry failing.
			expect(result).toMatchObject({ block: true });
			// ...and the failure is still visible rather than swallowed whole.
			const group = getDegradationSummary().find(
				(entry) => entry.kind === "tool-call-handler-throw",
			);
			expect(group?.latestReasons.at(-1)?.subject).toBe(
				"attribution-cleanup:edit",
			);
		} finally {
			env.cleanup();
		}
	});

	it("still blocks an unread edit when the cleanup succeeds", async () => {
		const env = setupTestEnvironment("pi-lens-1655-f2-ok-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/guarded.ts",
				"function foo() {\n\treturn 1;\n}\n",
			);
			const beforeSession = new Date(Date.now() - 1000);
			fs.utimesSync(filePath, beforeSession, beforeSession);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			const result = await handleToolCall(
				baseDeps({
					runtime,
					ctx: { cwd: env.tmpDir },
					event: {
						toolName: "edit",
						toolCallId: "call-f2-ok",
						input: {
							path: filePath,
							oldText: "function foo() {\n\treturn 1;\n}",
							newText: "function foo() {\n\treturn 2;\n}",
						},
					},
				}),
			);

			expect(result).toMatchObject({ block: true });
			// A blocked call leaves no attribution behind for a tool_result that
			// will never arrive (#1642 F2).
			expect(runtime.takeToolCallAttribution("call-f2-ok")).toBeUndefined();
			expect(
				getDegradationSummary().find(
					(entry) => entry.kind === "tool-call-handler-throw",
				),
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});

describe("#1655 review F3 — the bash-side path source, pinned by use", () => {
	/** Text of every `event.toolName === "bash"` block in a source file. */
	function bashBlocks(source: string): string[] {
		const blocks: string[] = [];
		let from = 0;
		for (;;) {
			const hit = source.indexOf('event.toolName === "bash"', from);
			if (hit === -1) break;
			from = hit + 1;
			const open = source.indexOf("{", source.indexOf(")", hit));
			if (open === -1) continue;
			let depth = 0;
			let index = open;
			for (; index < source.length; index++) {
				if (source[index] === "{") depth++;
				else if (source[index] === "}" && --depth === 0) break;
			}
			blocks.push(source.slice(open, index + 1));
		}
		return blocks;
	}

	/** Control-flow heads that are not calls, however much they look like one. */
	const NOT_CALLS = new Set([
		"if",
		"for",
		"while",
		"switch",
		"catch",
		"return",
		"function",
	]);

	/**
	 * Reduce an argument list to the identifiers this call receives DIRECTLY:
	 * drop string and template literals (prose says "command" too — one of the
	 * bash branch's user-facing warnings does), then drop every nested
	 * `()`/`{}`/`[]` group.
	 */
	function ownArgsOnly(args: string): string {
		let withoutLiterals = "";
		let quote: string | undefined;
		for (let index = 0; index < args.length; index++) {
			const char = args[index];
			if (quote) {
				if (char === "\\") index++;
				else if (char === quote) quote = undefined;
				continue;
			}
			if (char === '"' || char === "'" || char === "`") {
				quote = char;
				continue;
			}
			withoutLiterals += char;
		}

		let depth = 0;
		let kept = "";
		for (const char of withoutLiterals) {
			if (char === "(" || char === "{" || char === "[") depth++;
			else if (char === ")" || char === "}" || char === "]") depth--;
			else if (depth === 0) kept += char;
		}
		return kept;
	}

	/**
	 * Callee names that receive `command` as one of their OWN arguments, at any
	 * position. Nested groups are stripped first, so
	 * `searchReads.push(...extractGrepSearchReadsFromOutput(command, …))`
	 * credits the extractor rather than `push` — only the function the command
	 * string is actually handed to counts as a path source.
	 */
	function calleesTakingCommand(block: string): Set<string> {
		const callees = new Set<string>();
		const callSite = /\b([A-Za-z_$][\w$]*)\s*\(/g;
		let match: RegExpExecArray | null = callSite.exec(block);
		for (; match !== null; match = callSite.exec(block)) {
			if (NOT_CALLS.has(match[1])) continue;
			let depth = 0;
			let index = match.index + match[0].length - 1;
			for (; index < block.length; index++) {
				if (block[index] === "(") depth++;
				else if (block[index] === ")" && --depth === 0) break;
			}
			const args = block.slice(match.index + match[0].length, index);
			if (/\bcommand\b/.test(ownArgsOnly(args))) callees.add(match[1]);
		}
		return callees;
	}

	it("passes the bash command string to nothing but bash-file-access", () => {
		const source = fs.readFileSync(
			path.join(repoRoot, "clients", "runtime-tool-result.ts"),
			"utf-8",
		);
		const blocks = bashBlocks(source);
		// Guard the guard: if bash handling is restructured out of these blocks,
		// fail here rather than silently scanning nothing (shape 7).
		expect(blocks.length).toBeGreaterThanOrEqual(2);

		const callees = new Set<string>();
		for (const block of blocks) {
			for (const callee of calleesTakingCommand(block)) callees.add(callee);
		}
		expect(callees.size).toBeGreaterThan(0);

		// The real invariant, and it is behavioural rather than a naming
		// convention: whatever a new helper is CALLED, handing it the bash
		// command string makes it a second bash-side path source, and it shows up
		// here. Every legitimate consumer lives in bash-file-access.ts.
		// `extractDeletedPathsFromCommand` (#1668) is the fourth legitimate
		// consumer: it proposes rm/git rm/mv-source delete targets from the
		// same bash command string.
		// `isFailedGitIntegrationCommand` (#2060) is the fifth, and the only
		// one that is NOT a path source: it tokenizes the command through
		// bash-file-access's own `tokenizeShellCommand` and returns a boolean
		// recovery policy. It proposes no paths, so it needs no workspaceRoot
		// pin below. Any FUTURE addition here is a path source until proven
		// otherwise — pin it, then justify it in one line like this.
		expect([...callees].sort()).toEqual([
			"extractDeletedPathsFromCommand",
			"extractGrepSearchReadsFromOutput",
			"extractReadPathsFromCommand",
			"extractWrittenPathsFromCommand",
			"isFailedGitIntegrationCommand",
		]);

		// ...and each resolves against the project root, never a ctx.cwd the
		// command's own `cd` may already have left.
		for (const extractor of [
			"extractWrittenPathsFromCommand",
			"extractReadPathsFromCommand",
			"extractGrepSearchReadsFromOutput",
			"extractDeletedPathsFromCommand",
		]) {
			expect(source).toMatch(
				new RegExp(`${extractor}\\([\\s\\S]{0,80}?workspaceRoot`),
			);
		}
	});

	it("keeps the four extractors named consistently (naming pin only)", () => {
		// Deliberately weaker than the test above, and labelled so. This catches
		// a COPY of an extractor under the established name in another module. It
		// cannot catch a differently-named one — that is the use-site test's job,
		// which is exactly why that test exists.
		const clientsDir = path.join(repoRoot, "clients");
		const offenders: string[] = [];
		for (const entry of fs.readdirSync(clientsDir)) {
			if (!entry.endsWith(".ts") || entry === "bash-file-access.ts") continue;
			const text = fs.readFileSync(path.join(clientsDir, entry), "utf-8");
			if (/export function extract\w*(Read|Written|Deleted)Paths/.test(text)) {
				offenders.push(entry);
			}
		}
		expect(offenders).toEqual([]);
	});
});
