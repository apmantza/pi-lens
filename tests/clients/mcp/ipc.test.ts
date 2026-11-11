/**
 * Warm side-channel client: path derivation, the request/response round-trip
 * against a stub server, and graceful "no server → undefined" fallback. Uses a
 * real net.Server stub on the derived endpoint (named pipe on Windows, Unix
 * socket on POSIX) — no real LSP.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { warmAnswerBinding } from "../../../clients/lsp/diagnostic-binding.js";
import type { McpAnalyzeResult } from "../../../clients/mcp/analyze.js";
import {
	boundUnixSocketKeepsIdentity,
	boundUnixSocketPath,
	contentHash,
	createWarmIpcLineReader,
	createWarmIpcRequestQueue,
	diagnosticsIpcPathForCwd,
	ipcPathForCwd,
	readTurnEndStatus,
	recordTurnEndOutcome,
	requestWarmCodeActions,
	requestWarmDiagnostics,
	requestWarmAnalyze,
	requestWarmTurnEnd,
	turnEndStatusPathForCwd,
	unlinkStaleUnixSocket,
	WARM_DIAGNOSTICS_SCHEMA_VERSION,
	WARM_TURN_END_SCHEMA_VERSION,
} from "../../../clients/mcp/ipc.js";
import {
	minTmpRootLength,
	plantStaleUnixSocket,
	removeTempDirSync,
	setupTestEnvironment,
	tmpRootOfLength,
} from "../test-utils.js";

const SENTINEL = {
	filePath: "/x/app.ts",
	cwd: "/x",
	fileKind: "jsts",
	durationMs: 7,
	hasBlockers: false,
	counts: { diagnostics: 0, blockers: 0, warnings: 0, fixed: 0 },
	diagnostics: [],
} as unknown as McpAnalyzeResult;

let activeServer: net.Server | undefined;

afterEach(() => {
	if (activeServer) {
		(
			activeServer as net.Server & { closeAllConnections?: () => void }
		).closeAllConnections?.();
		activeServer.close();
		activeServer = undefined;
	}
});

const SUN_PATH_LIMIT = process.platform === "darwin" ? 104 : 108;
/** A root whose cut drops only `.sock` from `pi-lens-mcp-<16 hex>.sock`. */
const SOCK_ONLY_ROOT = SUN_PATH_LIMIT - "/pi-lens-mcp-".length - 16;
/** A root whose cut ends right after `pi-lens-mcp-99001-`: the pid is kept. */
const PID_KEPT_ROOT = SUN_PATH_LIMIT - "/pi-lens-mcp-99001-".length;
/** A root whose cut removes the hash and every pid: one name for all. */
const SHARED_NAME_ROOT = 100;
// lane: Unit tests (a short CI TMPDIR always has room); a dev box whose
// TMPDIR is too long for the root skips the case.
const lacksRoomFor = (rootBytes: number): boolean =>
	process.platform === "win32" || minTmpRootLength() > rootBytes;

async function withLongSocketTmpdir(
	rootBytes: number,
	body: (cwd: string) => Promise<void>,
): Promise<void> {
	const fixture = setupTestEnvironment("pi-lens-ipc-long-socket-");
	const socketTmpDir = tmpRootOfLength(rootBytes);
	vi.stubEnv("TMPDIR", socketTmpDir);
	try {
		await body(fixture.tmpDir);
	} finally {
		const server = activeServer;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			if (activeServer === server) activeServer = undefined;
		}
		vi.unstubAllEnvs();
		fixture.cleanup();
		removeTempDirSync(socketTmpDir);
	}
}

/** Listen at `bound` and count every connection that reaches it. */
async function countingListener(bound: string): Promise<() => number> {
	let reached = 0;
	activeServer = net.createServer((socket) => {
		reached += 1;
		socket.destroy();
	});
	await new Promise<void>((resolve) => activeServer?.listen(bound, resolve));
	return () => reached;
}

// #3922: records written before failure tracking remain readable and writable.
describe("unrunnable invocation status", () => {
	it("extends a released turn-end record without losing its counters", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-status-"));
		const statusPath = turnEndStatusPathForCwd(cwd);
		try {
			fs.writeFileSync(
				statusPath,
				fs.readFileSync(
					new URL(
						"../../fixtures/mcp/turn-end-status-v1.json",
						import.meta.url,
					),
				),
			);
			expect(readTurnEndStatus(cwd)).toMatchObject({
				ran: 3,
				skipped: 2,
				failed: 0,
			});
			recordTurnEndOutcome(cwd, {
				failed: true,
				operation: "analyze",
				reason: "host peer unavailable",
			});
			recordTurnEndOutcome(cwd, { ran: true });
			recordTurnEndOutcome(cwd, { ran: false, reason: "no-listener" });
			expect(readTurnEndStatus(cwd)).toMatchObject({
				ran: 4,
				skipped: 3,
				failed: 1,
				lastFailureOperation: "analyze",
				lastFailureReason: "host peer unavailable",
				lastFailureAt: expect.any(String),
				lastSkipReason: "no-listener",
			});
		} finally {
			fs.rmSync(statusPath, { force: true });
			removeTempDirSync(cwd);
		}
	});
});

describe("requestWarmDiagnostics", () => {
	// lane: default on Linux and macOS; Windows exercises named pipes.
	it("round-trips a versioned, content-bound response", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-diag-"));
		const pid = 99001;
		activeServer = net.createServer((socket) => {
			socket.setEncoding("utf8");
			socket.once("data", (chunk: string) => {
				const request = JSON.parse(chunk.trim()) as { contentHash: string };
				socket.end(
					`${JSON.stringify({
						result: {
							route: "diagnostics",
							version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
							diagnostics: [],
							contentHash: request.contentHash,
							servedAt: Date.now(),
							fresh: true,
							inconclusive: false,
						},
					})}\n`,
				);
			});
		});
		await new Promise<void>((resolve) =>
			activeServer?.listen(
				boundUnixSocketPath(diagnosticsIpcPathForCwd(cwd, pid)),
				resolve,
			),
		);
		const result = await requestWarmDiagnostics(
			cwd,
			pid,
			"/x/app.ts",
			"const x = 1;",
			1000,
		);
		expect(result.available).toBe(true);
		expect(result.available && result.response.contentHash).toBe(
			contentHash("const x = 1;"),
		);
		removeTempDirSync(cwd);
	});

	it.skipIf(lacksRoomFor(SHARED_NAME_ROOT))(
		"does not dial a pid-scoped name the cut stripped of its pid",
		async () => {
			// Recurrence prevented (#5488 review, F1 probe): the client for one
			// incumbent reached another session's listener at the shared name.
			await withLongSocketTmpdir(SHARED_NAME_ROOT, async (cwd) => {
				const shared = boundUnixSocketPath(
					diagnosticsIpcPathForCwd(cwd, 99001),
				);
				expect(shared).toBe(
					boundUnixSocketPath(diagnosticsIpcPathForCwd(`${cwd}-b`, 99002)),
				);
				const reached = await countingListener(shared);
				await expect(
					requestWarmDiagnostics(cwd, 99001, "/x/app.ts", "x", 1000),
				).resolves.toEqual({ available: false, reason: "no-listener" });
				await expect(
					requestWarmCodeActions(cwd, 99001, "/x/app.ts", "hash", [], 1000),
				).resolves.toEqual({ available: false, reason: "no-listener" });
				expect(reached()).toBe(0);
			});
		},
	);

	it.skipIf(lacksRoomFor(PID_KEPT_ROOT))(
		"round-trips over a long TMPDIR using the bounded Unix socket path",
		async () => {
			await withLongSocketTmpdir(PID_KEPT_ROOT, async (cwd) => {
				const pid = 99001;
				const endpoint = diagnosticsIpcPathForCwd(cwd, pid);
				const boundEndpoint = boundUnixSocketPath(endpoint);
				expect(Buffer.byteLength(endpoint)).toBeGreaterThan(SUN_PATH_LIMIT);
				expect(boundEndpoint).toBe(
					path.join(os.tmpdir(), `pi-lens-mcp-${pid}-`),
				);

				activeServer = net.createServer((socket) => {
					socket.setEncoding("utf8");
					socket.once("data", (chunk: string) => {
						const request = JSON.parse(chunk.trim()) as {
							contentHash: string;
						};
						socket.end(
							`${JSON.stringify({
								result: {
									route: "diagnostics",
									version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
									diagnostics: [],
									contentHash: request.contentHash,
									servedAt: Date.now(),
									fresh: true,
									inconclusive: false,
								},
							})}\n`,
						);
					});
				});
				await new Promise<void>((resolve) =>
					activeServer?.listen(boundEndpoint, resolve),
				);

				const result = await requestWarmDiagnostics(
					cwd,
					pid,
					"/x/app.ts",
					"const x = 1;",
					1000,
				);
				expect(result.available).toBe(true);
				expect(result.available && result.response.contentHash).toBe(
					contentHash("const x = 1;"),
				);
			});
		},
	);

	// #5030 corpus: every diagnostics response shape a released build has put on
	// the socket (`tests/fixtures/warm-attach/`) still parses on the current
	// transport, and `warmAnswerBinding` reads it as that build meant. The
	// pre-#5030 shape has no binding, so it reads as not current: a session on
	// this build attached to an incumbent on an older one withholds the rows
	// instead of reading them as the current bytes. A response shape a released
	// build adds gets a fixture and a row here.
	const WARM_FIXTURES = new URL("../../fixtures/warm-attach/", import.meta.url);
	const READ_AS = {
		"diagnostics-response-pre-5030.json": { boundToCurrentDisk: false },
		"diagnostics-response-5030-stale-bound.json": {
			contentHash:
				"2ad21d5e89849c34021330c42624e67b494ed26f33fca1819704af80434ba91c",
			boundToCurrentDisk: false,
		},
	} as const;
	it.each(Object.keys(READ_AS) as (keyof typeof READ_AS)[])(
		"parses the %s response and reads its binding (#5030)",
		async (name) => {
			const fixture = JSON.parse(
				fs.readFileSync(new URL(name, WARM_FIXTURES), "utf8"),
			) as Record<string, unknown>;
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-corpus-"));
			const pid = 99002;
			activeServer = net.createServer((socket) => {
				socket.setEncoding("utf8");
				socket.once("data", (chunk: string) => {
					const request = JSON.parse(chunk.trim()) as { contentHash: string };
					socket.end(
						`${JSON.stringify({
							result: {
								...fixture,
								contentHash: request.contentHash,
								servedAt: Date.now(),
							},
						})}\n`,
					);
				});
			});
			await new Promise<void>((resolve) =>
				activeServer?.listen(
					boundUnixSocketPath(diagnosticsIpcPathForCwd(cwd, pid)),
					resolve,
				),
			);
			try {
				const result = await requestWarmDiagnostics(
					cwd,
					pid,
					"/x/app.ts",
					"const x = 1;",
					1000,
				);
				expect(result.available).toBe(true);
				if (!result.available) return;
				expect(result.response.diagnostics).toEqual(fixture.diagnostics);
				expect(warmAnswerBinding(result.response)).toEqual(READ_AS[name]);
			} finally {
				removeTempDirSync(cwd);
			}
		},
	);

	// #5030: the compatibility rule for a binding the reader cannot trust, at the
	// one function every reader takes it through. Gates fail closed: only the
	// three known verdicts pass, whatever else arrives reads as not current.
	it.each([
		[undefined, { boundToCurrentDisk: false }],
		[null, { boundToCurrentDisk: false }],
		["true", { boundToCurrentDisk: false }],
		[[], { boundToCurrentDisk: false }],
		[{}, { boundToCurrentDisk: false }],
		[{ boundToCurrentDisk: 1 }, { boundToCurrentDisk: false }],
		[{ boundToCurrentDisk: "yes" }, { boundToCurrentDisk: false }],
		[{ boundToCurrentDisk: true }, { boundToCurrentDisk: true }],
		[{ boundToCurrentDisk: "unknown" }, { boundToCurrentDisk: "unknown" }],
		[
			{ boundToCurrentDisk: false, version: 2, contentHash: 7 },
			{ boundToCurrentDisk: false },
		],
		[
			{ boundToCurrentDisk: true, version: 2, contentHash: "ab" },
			{ boundToCurrentDisk: true, contentHash: "ab" },
		],
	])("reads the wire binding %j as %j (#5030)", (binding, expected) => {
		expect(warmAnswerBinding({ binding })).toEqual(expected);
	});

	// #1108 shape-5 (side-channel copy-loss). `inconclusive` rides the touchFile
	// result as a NON-enumerable side-channel; it CANNOT survive the IPC socket's
	// JSON round-trip on the diagnostics array. warm-attach re-surfaces it as an
	// EXPLICIT enumerable response field precisely so the flag crosses the boundary
	// intact — this guards that the client consumer still HONORS it (an inconclusive
	// answer is not a confirmed clean, #571/#1093). Fail-then-pass: drop the
	// `result.inconclusive` disqualifier in ipc.ts and this passes an inconclusive
	// answer through as available.
	it("rejects an inconclusive answer carried as an enumerable IPC field", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-inconc-"));
		const pid = 99011;
		activeServer = net.createServer((socket) => {
			socket.setEncoding("utf8");
			socket.once("data", (chunk: string) => {
				const request = JSON.parse(chunk.trim()) as { contentHash: string };
				socket.end(
					`${JSON.stringify({
						result: {
							route: "diagnostics",
							version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
							diagnostics: [],
							contentHash: request.contentHash,
							servedAt: Date.now(),
							fresh: true,
							inconclusive: true,
						},
					})}\n`,
				);
			});
		});
		await new Promise<void>((resolve) =>
			activeServer?.listen(
				boundUnixSocketPath(diagnosticsIpcPathForCwd(cwd, pid)),
				resolve,
			),
		);
		await expect(
			requestWarmDiagnostics(cwd, pid, "/x/app.ts", "const x = 1;", 1000),
		).resolves.toEqual({ available: false, reason: "stale-answer" });
		removeTempDirSync(cwd);
	});

	it("rejects schema skew and fails open on errors", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-skew-"));
		const pid = 99002;
		activeServer = net.createServer((socket) => {
			socket.once("data", () =>
				socket.end(
					`${JSON.stringify({
						result: {
							route: "diagnostics",
							version: WARM_DIAGNOSTICS_SCHEMA_VERSION + 1,
						},
					})}\n`,
				),
			);
		});
		await new Promise<void>((resolve) =>
			activeServer?.listen(
				boundUnixSocketPath(diagnosticsIpcPathForCwd(cwd, pid)),
				resolve,
			),
		);
		await expect(
			requestWarmDiagnostics(cwd, pid, "/x/app.ts", "x", 1000),
		).resolves.toEqual({ available: false, reason: "schema-mismatch" });
		removeTempDirSync(cwd);
	});

	it("fails open when the incumbent misses the deadline", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-timeout-"));
		const pid = 99003;
		activeServer = net.createServer(() => {
			// Deliberately leave the request unanswered.
		});
		await new Promise<void>((resolve) =>
			activeServer?.listen(
				boundUnixSocketPath(diagnosticsIpcPathForCwd(cwd, pid)),
				resolve,
			),
		);
		await expect(
			requestWarmDiagnostics(cwd, pid, "/x/app.ts", "x", 20),
		).resolves.toEqual({ available: false, reason: "timeout" });
		removeTempDirSync(cwd);
	});
});

describe("requestWarmCodeActions", () => {
	it("round-trips versioned code actions bound to the diagnostics hash", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-actions-"));
		const pid = 99004;
		const expectedHash = contentHash("const x = 1;");
		activeServer = net.createServer((socket) => {
			socket.setEncoding("utf8");
			socket.once("data", (chunk: string) => {
				const request = JSON.parse(chunk.trim()) as {
					route: string;
					contentHash: string;
					ranges: unknown[];
				};
				expect(request.route).toBe("code-actions");
				expect(request.ranges).toHaveLength(1);
				socket.end(
					`${JSON.stringify({
						result: {
							route: "code-actions",
							version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
							contentHash: request.contentHash,
							servedAt: Date.now(),
							actions: [[{ title: "Fix it", kind: "quickfix" }]],
						},
					})}\n`,
				);
			});
		});
		await new Promise<void>((resolve) =>
			activeServer?.listen(
				boundUnixSocketPath(diagnosticsIpcPathForCwd(cwd, pid)),
				resolve,
			),
		);
		const result = await requestWarmCodeActions(
			cwd,
			pid,
			"/x/app.ts",
			expectedHash,
			[
				{
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			],
			1000,
		);
		expect(result.available).toBe(true);
		expect(result.available && result.response.actions[0]?.[0]?.title).toBe(
			"Fix it",
		);
		removeTempDirSync(cwd);
	});

	it("rejects code-action schema skew", async () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ipc-actions-skew-"),
		);
		const pid = 99005;
		activeServer = net.createServer((socket) => {
			socket.once("data", () =>
				socket.end(
					`${JSON.stringify({
						result: {
							route: "code-actions",
							version: WARM_DIAGNOSTICS_SCHEMA_VERSION + 1,
							actions: [],
						},
					})}\n`,
				),
			);
		});
		await new Promise<void>((resolve) =>
			activeServer?.listen(
				boundUnixSocketPath(diagnosticsIpcPathForCwd(cwd, pid)),
				resolve,
			),
		);
		await expect(
			requestWarmCodeActions(cwd, pid, "/x/app.ts", "hash", [], 1000),
		).resolves.toEqual({ available: false, reason: "schema-mismatch" });
		removeTempDirSync(cwd);
	});
});

describe("ipcPathForCwd", () => {
	it("is stable for the same cwd and differs across cwds", () => {
		expect(ipcPathForCwd("/a/b")).toBe(ipcPathForCwd("/a/b"));
		expect(ipcPathForCwd("/a/b")).not.toBe(ipcPathForCwd("/a/c"));
	});

	it("uses the platform-appropriate endpoint form", () => {
		const p = ipcPathForCwd(process.cwd());
		if (process.platform === "win32") {
			expect(p.startsWith("\\\\.\\pipe\\pi-lens-mcp-")).toBe(true);
		} else {
			expect(p.endsWith(".sock")).toBe(true);
		}
	});
});

describe("boundUnixSocketPath (#4353)", () => {
	// Recurrence prevented: cleanup or a network operation used a different
	// spelling from the explicitly bounded socket name, leaving a stale socket
	// behind or making the listener unavailable under a long TMPDIR.
	const long = `/${"a".repeat(120)}/pi-lens-mcp-0123456789abcdef.sock`;

	it("cuts a Linux path to the 108 bytes sun_path holds", () => {
		const bound = boundUnixSocketPath(long, "linux");
		expect(Buffer.byteLength(bound)).toBe(108);
		expect(long.startsWith(bound)).toBe(true);
	});

	it("cuts a darwin path to 104 bytes", () => {
		expect(Buffer.byteLength(boundUnixSocketPath(long, "darwin"))).toBe(104);
	});

	it("leaves a path that fits, and every Windows pipe, unchanged", () => {
		const short = "/tmp/pi-lens-mcp-0123456789abcdef.sock";
		expect(boundUnixSocketPath(short, "linux")).toBe(short);
		expect(boundUnixSocketPath(long, "win32")).toBe(long);
	});
});

describe("boundUnixSocketKeepsIdentity (#5488 review, F1)", () => {
	// Recurrence prevented: a cut into the workspace hash gave every workspace
	// one bound name, and a second server unlinked the first one's live socket
	// and answered its hook requests.
	const workspaceName = "pi-lens-mcp-0123456789abcdef.sock";
	const pidName = "pi-lens-mcp-4242-diagnostics-0123456789abcdef.sock";
	const under = (rootBytes: number, name: string): string =>
		`/${"r".repeat(rootBytes - 1)}/${name}`;

	it.each<[string, number, boolean]>([
		["fits", 60, true],
		["loses only .sock", 76, true],
		["ends right after the hash", 79, true],
		["cuts the hash's last character", 80, false],
		["cuts into the name prefix", 100, false],
	])(
		"a workspace endpoint whose cut %s (root %i) keeps its identity: %s",
		(_case, rootBytes, keeps) => {
			expect(
				boundUnixSocketKeepsIdentity(under(rootBytes, workspaceName), {
					platform: "linux",
				}),
			).toBe(keeps);
		},
	);

	it.each<[number, boolean]>([
		[90, true],
		[91, false],
	])(
		"a pid-scoped endpoint under root %i keeps its pid marker: %s",
		(rootBytes, keeps) => {
			// `pi-lens-mcp-4242-` is 17 bytes, so a root of 90 ends the cut on the dash.
			expect(
				boundUnixSocketKeepsIdentity(under(rootBytes, pidName), {
					ownerPid: 4242,
					platform: "linux",
				}),
			).toBe(keeps);
		},
	);

	it("reads the token from the file name, not from a directory that repeats it", () => {
		const decoy = `/${"r".repeat(50)}/pi-lens-mcp-0123456789abcdef/${"s".repeat(30)}/${workspaceName}`;
		expect(Buffer.byteLength(decoy)).toBeGreaterThan(108);
		expect(boundUnixSocketKeepsIdentity(decoy, { platform: "linux" })).toBe(
			false,
		);
	});

	it("uses the darwin limit and treats every Windows pipe as its own", () => {
		expect(
			boundUnixSocketKeepsIdentity(under(76, workspaceName), {
				platform: "darwin",
			}),
		).toBe(false);
		expect(
			boundUnixSocketKeepsIdentity(under(200, workspaceName), {
				platform: "win32",
			}),
		).toBe(true);
		// A pid-scoped pipe puts the pid last, so it is no token prefix: a pipe
		// is never cut, and that alone keeps it.
		expect(
			boundUnixSocketKeepsIdentity(
				diagnosticsIpcPathForCwd("C:\\work", 4242, "win32"),
				{ ownerPid: 4242, platform: "win32" },
			),
		).toBe(true);
	});
});

describe("pid-scoped endpoint survives the sun_path cut (#4376 review r1, F1)", () => {
	// Recurrence prevented: the pid sat after the hash, so from TMPDIR 66 the cut
	// removed it and every session in a workspace bound one name.
	const PID = 4_194_303;
	const withRoot = (bytes: number, body: () => void): void => {
		vi.stubEnv("TMPDIR", `/${"r".repeat(bytes - 1)}`);
		try {
			body();
		} finally {
			vi.unstubAllEnvs();
		}
	};

	it.each([52, 66, 75, 80, 87])(
		"keeps a 7-digit pid in the bound name at TMPDIR %i",
		(bytes) => {
			withRoot(bytes, () => {
				const bound = boundUnixSocketPath(
					diagnosticsIpcPathForCwd("/work/space", PID, "linux"),
				);
				expect(bound).toContain(`pi-lens-mcp-${PID}-`);
			});
		},
	);

	it("tells two pids apart in the bound name", () => {
		withRoot(75, () => {
			const bound = (pid: number): string =>
				boundUnixSocketPath(
					diagnosticsIpcPathForCwd("/work/space", pid, "linux"),
				);
			expect(bound(PID)).not.toBe(bound(PID - 1));
		});
	});
});

describe.skipIf(process.platform === "win32")(
	"unlinkStaleUnixSocket (#4376 review r1, F2)",
	() => {
		// Recurrence prevented: the stale unlink deleted whatever file the
		// truncated path named, a user's regular file included.
		const make = (): { root: string; endpoint: string; bound: string } => {
			const { tmpDir } = setupTestEnvironment("pi-lens-ss-");
			const root =
				tmpDir.length >= 100
					? tmpDir
					: path.join(tmpDir, "p".repeat(100 - tmpDir.length - 1));
			fs.mkdirSync(root, { recursive: true });
			const endpoint = path.join(root, "pi-lens-mcp-0123456789abcdef.sock");
			return { root, endpoint, bound: boundUnixSocketPath(endpoint) };
		};

		it("unlinks a stale socket at the bound name", async () => {
			const { endpoint, bound } = make();
			await plantStaleUnixSocket(bound);
			expect(unlinkStaleUnixSocket(endpoint)).toBe("unlinked");
			expect(fs.existsSync(bound)).toBe(false);
		});

		it("keeps a regular file at the bound name", () => {
			const { endpoint, bound } = make();
			fs.writeFileSync(bound, "user data");
			expect(unlinkStaleUnixSocket(endpoint)).toBe("not-a-socket");
			expect(fs.readFileSync(bound, "utf8")).toBe("user data");
		});

		it("reports an absent file", () => {
			expect(unlinkStaleUnixSocket(make().endpoint)).toBe("absent");
		});

		it("refuses a truncated name that lost the owner's pid", async () => {
			// Recurrence prevented (F1): a name shared by every session cannot be
			// cleared by one of them without replacing a live listener. The cut
			// lands inside the file name, so the pid marker is not in the bound
			// name whatever the root length.
			const { root } = make();
			const shared = path.join(
				root,
				"pi-lens-mcp-0123456789abcdef-diagnostics-4242.sock",
			);
			const bound = boundUnixSocketPath(shared);
			await plantStaleUnixSocket(bound);
			expect(unlinkStaleUnixSocket(shared, { ownerPid: 4242 })).toBe(
				"shared-name",
			);
			expect(fs.existsSync(bound)).toBe(true);
		});
	},
);

// --- #3255: the case axis of the workspace rendezvous id --------------------
//
// Recurrence these cases prevent: `workspaceHash` lowercased its input
// UNCONDITIONALLY, so on a case-sensitive host `/repo/Alpha` and `/repo/alpha`
// — two different directories — derived ONE warm-IPC socket, one pid-scoped
// diagnostics socket and one `pi-lens-turn-end-<hash>.json`. A PostToolUse or
// Stop hook in one workspace then reached the other workspace's warm server
// and its turn-end counters. The fold must survive on the platforms whose
// filesystem folds case (win32, darwin), where the two spellings are ONE
// directory and the server's `--cwd=` spelling can legitimately differ from
// the hook payload's.

/** The 16 hex characters every per-workspace name embeds. */
function workspaceIdIn(derivedPath: string): string {
	const found =
		/(?:pi-lens-(?:mcp|turn-end)-|-diagnostics-)([0-9a-f]{16})/.exec(
			derivedPath,
		);
	if (!found) throw new Error(`no workspace id in ${derivedPath}`);
	return found[1];
}

/**
 * MEASURED, not asserted: create one directory and ask the filesystem whether
 * the other spelling already exists. The sibling fixture in the cases below is
 * created only after this says the host really keeps the two apart, so the
 * skip can never be an `EEXIST` waiting to happen on someone's APFS box.
 */
const TMPDIR_IS_CASE_SENSITIVE = (() => {
	const probe = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-Case-"));
	try {
		return !fs.existsSync(
			probe.replace("pi-lens-ipc-Case-", "pi-lens-ipc-case-"),
		);
	} finally {
		removeTempDirSync(probe);
	}
})();

/** Sibling of `dir` differing ONLY in the case of the fixture prefix. */
function caseVariantSibling(dir: string, prefix: string): string {
	const sibling = dir.replace(prefix, prefix.toLowerCase());
	expect(sibling).not.toBe(dir);
	fs.mkdirSync(sibling);
	return sibling;
}

// lane: Unit tests (ubuntu) — and any other case-sensitive host. Skipped on a
// case-insensitive filesystem because there the two spellings ARE one
// directory, so there is no second workspace to keep apart.
describe.skipIf(!TMPDIR_IS_CASE_SENSITIVE)(
	"case-distinct workspaces on a case-sensitive host (#3255)",
	() => {
		it("does not serve one workspace's warm analysis to its case-variant sibling", async () => {
			const served = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-ipc-Leak-"),
			);
			const sibling = caseVariantSibling(served, "pi-lens-ipc-Leak-");
			try {
				await listenOnWorkspaceEndpoint(served, (socket) => {
					socket.setEncoding("utf8");
					socket.once("data", () =>
						socket.end(`${JSON.stringify({ result: SENTINEL })}\n`),
					);
				});

				// Control: the stub really is reachable from the workspace it serves.
				await expect(
					requestWarmAnalyze(served, "/x/app.ts", 2000),
				).resolves.toEqual(SENTINEL);

				// The defect: the sibling workspace must NOT reach that server. Cold
				// fallback (`undefined`) is the correct answer for a workspace with no
				// warm server of its own.
				await expect(
					requestWarmAnalyze(sibling, "/x/app.ts", 2000),
				).resolves.toBeUndefined();
			} finally {
				removeTempDirSync(sibling);
				removeTempDirSync(served);
			}
		});

		it("does not merge two case-variant workspaces into one turn-end status file", () => {
			const recorded = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-ipc-Turnstat-"),
			);
			const sibling = caseVariantSibling(recorded, "pi-lens-ipc-Turnstat-");
			try {
				recordTurnEndOutcome(recorded, { ran: true });

				// Control: the writer's own workspace reads its own counters back.
				expect(readTurnEndStatus(recorded)).toMatchObject({ ran: 1 });

				// The defect: `pilens_health` for the sibling reported the other
				// workspace's turn-end activity under its own name.
				expect(readTurnEndStatus(sibling)).toBeUndefined();
			} finally {
				fs.rmSync(turnEndStatusPathForCwd(recorded), { force: true });
				fs.rmSync(turnEndStatusPathForCwd(sibling), { force: true });
				removeTempDirSync(sibling);
				removeTempDirSync(recorded);
			}
		});
	},
);

// Platform is an injected ARGUMENT (the seam `normalizePathEntry` uses in
// clients/lsp/launch.ts), so every arm below runs on every lane — no
// `skipIf(process.platform …)` and no Windows-only assertion.
describe("workspace id under an injected platform (#3255)", () => {
	const ALPHA = "/repo/Alpha";
	const LOWER = "/repo/alpha";

	// Case-INSENSITIVE by default: the two spellings name one directory, so
	// folding is what makes the server and the hook meet.
	it.each<NodeJS.Platform>(["win32", "darwin"])(
		"folds case on %s, where the filesystem folds it",
		(platform) => {
			expect(ipcPathForCwd(ALPHA, platform)).toBe(
				ipcPathForCwd(LOWER, platform),
			);
			expect(turnEndStatusPathForCwd(ALPHA, platform)).toBe(
				turnEndStatusPathForCwd(LOWER, platform),
			);
			expect(diagnosticsIpcPathForCwd(ALPHA, 4242, platform)).toBe(
				diagnosticsIpcPathForCwd(LOWER, 4242, platform),
			);
		},
	);

	// Case-SENSITIVE: two spellings are two directories and must not collide.
	it.each<NodeJS.Platform>(["linux", "freebsd"])(
		"keeps case on %s, where the filesystem keeps it",
		(platform) => {
			expect(ipcPathForCwd(ALPHA, platform)).not.toBe(
				ipcPathForCwd(LOWER, platform),
			);
			expect(turnEndStatusPathForCwd(ALPHA, platform)).not.toBe(
				turnEndStatusPathForCwd(LOWER, platform),
			);
			expect(diagnosticsIpcPathForCwd(ALPHA, 4242, platform)).not.toBe(
				diagnosticsIpcPathForCwd(LOWER, 4242, platform),
			);
		},
	);

	// The four derivation sites of the table in PR #3257 / the `workspaceHash`
	// doc comment: every per-workspace name must carry the SAME id, or a future
	// edit to one of them splits the rendezvous silently.
	it.each<NodeJS.Platform>(["win32", "darwin", "linux"])(
		"gives every per-workspace name the same id on %s",
		(platform) => {
			const ids = [
				workspaceIdIn(ipcPathForCwd(ALPHA, platform)),
				workspaceIdIn(diagnosticsIpcPathForCwd(ALPHA, 4242, platform)),
				workspaceIdIn(turnEndStatusPathForCwd(ALPHA, platform)),
			];
			expect(new Set(ids).size).toBe(1);
		},
	);

	it.each<[NodeJS.Platform, boolean]>([
		["win32", true],
		["linux", false],
		["darwin", false],
	])(
		"uses the %s endpoint form for the injected platform",
		(platform, pipe) => {
			const endpoint = ipcPathForCwd(ALPHA, platform);
			expect(endpoint.startsWith("\\\\.\\pipe\\pi-lens-mcp-")).toBe(pipe);
			expect(endpoint.endsWith(".sock")).toBe(!pipe);
			expect(
				diagnosticsIpcPathForCwd(ALPHA, 4242, platform).endsWith(
					pipe
						? "-diagnostics-4242"
						: `-diagnostics-${workspaceIdIn(endpoint)}.sock`,
				),
			).toBe(true);
		},
	);
});

/**
 * Property (#4928): the workspace id over arbitrary absolute cwds and spellings.
 *
 * Recurrence this prevents: the hook and the server missing each other, or two
 * workspaces meeting. Every row of `workspaceHash`'s table is a separate
 * process that must derive the same id from the cwd it was handed, and
 * `/work/./app`, `/work/app/` and `/work/x/../app` name one directory. A split
 * is silent: the hook finds no listener and falls back to the cold path. A
 * merge is the #3255 shape, one socket and one turn-end file for two
 * workspaces. #3255 pinned the case fold for one pair of names; this states it
 * for any cwd.
 *
 * Properties: every spelling of a directory gets one id, on every platform
 * and from all three derivations; two directories get two ids, except that
 * win32 and darwin fold case, where they get two only if they differ beyond case.
 * The second directory is a case variant of the first (optionally one segment
 * longer) or an unrelated one. Drawn independently, it never folds equal to the
 * first, so the case-fold arm would never run and the relation would be dead.
 *
 * numRuns 300, seed 492805.
 *
 * Not modelled: Windows path syntax (`path.resolve` is the host's, so drive
 * letters and backslashes are not drawn), symlinks (the id is lexical on
 * purpose, #1193 P3), and a 16-hex collision (2^-64 per pair).
 */
describe("workspace id property (#4928)", () => {
	const segmentArb = fc.string({
		unit: fc.constantFrom(..."abcAB09_-".split("")),
		minLength: 1,
		maxLength: 4,
	});
	const segmentsArb = fc.array(segmentArb, { minLength: 1, maxLength: 5 });
	const platformArb = fc.constantFrom<NodeJS.Platform>(
		"linux",
		"darwin",
		"win32",
	);
	const swapCase = (ch: string): string =>
		ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
	// A pair of directories: the second is a case variant of the first (each
	// segment swapped or kept, optionally one segment longer) or unrelated.
	const pairArb = segmentsArb.chain((segments) =>
		fc.tuple(
			fc.constant(segments),
			fc.oneof(
				fc
					.tuple(
						fc.array(fc.boolean(), {
							minLength: segments.length,
							maxLength: segments.length,
						}),
						fc.option(segmentArb, { nil: undefined }),
					)
					.map(([flips, extra]) => [
						...segments.map((segment, i) =>
							flips[i] ? [...segment].map(swapCase).join("") : segment,
						),
						...(extra === undefined ? [] : [extra]),
					]),
				segmentsArb,
			),
		),
	);

	it("gives every spelling of a directory one id and two directories two", () => {
		const idsOf = (cwd: string, platform: NodeJS.Platform): string[] => [
			workspaceIdIn(ipcPathForCwd(cwd, platform)),
			workspaceIdIn(diagnosticsIpcPathForCwd(cwd, 4242, platform)),
			workspaceIdIn(turnEndStatusPathForCwd(cwd, platform)),
		];
		fc.assert(
			fc.property(
				platformArb,
				pairArb,
				segmentArb,
				fc.nat(),
				fc.constantFrom("", "/", "//", "/."),
				(platform, [segments, otherSegments], detour, at, tail) => {
					const plain = `/${segments.join("/")}`;
					const detoured = segments.slice();
					detoured.splice(at % (segments.length + 1), 0, detour, "..");
					const spellings = [
						plain + tail,
						`/${detoured.join("/")}`,
						`/./${segments.join("//")}`,
					];
					const [id] = idsOf(plain, platform);
					for (const spelling of spellings) {
						expect(idsOf(spelling, platform), spelling).toEqual([id, id, id]);
					}

					const fold = (s: string[]): string =>
						platform === "linux" ? s.join("/") : s.join("/").toLowerCase();
					const [otherId] = idsOf(`/${otherSegments.join("/")}`, platform);
					expect(
						otherId === id,
						`${plain} against /${otherSegments.join("/")}`,
					).toBe(fold(segments) === fold(otherSegments));
				},
			),
			{ numRuns: 300, seed: 492805 },
		);
	});
});

describe("requestWarmAnalyze", () => {
	// lane: default on Linux and macOS; Windows exercises named pipes.
	it("round-trips the request and returns the server's result", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-"));
		const endpoint = ipcPathForCwd(cwd);
		if (process.platform !== "win32") {
			try {
				fs.unlinkSync(endpoint);
			} catch {
				/* none */
			}
		}

		let received: unknown;
		activeServer = net.createServer((socket) => {
			socket.setEncoding("utf8");
			let buffer = "";
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				const nl = buffer.indexOf("\n");
				if (nl === -1) return;
				received = JSON.parse(buffer.slice(0, nl));
				socket.end(`${JSON.stringify({ result: SENTINEL })}\n`);
			});
		});
		await new Promise<void>((resolve) =>
			activeServer?.listen(boundUnixSocketPath(endpoint), resolve),
		);

		const result = await requestWarmAnalyze(cwd, "/x/app.ts");
		expect(result).toEqual(SENTINEL);
		expect(received).toEqual({ file: "/x/app.ts", cwd });

		removeTempDirSync(cwd);
	});

	it.skipIf(lacksRoomFor(SHARED_NAME_ROOT))(
		"does not dial a workspace name the cut stripped of its hash",
		async () => {
			// Recurrence prevented (#5488 review, F1): a hook in one workspace was
			// answered by another workspace's server at the shared name.
			await withLongSocketTmpdir(SHARED_NAME_ROOT, async (cwd) => {
				const shared = boundUnixSocketPath(ipcPathForCwd(cwd));
				expect(shared).toBe(boundUnixSocketPath(ipcPathForCwd(`${cwd}-b`)));
				const reached = await countingListener(shared);
				expect(
					await requestWarmAnalyze(cwd, "/x/app.ts", 1000),
				).toBeUndefined();
				expect(reached()).toBe(0);
			});
		},
	);

	it.skipIf(lacksRoomFor(SOCK_ONLY_ROOT))(
		"round-trips over a long TMPDIR using the bounded Unix socket path",
		async () => {
			await withLongSocketTmpdir(SOCK_ONLY_ROOT, async (cwd) => {
				const endpoint = ipcPathForCwd(cwd);
				const boundEndpoint = boundUnixSocketPath(endpoint);
				expect(Buffer.byteLength(endpoint)).toBeGreaterThan(SUN_PATH_LIMIT);
				expect(boundEndpoint).toBe(endpoint.slice(0, -".sock".length));

				let received: unknown;
				activeServer = net.createServer((socket) => {
					socket.setEncoding("utf8");
					let buffer = "";
					socket.on("data", (chunk: string) => {
						buffer += chunk;
						const nl = buffer.indexOf("\n");
						if (nl === -1) return;
						received = JSON.parse(buffer.slice(0, nl));
						socket.end(`${JSON.stringify({ result: SENTINEL })}\n`);
					});
				});
				await new Promise<void>((resolve) =>
					activeServer?.listen(boundEndpoint, resolve),
				);

				const result = await requestWarmAnalyze(cwd, "/x/app.ts");
				expect(result).toEqual(SENTINEL);
				expect(received).toEqual({ file: "/x/app.ts", cwd });
			});
		},
	);

	it("resolves undefined when no server is listening (cold fallback)", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-none-"));
		const result = await requestWarmAnalyze(cwd, "/x/app.ts", 2000);
		expect(result).toBeUndefined();
		removeTempDirSync(cwd);
	});

	it("resolves undefined when the server returns an error", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-err-"));
		const endpoint = ipcPathForCwd(cwd);
		if (process.platform !== "win32") {
			try {
				fs.unlinkSync(endpoint);
			} catch {
				/* none */
			}
		}
		activeServer = net.createServer((socket) => {
			socket.on("data", () =>
				socket.end(`${JSON.stringify({ error: "boom" })}\n`),
			);
		});
		await new Promise<void>((resolve) =>
			activeServer?.listen(boundUnixSocketPath(endpoint), resolve),
		);

		const result = await requestWarmAnalyze(cwd, "/x/app.ts");
		expect(result).toBeUndefined();
		removeTempDirSync(cwd);
	});
});

function listenOnWorkspaceEndpoint(
	cwd: string,
	handler: (socket: net.Socket) => void,
): Promise<string> {
	const endpoint = ipcPathForCwd(cwd);
	if (process.platform !== "win32") {
		try {
			fs.unlinkSync(endpoint);
		} catch {
			/* none */
		}
	}
	activeServer = net.createServer(handler);
	return new Promise<string>((resolve) =>
		activeServer?.listen(boundUnixSocketPath(endpoint), () =>
			resolve(endpoint),
		),
	);
}

describe("requestWarmTurnEnd", () => {
	it("round-trips a versioned turn-end response over the workspace endpoint", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-turn-"));
		let received: unknown;
		let connections = 0;
		await listenOnWorkspaceEndpoint(cwd, (socket) => {
			connections++;
			socket.setEncoding("utf8");
			socket.once("data", (chunk: string) => {
				const request = JSON.parse(chunk.trim()) as { route?: string };
				if (connections === 1) {
					received = request;
					socket.end(
						`${JSON.stringify({
							result: {
								route: "turn-end",
								version: WARM_TURN_END_SCHEMA_VERSION,
								turnEnd: "TURN ADVISORY",
								tests: "TESTS FAILED",
								deliveryId: "delivery-1",
							},
						})}\n`,
					);
				} else {
					expect(request).toMatchObject({
						route: "turn-end-ack",
						deliveryId: "delivery-1",
					});
					socket.end(
						`${JSON.stringify({
							result: {
								route: "turn-end-ack",
								version: WARM_TURN_END_SCHEMA_VERSION,
								acknowledged: true,
							},
						})}\n`,
					);
				}
			});
		});

		const result = await requestWarmTurnEnd(cwd, 2000);
		expect(result.available).toBe(true);
		expect(result.available && result.response.turnEnd).toBe("TURN ADVISORY");
		expect(received).toEqual({
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			cwd,
		});
		removeTempDirSync(cwd);
	});

	it("does not report delivery success when the receipt acknowledgement times out (#1218)", async () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ipc-turn-ack-timeout-"),
		);
		let connections = 0;
		await listenOnWorkspaceEndpoint(cwd, (socket) => {
			connections++;
			socket.setEncoding("utf8");
			socket.once("data", () => {
				if (connections === 1) {
					socket.end(
						`${JSON.stringify({
							result: {
								route: "turn-end",
								version: WARM_TURN_END_SCHEMA_VERSION,
								turnEnd: "DURABLE FINDING",
								deliveryId: "delivery-timeout",
							},
						})}\n`,
					);
				}
				// Never answer the acknowledgement connection: the client deadline
				// must report timeout while the server retains its delivery.
			});
		});
		await expect(requestWarmTurnEnd(cwd, 20)).resolves.toEqual({
			available: false,
			reason: "timeout",
		});
		removeTempDirSync(cwd);
	});

	it.skipIf(lacksRoomFor(SHARED_NAME_ROOT))(
		"does not dial a workspace name the cut stripped of its hash",
		async () => {
			// Recurrence prevented (#5488 review, F1): another workspace's server
			// at the shared name would run its turn-end pass for this hook.
			await withLongSocketTmpdir(SHARED_NAME_ROOT, async (cwd) => {
				const reached = await countingListener(
					boundUnixSocketPath(ipcPathForCwd(cwd)),
				);
				await expect(requestWarmTurnEnd(cwd, 1000)).resolves.toEqual({
					available: false,
					reason: "no-listener",
				});
				expect(reached()).toBe(0);
			});
		},
	);

	// #3255 H1: "nothing is listening" is its OWN reason. It used to arrive as
	// `ipc-error`, indistinguishable from the answering-but-broken server two
	// cases below — and after the case-fold narrowing it is also what an
	// upgrade-stranded server looks like, which needs a different remedy.
	it("reports no-listener when no warm server is listening", async () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ipc-turn-none-"),
		);
		await expect(requestWarmTurnEnd(cwd, 2000)).resolves.toEqual({
			available: false,
			reason: "no-listener",
		});
		removeTempDirSync(cwd);
	});

	// Old server + new client: the tagged request is blind-cast to an analyze
	// request, `analyzeFile(undefined, …)` throws, and the reply is `{error}`.
	// The bin must read that as "no usable warm server", not as a clean turn.
	it("degrades to ipc-error against a server that predates the route", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-turn-old-"));
		await listenOnWorkspaceEndpoint(cwd, (socket) => {
			socket.on("data", () =>
				socket.end(`${JSON.stringify({ error: "boom" })}\n`),
			);
		});
		await expect(requestWarmTurnEnd(cwd, 2000)).resolves.toEqual({
			available: false,
			reason: "ipc-error",
		});
		removeTempDirSync(cwd);
	});

	it("rejects turn-end schema skew", async () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ipc-turn-skew-"),
		);
		await listenOnWorkspaceEndpoint(cwd, (socket) => {
			socket.once("data", () =>
				socket.end(
					`${JSON.stringify({
						result: {
							route: "turn-end",
							version: WARM_TURN_END_SCHEMA_VERSION + 1,
						},
					})}\n`,
				),
			);
		});
		await expect(requestWarmTurnEnd(cwd, 2000)).resolves.toEqual({
			available: false,
			reason: "schema-mismatch",
		});
		removeTempDirSync(cwd);
	});
});

describe("createWarmIpcLineReader", () => {
	it("dispatches exactly one line for one request followed by stray bytes (#1219)", () => {
		const lines: string[] = [];
		const handler = createWarmIpcLineReader((line) => lines.push(line), {
			// #3383 made the reader's label required: it is the ledger subject for
			// an over-long line, so no reader can record under a generic name.
			label: "mcp-warm-server",
		});
		handler(`${JSON.stringify({ file: "/x/a.ts" })}\n`);
		// Pre-fix, the socket handler kept the consumed line in its buffer and
		// re-dispatched it on any further data event — stray bytes after the
		// request re-ran the whole warm analyze pass.
		handler("stray");
		handler("more");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({ file: "/x/a.ts" });
	});

	it("ignores a second newline-terminated request (one-shot per connection)", () => {
		const lines: string[] = [];
		const handler = createWarmIpcLineReader((line) => lines.push(line), {
			// #3383 made the reader's label required: it is the ledger subject for
			// an over-long line, so no reader can record under a generic name.
			label: "mcp-warm-server",
		});
		handler(`${JSON.stringify({ file: "/x/a.ts" })}\n`);
		handler(`${JSON.stringify({ file: "/x/b.ts" })}\n`);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).file).toBe("/x/a.ts");
	});

	it("dispatches only the first request when two arrive in one chunk (#1219)", () => {
		const lines: string[] = [];
		const handler = createWarmIpcLineReader((line) => lines.push(line), {
			// #3383 made the reader's label required: it is the ledger subject for
			// an over-long line, so no reader can record under a generic name.
			label: "mcp-warm-server",
		});
		handler(
			`${JSON.stringify({ file: "/x/a.ts" })}\n${JSON.stringify({ file: "/x/b.ts" })}\n`,
		);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).file).toBe("/x/a.ts");
	});

	it("assembles a request split across chunks before dispatching", () => {
		const lines: string[] = [];
		const handler = createWarmIpcLineReader((line) => lines.push(line), {
			// #3383 made the reader's label required: it is the ledger subject for
			// an over-long line, so no reader can record under a generic name.
			label: "mcp-warm-server",
		});
		handler('{"file":');
		handler('"/x/a.ts"}\n');
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).file).toBe("/x/a.ts");
	});

	it("does not dispatch when no newline ever arrives", () => {
		const lines: string[] = [];
		const handler = createWarmIpcLineReader((line) => lines.push(line), {
			// #3383 made the reader's label required: it is the ledger subject for
			// an over-long line, so no reader can record under a generic name.
			label: "mcp-warm-server",
		});
		handler("partial");
		expect(lines).toHaveLength(0);
	});
});

describe("createWarmIpcRequestQueue", () => {
	it("orders analyze and turn-end work even when the client disconnects", async () => {
		const queue = createWarmIpcRequestQueue();
		let releaseAnalyze: (() => void) | undefined;
		const events: string[] = [];
		const analyze = queue.enqueue(
			() =>
				new Promise<void>((resolve) => {
					events.push("analyze-start");
					releaseAnalyze = resolve;
				}),
		);
		const turnEnd = queue.enqueue(async () => {
			events.push("turn-end");
		});

		await Promise.resolve();
		expect(events).toEqual(["analyze-start"]);
		releaseAnalyze?.();
		await Promise.all([analyze, turnEnd]);
		expect(events).toEqual(["analyze-start", "turn-end"]);
	});

	it("keeps serving requests after a queued operation rejects", async () => {
		const queue = createWarmIpcRequestQueue();
		await expect(
			queue.enqueue(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await expect(queue.enqueue(async () => "next")).resolves.toBe("next");
	});
});

// --- #3255 round 2 (H1): the upgrade transition is visible, not silent ------
//
// Recurrence these cases prevent: narrowing the case fold changed the derived
// endpoint bytes, so a pre-upgrade MCP server keeps listening on the LEGACY
// socket name while every freshly-spawned hook derives the new one. Round 1
// shipped that transition as an ordinary cold fallback — one `ipc-error`
// indistinguishable from "no server was ever started", and a stale
// `pi-lens-turn-end-<legacy>.json` left in tmpdir forever. `ipc-error` is the
// same conflation #1272 split once already: absent server, stale build and
// schema skew have different remedies, so the wire reason must name which.

/**
 * The pre-#3255 (4.2.1) derivation, frozen here as a CROSS-VERSION FIXTURE: it
 * is what an already-running old binary computed, not a second copy of the
 * shipping rule. Nothing in production may derive this to READ or CONNECT — the
 * folded id is the colliding id on a case-sensitive host.
 */
function legacyWorkspaceId(cwd: string): string {
	return crypto
		.createHash("sha256")
		.update(path.resolve(cwd).toLowerCase())
		.digest("hex")
		.slice(0, 16);
}

describe("upgrade transition after the case-fold narrowing (#3255)", () => {
	it("does not reach a pre-upgrade server still listening on the legacy endpoint", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-Stranded-"));
		const legacySocket = path.join(
			os.tmpdir(),
			`pi-lens-mcp-${legacyWorkspaceId(cwd)}.sock`,
		);
		if (process.platform !== "win32") {
			try {
				fs.unlinkSync(legacySocket);
			} catch {
				/* none */
			}
		}
		let dialed = 0;
		activeServer = net.createServer((socket) => {
			dialed++;
			socket.setEncoding("utf8");
			socket.once("data", () =>
				socket.end(
					`${JSON.stringify({
						result: {
							route: "turn-end",
							version: WARM_TURN_END_SCHEMA_VERSION,
							turnEnd: "STALE SERVER ANSWER",
							deliveryId: "d1",
						},
					})}\n`,
				),
			);
		});
		try {
			await new Promise<void>((resolve) =>
				activeServer?.listen(boundUnixSocketPath(legacySocket), resolve),
			);
			// The new hook must NOT be served by the old server (its answer is for
			// whatever workspace the folded id named), and the miss must carry the
			// discriminating reason rather than the generic transport error.
			await expect(requestWarmTurnEnd(cwd, 2000)).resolves.toEqual({
				available: false,
				reason: "no-listener",
			});
			expect(dialed).toBe(0);
		} finally {
			removeTempDirSync(cwd);
		}
	});

	it("keeps ipc-error when the connection opened and then failed", async () => {
		// The other direction of the same classifier. A server that ACCEPTS and
		// then drops the connection is present and broken, not absent — telling
		// its user to start a server, or blaming an upgrade, is wrong advice.
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ipc-Reset-"));
		await listenOnWorkspaceEndpoint(cwd, (socket) => {
			socket.on("error", () => {
				/* the peer reset is the point */
			});
			socket.destroy(new Error("incumbent crashed mid-reply"));
		});
		try {
			await expect(requestWarmTurnEnd(cwd, 2000)).resolves.toEqual({
				available: false,
				reason: "ipc-error",
			});
		} finally {
			removeTempDirSync(cwd);
		}
	});

	// #3255 round 3 (H2): the two status-file cases are about CROSS-WORKSPACE
	// isolation, and both drive the platform through the same injected argument
	// the round-1 derivations use, so neither needs a `skipIf`.
	//
	// Recurrence they prevent: round 2 deleted the "pre-upgrade" status file
	// whenever its name differed from the one it had just written. On a
	// case-sensitive host that name is not an orphan at all — it is the LIVE
	// current file of the case-variant sibling workspace, because the retired
	// always-fold rule maps `/repo/Alpha` onto the same id the live rule gives
	// `/repo/alpha`. Recording one workspace's turn erased the other's history.
	it("keeps a case-variant sibling's status file on a case-sensitive host", () => {
		const upper = "/repo/Alpha";
		const lower = "/repo/alpha";
		const upperFile = turnEndStatusPathForCwd(upper, "linux");
		const lowerFile = turnEndStatusPathForCwd(lower, "linux");
		fs.rmSync(upperFile, { force: true });
		fs.rmSync(lowerFile, { force: true });
		try {
			expect(upperFile).not.toBe(lowerFile);
			// The sibling has a live record of its own, written under the CURRENT
			// rule — not a leftover.
			recordTurnEndOutcome(
				lower,
				{ ran: false, reason: "no-listener" },
				"linux",
			);
			expect(readTurnEndStatus(lower, "linux")).toMatchObject({ skipped: 1 });

			recordTurnEndOutcome(upper, { ran: true }, "linux");

			// Each workspace keeps its own counters. Recording a turn in one may
			// never touch another workspace's telemetry.
			expect(readTurnEndStatus(upper, "linux")).toMatchObject({
				ran: 1,
				skipped: 0,
			});
			expect(readTurnEndStatus(lower, "linux")).toMatchObject({
				ran: 0,
				skipped: 1,
				lastSkipReason: "no-listener",
			});
		} finally {
			fs.rmSync(upperFile, { force: true });
			fs.rmSync(lowerFile, { force: true });
		}
	});

	it("shares one status file between case-variant spellings on a folding platform", () => {
		// The same fixture pair with the opposite expectation: where the
		// filesystem folds case the two spellings are ONE directory, so they must
		// keep ONE set of counters. This is also what keeps the injected
		// `platform` on these two functions provable from the ubuntu lane — the
		// case-sensitive case above cannot distinguish an injected "linux" from
		// the host default.
		const upper = "/repo/Alpha";
		const lower = "/repo/alpha";
		const shared = turnEndStatusPathForCwd(upper, "win32");
		fs.rmSync(shared, { force: true });
		try {
			expect(turnEndStatusPathForCwd(lower, "win32")).toBe(shared);
			recordTurnEndOutcome(upper, { ran: true }, "win32");
			recordTurnEndOutcome(lower, { ran: true }, "win32");
			// Read back through BOTH spellings. The uppercase one is the load-bearing
			// read: `/repo/alpha` is already lowercase, so both rules give it the same
			// id and it cannot tell an honored `platform` from an ignored one.
			expect(readTurnEndStatus(upper, "win32")).toMatchObject({ ran: 2 });
			expect(readTurnEndStatus(lower, "win32")).toMatchObject({ ran: 2 });
		} finally {
			fs.rmSync(shared, { force: true });
		}
	});
});
