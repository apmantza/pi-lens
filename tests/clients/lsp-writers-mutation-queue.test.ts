/**
 * #3541: pi-lens' LSP writers run their read-modify-write inside pi's
 * per-file mutation queue. Every one of them reaches the disk through
 * `applyWorkspaceEdit` (clients/lsp/edits.ts): the agent_end actionable
 * fix, `lsp_navigation`'s applied rename, and a server-initiated
 * `workspace/applyEdit`. One case per writer drives it through its own
 * entry point; the seam cases pin the multi-path queue entry.
 *
 * pi's queue is the real one. The interleaving is pinned with a gate in
 * `node:fs/promises` `writeFile`: the writer has read the file and parks
 * before it writes it back, and the agent's edit (pi's edit tool shape: a
 * synchronous read-modify-write inside the queue) is made there.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
// pi's real per-file queue, the one its `edit`/`write` tools run under.
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { createMockState } from "./lsp/mock-client-state.js";
import { setupTestEnvironment } from "./test-utils.js";

const writeGate = vi.hoisted(() => ({
	target: undefined as string | undefined,
	parked: undefined as undefined | (() => void),
	resume: undefined as undefined | Promise<void>,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const writeFile = async (...args: Parameters<typeof actual.writeFile>) => {
		if (writeGate.target !== undefined && args[0] === writeGate.target) {
			writeGate.parked?.();
			await writeGate.resume;
		}
		return actual.writeFile(...args);
	};
	return { ...actual, default: { ...actual, writeFile }, writeFile };
});

const lsp = vi.hoisted(() => ({ service: undefined as unknown }));
const { logLatency } = vi.hoisted(() => ({ logLatency: vi.fn() }));
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/latency-logger.js")>()),
	logLatency,
}));
vi.mock("../../clients/lsp/capabilities.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/lsp/capabilities.js")
	>()),
	getLSPService: () => lsp.service,
}));

import {
	applyConservativeActionableWarningFixes,
	type ActionableWarningsReport,
} from "../../clients/actionable-warnings.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { setHostFileMutationQueueLoader } from "../../clients/file-mutation-queue.js";
import { setupIncomingHandlers } from "../../clients/lsp/client.js";
import { applyWorkspaceEdit } from "../../clients/lsp/edits.js";
import { createLspNavigationTool } from "../../tools/lsp-navigation.js";

function gate() {
	let open!: () => void;
	const p = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { p, open };
}

let env: ReturnType<typeof setupTestEnvironment>;
let filePath: string;

/** Parks the writer between its read of F and its write of F. */
function parkWrite() {
	const parked = gate();
	const resume = gate();
	writeGate.target = filePath;
	writeGate.parked = parked.open;
	writeGate.resume = resume.p;
	return { parked: parked.p, resume: resume.open };
}

/** The agent's edit, the way pi's edit tool makes it: inside pi's queue. */
function agentAppend(line: string) {
	let wrote = false;
	const done = withFileMutationQueue(filePath, async () => {
		fs.writeFileSync(filePath, `${fs.readFileSync(filePath, "utf8")}${line}`);
		wrote = true;
	});
	return { done, wrote: () => wrote };
}

/**
 * Resolves once every queue call made before it has registered: pi chains
 * registrations through one module-wide promise, so a call on another path
 * registers after them. An earlier call whose file is free has run by then.
 */
function afterQueueRegistration(): Promise<void> {
	return withFileMutationQueue(
		path.join(env.tmpDir, "registration-barrier"),
		async () => {},
	);
}

/** Replaces `value` on line 1 with `const`. */
function valueEdit(target = filePath) {
	return {
		changes: {
			[pathToFileURL(target).href]: [
				{
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 5 },
					},
					newText: "const",
				},
			],
		},
	};
}

/**
 * The case body every writer shares: the writer parks between its read and
 * its write, the agent edits F through pi's queue, and the agent's edit must
 * wait for the writer and survive it.
 */
async function assertAgentEditSurvives(write: () => Promise<unknown>) {
	const w = parkWrite();
	const writer = write();
	await w.parked;
	const agent = agentAppend("export const AGENT = 2;\n");
	await afterQueueRegistration();
	expect(agent.wrote()).toBe(false);
	w.resume();
	await writer;
	await agent.done;
	expect(fs.readFileSync(filePath, "utf8")).toBe(
		"const = 1;\nexport const AGENT = 2;\n",
	);
}

/** The quick fix the actionable-warning report offers for line 1. */
const fixIt = (target = filePath) => ({
	title: "Fix it",
	kind: "quickfix",
	isPreferred: true,
	edit: valueEdit(target),
});

/**
 * The agent_end actionable fix's collaborators: eslint agreement evidence
 * (tool-agreement.ts) and an LSP service whose code action is `codeAction`.
 */
function useActionableFix(codeAction: () => Promise<unknown[]>) {
	fs.writeFileSync(
		path.join(env.tmpDir, "package.json"),
		JSON.stringify({ devDependencies: { eslint: "^9.0.0" } }),
	);
	fs.writeFileSync(
		path.join(env.tmpDir, "package-lock.json"),
		JSON.stringify({
			packages: { "node_modules/eslint": { version: "9.0.0" } },
		}),
	);
	lsp.service = makeLspServiceDouble({
		supportsLSP: () => true,
		openFile: async () => undefined,
		codeAction,
	});
}

/** One autofix-eligible warning on line 1 of F. */
function actionableReport(reported = filePath): ActionableWarningsReport {
	return {
		generatedAt: new Date().toISOString(),
		scope: "turn_delta",
		sessionId: "lsp-writer-queue",
		turnIndex: 1,
		projectSeqEnd: 1,
		deltaOnly: true,
		includeLspCodeActions: true,
		files: [
			{
				filePath: reported,
				displayPath: "a.ts",
				warnings: [
					{
						id: "eslint:fix",
						filePath: reported,
						displayPath: "a.ts",
						line: 1,
						column: 1,
						severity: "warning",
						tool: "eslint",
						message: "fixable warning",
						actions: [
							{
								title: "Fix it",
								hasEdit: true,
								hasCommand: false,
								autoFixEligible: true,
							},
						],
						suppressed: false,
						origin: "lsp",
					},
				],
			},
		],
		summary: {} as ActionableWarningsReport["summary"],
	};
}

beforeEach(() => {
	resetDegradationLedger();
	logLatency.mockClear();
	env = setupTestEnvironment("pi-lens-lsp-writer-queue-");
	filePath = path.join(env.tmpDir, "a.ts");
	fs.writeFileSync(filePath, "value = 1;\n");
	setHostFileMutationQueueLoader(async () => ({ withFileMutationQueue }));
});

afterEach(() => {
	writeGate.target = undefined;
	writeGate.parked = undefined;
	writeGate.resume = undefined;
	lsp.service = undefined;
	setHostFileMutationQueueLoader(undefined);
	env.cleanup();
});

describe("#3541: each LSP writer applies its edit inside pi's mutation queue", () => {
	it("the agent_end actionable-warning fix does not erase an agent edit made while it applies", async () => {
		useActionableFix(async () => [fixIt()]);
		await assertAgentEditSurvives(async () => {
			const summary = await applyConservativeActionableWarningFixes({
				cwd: env.tmpDir,
				report: actionableReport(),
			});
			expect(summary.applied).toBe(1);
		});
	});

	it("lsp_navigation's applied rename does not erase an agent edit made while it applies", async () => {
		lsp.service = makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			rename: async () => valueEdit(),
		});
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		await assertAgentEditSurvives(async () => {
			const result = await tool.execute(
				"rename-apply-3541",
				{
					operation: "rename",
					path: filePath,
					line: 1,
					character: 1,
					newName: "const",
					apply: true,
				},
				new AbortController().signal,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.isError).toBeUndefined();
		});
	});

	it("a server-initiated workspace/applyEdit does not erase an agent edit made while it applies", async () => {
		const state = createMockState({ root: env.tmpDir });
		// Inside an executeCommand's acceptance window.
		state.serverEditsAllowed = 1;
		setupIncomingHandlers(state, {});
		const calls = vi.mocked(state.connection.onRequest).mock
			.calls as unknown as Array<[string, (params: unknown) => unknown]>;
		const applyEdit = calls.find((call) => call[0] === "workspace/applyEdit");
		await assertAgentEditSurvives(async () => {
			expect(await applyEdit?.[1]({ edit: valueEdit() })).toEqual({
				applied: true,
			});
		});
	});
});

describe("#3541: applyWorkspaceEdit enters every path's queue", () => {
	it("an edit enters the queue of every path it names: a text edit, a create, both ends of a rename, a delete", async () => {
		const entered: string[] = [];
		setHostFileMutationQueueLoader(async () => ({
			withFileMutationQueue: <T>(key: string, fn: () => Promise<T>) => {
				entered.push(key);
				return withFileMutationQueue(key, fn);
			},
		}));
		const created = path.join(env.tmpDir, "created.ts");
		const renamedFrom = path.join(env.tmpDir, "old.ts");
		const renamedTo = path.join(env.tmpDir, "new.ts");
		const deleted = path.join(env.tmpDir, "gone.ts");
		fs.writeFileSync(renamedFrom, "");
		fs.writeFileSync(deleted, "");
		// pi's key: the realpath of an existing file, the resolved spelling of
		// a missing one.
		const expected = [
			fs.realpathSync(filePath),
			path.join(fs.realpathSync(env.tmpDir), "created.ts"),
			fs.realpathSync(renamedFrom),
			path.join(fs.realpathSync(env.tmpDir), "new.ts"),
			fs.realpathSync(deleted),
		].sort();
		await applyWorkspaceEdit(
			{
				documentChanges: [
					{
						textDocument: { uri: pathToFileURL(filePath).href, version: null },
						edits: valueEdit().changes[pathToFileURL(filePath).href],
					},
					{ kind: "create", uri: pathToFileURL(created).href },
					{
						kind: "rename",
						oldUri: pathToFileURL(renamedFrom).href,
						newUri: pathToFileURL(renamedTo).href,
					},
					{ kind: "delete", uri: pathToFileURL(deleted).href },
				],
			},
			env.tmpDir,
		);
		// The order is the opposite-orders case's to pin.
		expect([...entered].sort()).toEqual(expected);
		expect(fs.readFileSync(filePath, "utf8")).toBe("const = 1;\n");
		expect(fs.existsSync(renamedTo) && !fs.existsSync(deleted)).toBe(true);
	});

	it("an edit checks its preconditions against the disk it writes: a create an agent write made ahead of it is skipped, not a mid-application failure", async () => {
		const created = path.join(env.tmpDir, "c.ts");
		// Missing when both are queued: pi keys it by its resolved spelling.
		const key = path.join(fs.realpathSync(env.tmpDir), "c.ts");
		const queued = gate();
		setHostFileMutationQueueLoader(async () => ({
			withFileMutationQueue: <T>(k: string, fn: () => Promise<T>) => {
				if (k === key) queued.open();
				return withFileMutationQueue(k, fn);
			},
		}));
		// The agent's write of the new file holds its queue, parked.
		const write = gate();
		const agent = withFileMutationQueue(created, async () => {
			await write.p;
			fs.writeFileSync(created, "export const AGENT = 2;\n");
		});
		const edit = applyWorkspaceEdit(
			{
				documentChanges: [
					{
						textDocument: { uri: pathToFileURL(filePath).href, version: null },
						edits: valueEdit().changes[pathToFileURL(filePath).href],
					},
					{
						kind: "create",
						uri: pathToFileURL(created).href,
						options: { ignoreIfExists: true },
					},
				],
			},
			env.tmpDir,
		);
		// The edit now waits behind the agent's write.
		await queued.p;
		write.open();
		await agent;
		await edit;
		expect(fs.readFileSync(filePath, "utf8")).toBe("const = 1;\n");
		expect(fs.readFileSync(created, "utf8")).toBe("export const AGENT = 2;\n");
	});

	it("two edits that name the same two files in opposite orders both apply", async () => {
		const other = path.join(env.tmpDir, "b.ts");
		fs.writeFileSync(other, "value = 1;\n");
		const edit = (first: string, second: string) => ({
			changes: {
				...valueEdit(first).changes,
				[pathToFileURL(second).href]: [
					{
						range: {
							start: { line: 0, character: 9 },
							end: { line: 0, character: 10 },
						},
						newText: "; // edited",
					},
				],
			},
		});
		const [ab, ba] = await Promise.allSettled([
			applyWorkspaceEdit(edit(filePath, other), env.tmpDir),
			applyWorkspaceEdit(edit(other, filePath), env.tmpDir),
		]);
		expect(ab.status).toBe("fulfilled");
		expect(ba.status).toBe("fulfilled");
	});

	it("an edit that names a file and a symlink to it settles", async () => {
		const alias = path.join(env.tmpDir, "alias.ts");
		fs.symlinkSync(filePath, alias);
		const settled = await Promise.allSettled([
			applyWorkspaceEdit(
				{
					changes: {
						...valueEdit(filePath).changes,
						[pathToFileURL(alias).href]: [
							{
								range: {
									start: { line: 0, character: 9 },
									end: { line: 0, character: 10 },
								},
								newText: "; // alias",
							},
						],
					},
				},
				env.tmpDir,
			),
		]);
		expect(settled).toHaveLength(1);
	});
});

/**
 * #3541 review round 2 (F1): the actionable fix reads F and asks the server
 * for a code action before it enters pi's queue. The action's positions are
 * the server's view of those bytes, so inside the queue the edit must still
 * meet them on disk, or it is rewritten into whatever an agent edit put there.
 */
describe("#3541: the actionable fix applies only to the bytes its code action was computed from", () => {
	const staleRows = () =>
		getDegradationSummary().filter(
			(group) => group.kind === "lsp-edit-stale-content",
		);

	// The report and the code action's URI can each spell F through a
	// symlinked directory; every pairing must key the same expected content.
	it.each([
		["the report and the edit spell F alike", false, false],
		["the report spells F through a symlinked directory", true, false],
		["the edit spells F through a symlinked directory", false, true],
	])(
		"an agent edit made while the code action is computed is not rewritten at the action's stale position; the fix is skipped as stale_content (%s)",
		async (_spelling, reportViaLink, editViaLink) => {
			const link = path.join(env.tmpDir, "linked");
			fs.symlinkSync(env.tmpDir, link, "dir");
			const viaLink = path.join(link, "a.ts");
			const asked = gate();
			const answer = gate();
			useActionableFix(async () => {
				asked.open();
				await answer.p;
				return [fixIt(editViaLink ? viaLink : filePath)];
			});
			const fix = applyConservativeActionableWarningFixes({
				cwd: env.tmpDir,
				report: actionableReport(reportViaLink ? viaLink : filePath),
			});
			await asked.p;
			// The agent's edit: a line prepended through pi's queue, so line 1 is
			// no longer the line the code action was computed for.
			await withFileMutationQueue(filePath, async () => {
				fs.writeFileSync(
					filePath,
					`export const AGENT = 2;\n${fs.readFileSync(filePath, "utf8")}`,
				);
			});
			answer.open();
			const summary = await fix;
			expect(fs.readFileSync(filePath, "utf8")).toBe(
				"export const AGENT = 2;\nvalue = 1;\n",
			);
			expect(summary).toMatchObject({
				applied: 0,
				changedFiles: [],
				skipped: [{ id: "eslint:fix", reason: "stale_content" }],
			});
			expect(staleRows()).toEqual([expect.objectContaining({ count: 1 })]);
		},
	);

	it("no-drop: with no edit in between, the fix applies and records no stale content", async () => {
		useActionableFix(async () => [fixIt()]);
		const summary = await applyConservativeActionableWarningFixes({
			cwd: env.tmpDir,
			report: actionableReport(),
		});
		expect(summary).toMatchObject({ applied: 1, skipped: [] });
		expect(fs.readFileSync(filePath, "utf8")).toBe("const = 1;\n");
		expect(staleRows()).toEqual([]);
	});
});

/**
 * #3541 review round 3 (R2): the fix's expected content covers only the
 * warning's own file, the one it read. A preferred quick fix whose edit also
 * writes another file would apply there at the server's positions unchecked,
 * so it is skipped before any write.
 */
describe("#3541: the actionable fix writes only the warning's own file", () => {
	it("a quick fix whose edit also changes another file is skipped as multi_file_edit, so an agent edit to that file survives", async () => {
		const other = path.join(env.tmpDir, "b.ts");
		fs.writeFileSync(other, "value = 2;\n");
		const asked = gate();
		const answer = gate();
		useActionableFix(async () => {
			asked.open();
			await answer.p;
			return [
				{
					...fixIt(),
					edit: {
						changes: {
							...valueEdit(filePath).changes,
							...valueEdit(other).changes,
						},
					},
				},
			];
		});
		const fix = applyConservativeActionableWarningFixes({
			cwd: env.tmpDir,
			report: actionableReport(),
		});
		await asked.p;
		await withFileMutationQueue(other, async () => {
			fs.writeFileSync(
				other,
				`export const AGENT = 2;\n${fs.readFileSync(other, "utf8")}`,
			);
		});
		answer.open();
		const summary = await fix;
		expect(fs.readFileSync(other, "utf8")).toBe(
			"export const AGENT = 2;\nvalue = 2;\n",
		);
		expect(fs.readFileSync(filePath, "utf8")).toBe("value = 1;\n");
		expect(summary).toMatchObject({
			applied: 0,
			skipped: [{ id: "eslint:fix", reason: "multi_file_edit" }],
		});
	});

	// #3541 review round 4 (V1): the stale check compares only a text edit's
	// first disk read, so a resource operation (create, rename, delete) is never
	// compared, even on the warning's own file: a create-overwrite empties it
	// before the text edit, and a delete removes it with the agent's edit.
	it.each([
		[
			"also creates another file",
			() => [
				{
					textDocument: { uri: pathToFileURL(filePath).href, version: null },
					edits: valueEdit().changes[pathToFileURL(filePath).href],
				},
				{
					kind: "create",
					uri: pathToFileURL(path.join(env.tmpDir, "created.ts")).href,
				},
			],
		],
		[
			"overwrites the warning's own file with a create, then inserts into it",
			() => [
				{
					kind: "create",
					uri: pathToFileURL(filePath).href,
					options: { overwrite: true },
				},
				{
					textDocument: { uri: pathToFileURL(filePath).href, version: null },
					edits: [
						{
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 0 },
							},
							newText: "fixed = 1;\n",
						},
					],
				},
			],
		],
		[
			"deletes the warning's own file",
			() => [{ kind: "delete", uri: pathToFileURL(filePath).href }],
		],
	])(
		"a quick fix whose edit %s is skipped as resource_operation before any write, so an agent edit made meanwhile survives",
		async (_shape, documentChanges) => {
			const asked = gate();
			const answer = gate();
			useActionableFix(async () => {
				asked.open();
				await answer.p;
				return [{ ...fixIt(), edit: { documentChanges: documentChanges() } }];
			});
			const fix = applyConservativeActionableWarningFixes({
				cwd: env.tmpDir,
				report: actionableReport(),
			});
			await asked.p;
			await withFileMutationQueue(filePath, async () => {
				fs.writeFileSync(
					filePath,
					`export const AGENT = 2;\n${fs.readFileSync(filePath, "utf8")}`,
				);
			});
			answer.open();
			const summary = await fix;
			expect(fs.existsSync(path.join(env.tmpDir, "created.ts"))).toBe(false);
			expect(
				fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "MISSING",
			).toBe("export const AGENT = 2;\nvalue = 1;\n");
			expect(summary).toMatchObject({
				applied: 0,
				skipped: [{ id: "eslint:fix", reason: "resource_operation" }],
			});
		},
	);
});

/**
 * #3541 review round 2 (F2): the queue wait is a new blocking point on every
 * LSP edit, so it leaves a latency row a live monitor can read.
 */
describe("#3541: applyWorkspaceEdit records its wait for pi's queue", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("an edit queued behind an agent edit records the wait as lsp_edit_queue_wait once it has entered", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(1_000_000);
		const key = fs.realpathSync(filePath);
		const queued = gate();
		setHostFileMutationQueueLoader(async () => ({
			withFileMutationQueue: <T>(k: string, fn: () => Promise<T>) => {
				if (k === key) queued.open();
				return withFileMutationQueue(k, fn);
			},
		}));
		const agentDone = gate();
		const agent = withFileMutationQueue(filePath, () => agentDone.p);
		const edit = applyWorkspaceEdit(valueEdit(), env.tmpDir);
		await queued.p;
		const waitRows = () =>
			logLatency.mock.calls
				.map(([row]) => row as { phase?: string })
				.filter((row) => row.phase === "lsp_edit_queue_wait");
		expect(waitRows()).toEqual([]);
		vi.setSystemTime(1_000_250);
		agentDone.open();
		await agent;
		await edit;
		expect(waitRows()).toEqual([
			expect.objectContaining({
				type: "phase",
				durationMs: 250,
				metadata: { paths: 1 },
			}),
		]);
	});
});
