/**
 * #3601: `lsp_navigation`'s rename binds every file its workspace edit writes
 * text to the content the language server computed against: the target to the
 * read it sent, every other file to the client's tracked send when the client
 * has it open, else (the server read it from disk) to an mtime check against
 * the instant the request was sent. A file that changed since is refused, and
 * the refusal names it in the tool result and in the degradation ledger. The LSP
 * service is a fake at that one boundary (its tracked-send accessor answers
 * from what the test "sent"); the apply, pi's mutation queue, and the
 * degradation ledger are the real ones.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { hashDiagnosticContent } from "../../clients/lsp/diagnostic-binding.js";
import { setHostFileMutationQueueLoader } from "../../clients/file-mutation-queue.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

const lsp = vi.hoisted(() => ({ service: undefined as unknown }));
vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: () => lsp.service,
}));

import { createLspNavigationTool } from "../../tools/lsp-navigation.js";

function gate() {
	let open!: () => void;
	const p = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { p, open };
}

function sameFile(a: string, b: string): boolean {
	try {
		return fs.realpathSync(a) === fs.realpathSync(b);
	} catch {
		return path.resolve(a) === path.resolve(b);
	}
}

/**
 * What the language client last sent for each path, as `getTrackedContent`
 * reports it. The seeded sends were made a minute ago, before any rename.
 */
function trackedSends(sent: Record<string, string>) {
	const byReal = new Map(
		Object.entries(sent).map(([p, content]) => [
			fs.realpathSync(p),
			{
				hash: hashDiagnosticContent(content),
				changedAtMs: Date.now() - 60_000,
			},
		]),
	);
	return vi.fn((p: string) => {
		try {
			return byReal.get(fs.realpathSync(p));
		} catch {
			return undefined;
		}
	});
}

/** A tracked send of `content` made a minute ago (before any rename). */
const pastSend = (content: string) => ({
	hash: hashDiagnosticContent(content),
	changedAtMs: Date.now() - 60_000,
});

let env: ReturnType<typeof setupTestEnvironment>;
let fileA: string;
let fileB: string;

beforeEach(() => {
	resetDegradationLedger();
	env = setupTestEnvironment("pi-lens-lsp-nav-stale-");
	fileA = path.join(env.tmpDir, "a.ts");
	fileB = path.join(env.tmpDir, "b.ts");
	fs.writeFileSync(fileA, "const = 1;\n");
	fs.writeFileSync(fileB, "const = 2;\n");
	setHostFileMutationQueueLoader(async () => ({ withFileMutationQueue }));
});

afterEach(() => {
	lsp.service = undefined;
	vi.restoreAllMocks();
	setHostFileMutationQueueLoader(undefined);
	env.cleanup();
});

/** Replaces `const` on line 1 of `target` with `let`. */
const valueEdit = (target = fileA) => ({
	changes: {
		[pathToFileURL(target).href]: [
			{
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 5 },
				},
				newText: "let",
			},
		],
	},
});

/** Both files, as one rename edit. */
const twoFileEdit = () => ({
	changes: {
		...valueEdit(fileA).changes,
		...valueEdit(fileB).changes,
	},
});

/** Sets `file`'s mtime to `ageMs` before now. */
function ageFile(file: string, ageMs: number): void {
	const when = new Date(Date.now() - ageMs);
	fs.utimesSync(file, when, when);
}

const staleRows = () =>
	getDegradationSummary().filter(
		(group) => group.kind === "lsp-edit-stale-content",
	);

async function runRename(): Promise<{
	isError?: boolean;
	content: Array<{ text?: string }>;
}> {
	const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
	return (await tool.execute(
		"rename-3601",
		{
			operation: "rename",
			path: fileA,
			line: 1,
			character: 1,
			newName: "let",
			apply: true,
		},
		new AbortController().signal,
		null,
		{ cwd: env.tmpDir },
	)) as never;
}

const resultText = (result: { content: Array<{ text?: string }> }): string =>
	String(result.content[0]?.text ?? "");

describe("#3601: lsp_navigation's rename refuses an edit on a file that changed", () => {
	it("an agent write made while the rename is computed is not overwritten, and the refusal names the file", async () => {
		const parked = gate();
		const resume = gate();
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			rename: async () => {
				parked.open();
				await resume.p;
				return valueEdit();
			},
		});

		const pending = runRename();
		await parked.p;
		// The rename has read its target and is parked inside the server call.
		await withFileMutationQueue(fileA, async () => {
			fs.writeFileSync(fileA, "AGENT = 9;\n");
		});
		resume.open();
		const result = await pending;

		// The rename's offsets land on the agent's bytes unless the edit is refused.
		expect(fs.readFileSync(fileA, "utf8")).toBe("AGENT = 9;\n");
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain(path.basename(fileA));
		expect(staleRows()).toEqual([expect.objectContaining({ count: 1 })]);
	});

	it("an agent write to a NON-target file made while the rename is computed is not overwritten, and the refusal names the file", async () => {
		const parked = gate();
		const resume = gate();
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			getTrackedContent: trackedSends({
				[fileA]: "const = 1;\n",
				[fileB]: "const = 2;\n",
			}),
			rename: async () => {
				parked.open();
				await resume.p;
				return {
					changes: {
						...valueEdit(fileA).changes,
						...valueEdit(fileB).changes,
					},
				};
			},
		});

		const pending = runRename();
		await parked.p;
		// The rename is parked inside the server call; the agent writes the OTHER file.
		await withFileMutationQueue(fileB, async () => {
			fs.writeFileSync(fileB, "AGENT = 8;\n");
		});
		resume.open();
		const result = await pending;

		// Neither touched file takes the other's stale offsets.
		expect(fs.readFileSync(fileB, "utf8")).toBe("AGENT = 8;\n");
		expect(fs.readFileSync(fileA, "utf8")).toBe("const = 1;\n");
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain(path.basename(fileB));
		expect(staleRows()).toEqual([expect.objectContaining({ count: 1 })]);
	});

	it("an agent write to an OPENED non-target file, synced to the server after the rename request, is not overwritten", async () => {
		// #3601 round 4 (verifier r3 V1): the agent's write hook re-sends the file
		// (`touchFile`), so the disk equals the client's last send, but the server
		// answered from the send before it. The clock is frozen, so the hook's
		// send carries the very millisecond the request was stamped with.
		vi.spyOn(Date, "now").mockReturnValue(Date.now());
		const sends = new Map([
			[fs.realpathSync(fileA), pastSend("const = 1;\n")],
			[fs.realpathSync(fileB), pastSend("const = 2;\n")],
		]);
		const parked = gate();
		const resume = gate();
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			// Production's client records each send's hash, and stamps it when the
			// bytes change (clients/lsp/client.ts `recordSentContent`).
			touchFile: vi.fn(async (p: string, content: string) => {
				const key = fs.realpathSync(p);
				const hash = hashDiagnosticContent(content);
				if (sends.get(key)?.hash !== hash)
					sends.set(key, { hash, changedAtMs: Date.now() });
				return { diags: [] };
			}),
			getTrackedContent: vi.fn((p: string) => sends.get(fs.realpathSync(p))),
			rename: async () => {
				parked.open();
				await resume.p;
				return twoFileEdit();
			},
		});

		const pending = runRename();
		await parked.p;
		// The server has answered; the agent writes b.ts and its hook syncs it.
		await withFileMutationQueue(fileB, async () => {
			fs.writeFileSync(fileB, "AGENT = 8;\n");
		});
		await (
			lsp.service as { touchFile: (p: string, c: string) => Promise<unknown> }
		).touchFile(fileB, "AGENT = 8;\n");
		resume.open();
		const result = await pending;

		expect(fs.readFileSync(fileB, "utf8")).toBe("AGENT = 8;\n");
		expect(fs.readFileSync(fileA, "utf8")).toBe("const = 1;\n");
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain(path.basename(fileB));
		expect(staleRows()).toEqual([expect.objectContaining({ count: 1 })]);
	});

	it("an agent write to a non-target file made after the capture read is not overwritten", async () => {
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			// The client tracked the second file's current bytes, so capture passes
			// and the agent's write lands in the window before the apply. The write
			// runs inside the tracked-hash lookup, which the capture makes after it
			// has read the file.
			getTrackedContent: vi.fn((p: string) => {
				const sent = pastSend(p === fileA ? "const = 1;\n" : "const = 2;\n");
				if (sameFile(p, fileB)) fs.writeFileSync(fileB, "AGENT = 7;\n");
				return sent;
			}),
			rename: async () => ({
				changes: {
					...valueEdit(fileA).changes,
					...valueEdit(fileB).changes,
				},
			}),
		});

		const result = await runRename();

		expect(fs.readFileSync(fileB, "utf8")).toBe("AGENT = 7;\n");
		expect(fs.readFileSync(fileA, "utf8")).toBe("const = 1;\n");
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain(path.basename(fileB));
		expect(staleRows()).toEqual([expect.objectContaining({ count: 1 })]);
	});

	it("a file first opened after the request is refused when its client reports no start, and renamed when it was quiet since the start", async () => {
		// Recurrence guarded: #3827 review r1 F1. The first-open exemption is a
		// claim about the file's mtime against the client's start; a client that
		// cannot make it (a double, an older client) keeps the stamp check.
		ageFile(fileB, 3_600_000);
		const firstOpen = (clientStartedAtMs?: number) => ({
			hash: hashDiagnosticContent("const = 2;\n"),
			changedAtMs: Date.now() + 60_000,
			openedAtMs: Date.now() + 60_000,
			openedHash: hashDiagnosticContent("const = 2;\n"),
			clientStartedAtMs,
		});
		const run = async (clientStartedAtMs?: number) => {
			lsp.service = makeLspServiceDouble({
				supportsLSP: () => true,
				hasLSP: async () => true,
				getTrackedContent: vi.fn((p: string) =>
					sameFile(p, fileB) ? firstOpen(clientStartedAtMs) : undefined,
				),
				rename: async () => twoFileEdit(),
			});
			return runRename();
		};

		const unknown = await run(undefined);
		expect(unknown.isError).toBe(true);
		expect(resultText(unknown)).toContain(path.basename(fileB));
		expect(fs.readFileSync(fileB, "utf8")).toBe("const = 2;\n");

		const quiet = await run(Date.now() - 60_000);
		expect(quiet.isError).toBeUndefined();
		expect(fs.readFileSync(fileB, "utf8")).toBe("let = 2;\n");
	});

	it("an unopened non-target file whose mtime is inside the margin is refused, naming the file", async () => {
		// Written 1.5 s before the request, inside the 2 s margin: the server
		// may have read either side of that write.
		ageFile(fileB, 1500);
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			// Only the target was ever sent; the server reads the other from disk.
			getTrackedContent: trackedSends({ [fileA]: "const = 1;\n" }),
			rename: async () => twoFileEdit(),
		});

		const result = await runRename();

		expect(fs.readFileSync(fileA, "utf8")).toBe("const = 1;\n");
		expect(fs.readFileSync(fileB, "utf8")).toBe("const = 2;\n");
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain(path.basename(fileB));
		// Written before the request: a retry may pass, so the message says so.
		expect(resultText(result)).toContain(
			"modified within 2 s of the rename request; retry",
		);
		expect(staleRows()).toEqual([expect.objectContaining({ count: 1 })]);
	});

	it("an unopened, untouched non-target file older than the margin is renamed with its target", async () => {
		// A cross-file rename whose other file the server read from disk.
		ageFile(fileB, 2500);
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			getTrackedContent: trackedSends({ [fileA]: "const = 1;\n" }),
			rename: async () => twoFileEdit(),
		});

		const result = await runRename();

		expect(result.isError).toBeUndefined();
		expect(fs.readFileSync(fileA, "utf8")).toBe("let = 1;\n");
		expect(fs.readFileSync(fileB, "utf8")).toBe("let = 2;\n");
		expect(staleRows()).toEqual([]);
	});

	it("an unopened non-target file written while the rename is computed is refused, naming the file", async () => {
		ageFile(fileB, 3_600_000);
		const parked = gate();
		const resume = gate();
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			getTrackedContent: trackedSends({ [fileA]: "const = 1;\n" }),
			rename: async () => {
				parked.open();
				await resume.p;
				return twoFileEdit();
			},
		});

		const pending = runRename();
		await parked.p;
		await withFileMutationQueue(fileB, async () => {
			fs.writeFileSync(fileB, "AGENT = 8;\n");
			// The write lands a second into the compute. Linux stamps an mtime
			// with a tick-coarse clock that can trail `Date.now()`, so a write
			// within a few ms of the request can read as just before it, and is
			// then refused under the margin message instead of this one.
			const landed = new Date(Date.now() + 1000);
			fs.utimesSync(fileB, landed, landed);
		});
		// The compute outlasts the mtime margin: an instant taken only when the
		// server answers would sit a minute past this write.
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
		resume.open();
		const result = await pending;
		clock.mockRestore();

		expect(fs.readFileSync(fileB, "utf8")).toBe("AGENT = 8;\n");
		expect(fs.readFileSync(fileA, "utf8")).toBe("const = 1;\n");
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain(path.basename(fileB));
		expect(resultText(result)).toContain(
			"written after the rename was requested",
		);
		expect(staleRows()).toEqual([expect.objectContaining({ count: 1 })]);
	});

	it("an unopened file that passes the mtime check is still held to the bytes read at capture", async () => {
		// The same-mtime blind spot: the agent rewrites the file after the
		// capture read and restores its old mtime. Only the apply-time content
		// comparison can catch it.
		ageFile(fileB, 3_600_000);
		const oldMtime = fs.statSync(fileB).mtime;
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			getTrackedContent: vi.fn((p: string) => {
				if (sameFile(p, fileB)) {
					fs.writeFileSync(fileB, "AGENT = 6;\n");
					fs.utimesSync(fileB, oldMtime, oldMtime);
					return undefined;
				}
				return pastSend("const = 1;\n");
			}),
			rename: async () => twoFileEdit(),
		});

		const result = await runRename();

		expect(fs.readFileSync(fileB, "utf8")).toBe("AGENT = 6;\n");
		expect(fs.readFileSync(fileA, "utf8")).toBe("const = 1;\n");
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain(path.basename(fileB));
		expect(staleRows()).toEqual([expect.objectContaining({ count: 1 })]);
	});

	it("a tracked non-target file that has not changed is renamed with its target", async () => {
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			getTrackedContent: trackedSends({
				[fileA]: "const = 1;\n",
				[fileB]: "const = 2;\n",
			}),
			rename: async () => ({
				changes: {
					...valueEdit(fileA).changes,
					...valueEdit(fileB).changes,
				},
			}),
		});

		const result = await runRename();

		expect(result.isError).toBeUndefined();
		expect(fs.readFileSync(fileA, "utf8")).toBe("let = 1;\n");
		expect(fs.readFileSync(fileB, "utf8")).toBe("let = 2;\n");
		expect(staleRows()).toEqual([]);
	});

	it("a file the edit creates is not content-checked and is written", async () => {
		const created = path.join(env.tmpDir, "c.ts");
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			// The created file cannot be tracked; only the target exists.
			getTrackedContent: trackedSends({ [fileA]: "const = 1;\n" }),
			rename: async () => ({
				documentChanges: [
					{ kind: "create", uri: pathToFileURL(created).href },
					{
						textDocument: { uri: pathToFileURL(created).href, version: null },
						edits: [
							{
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 0 },
								},
								newText: "export {};\n",
							},
						],
					},
					{
						textDocument: { uri: pathToFileURL(fileA).href, version: null },
						edits: valueEdit(fileA).changes[pathToFileURL(fileA).href],
					},
				],
			}),
		});

		const result = await runRename();

		expect(result.isError).toBeUndefined();
		expect(fs.readFileSync(created, "utf8")).toBe("export {};\n");
		expect(fs.readFileSync(fileA, "utf8")).toBe("let = 1;\n");
		expect(staleRows()).toEqual([]);
	});

	it("a file the edit only deletes is not a text edit and is not refused as untracked", async () => {
		const doomed = path.join(env.tmpDir, "d.ts");
		fs.writeFileSync(doomed, "const = 3;\n");
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			getTrackedContent: trackedSends({ [fileA]: "const = 1;\n" }),
			rename: async () => ({
				documentChanges: [
					{ kind: "delete", uri: pathToFileURL(doomed).href },
					{
						textDocument: { uri: pathToFileURL(fileA).href, version: null },
						edits: valueEdit(fileA).changes[pathToFileURL(fileA).href],
					},
				],
			}),
		});

		const result = await runRename();

		expect(result.isError).toBeUndefined();
		expect(fs.existsSync(doomed)).toBe(false);
		expect(fs.readFileSync(fileA, "utf8")).toBe("let = 1;\n");
		expect(staleRows()).toEqual([]);
	});

	it("an agent edit between an empty first answer and the retry does not refuse a valid edit", async () => {
		// The cold-server path: the first answer is empty, the tool re-opens the
		// target (sending the bytes now on disk) and asks again. The retried
		// answer is computed from the re-sent bytes, so the agent edit made
		// before the retry is not a stale write.
		let calls = 0;
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			rename: async () => {
				calls++;
				if (calls === 1) {
					fs.writeFileSync(fileA, "const = 1;\n// agent comment\n");
					return null;
				}
				return valueEdit();
			},
		});

		const result = await runRename();

		expect(calls).toBe(2);
		expect(result.isError).toBeUndefined();
		expect(fs.readFileSync(fileA, "utf8")).toBe("let = 1;\n// agent comment\n");
		expect(staleRows()).toEqual([]);
	});

	it("an empty target is still bound: an agent write while its rename is computed is refused", async () => {
		fs.writeFileSync(fileA, "");
		const parked = gate();
		const resume = gate();
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			rename: async () => {
				parked.open();
				await resume.p;
				return {
					changes: {
						[pathToFileURL(fileA).href]: [
							{
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 0 },
								},
								newText: "let",
							},
						],
					},
				};
			},
		});

		const pending = runRename();
		await parked.p;
		await withFileMutationQueue(fileA, async () => {
			fs.writeFileSync(fileA, "AGENT\n");
		});
		resume.open();
		const result = await pending;

		expect(fs.readFileSync(fileA, "utf8")).toBe("AGENT\n");
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain(path.basename(fileA));
		expect(staleRows()).toEqual([expect.objectContaining({ count: 1 })]);
	});

	it("no-drop: with no write in between, the rename applies and records no stale content", async () => {
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			rename: async () => valueEdit(),
		});

		const result = await runRename();

		expect(result.isError).toBeUndefined();
		expect(fs.readFileSync(fileA, "utf8")).toBe("let = 1;\n");
		expect(staleRows()).toEqual([]);
	});
});
