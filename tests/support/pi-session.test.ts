/**
 * The contract of the tier-2 helper itself (#4632): a real `AgentSession` over
 * the BUILT extension, a scripted provider at the boundary, in process.
 *
 * Every assertion below reads a value only pi or the loaded copy produces —
 * pi's own transcript roles and content blocks, the tool result the loaded
 * copy's tool returned, the session file pi wrote, the log rows the loaded
 * copy's writers queued — never a value this test's setup supplied.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Type } from "../../clients/deps/typebox.js";
import { normalizeFilePath } from "../../clients/path-utils.js";
import { scannerReportParentDir } from "../../clients/scanner-temp-root.js";
import { ReadGuard } from "../../clients/read-guard.js";
import { pinFixtureHome } from "../clients/test-utils.js";
import {
	getActivePrimaryRoot,
	getActiveSessionId,
	getSecondarySessionCount,
} from "../../clients/session-lifecycle.js";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	piSessionFixture,
	replayToolNames,
	startPiSession,
} from "./pi-session.js";

const fixture = piSessionFixture();
// No per-case handle list here: the helper registers every session it creates
// and disposes the live ones in its own `afterEach`, so a case that fails
// before `dispose()` cannot leak one (#4664 M2).

/** The delimiter pi-lens prefixes every injected context block with. */
const INJECTION_DELIMITER = "[pi-lens automated context — not a user request]";

/**
 * A settled call as plain text: its rejection's message, or `resolved`. A
 * resolved restart is a handle over pi's session, and vitest cannot print one
 * (it reads pi's uninitialised theme Proxy and throws `Theme not
 * initialized`), so a `rejects` matcher would hide what the call did.
 */
async function outcome(call: Promise<unknown>): Promise<string> {
	return call.then(
		() => "resolved",
		(error: unknown) =>
			error instanceof Error ? error.message : String(error),
	);
}

function textBlocks(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.flatMap((block) => {
		const typed = block as { type?: string; text?: string };
		return typed.type === "text" && typeof typed.text === "string"
			? [typed.text]
			: [];
	});
}

/** The system messages of one provider request, in order. */
function systemMessages(
	transcript: ReadonlyArray<{ role: string; [key: string]: unknown }>,
): Array<Record<string, unknown>> {
	return transcript.filter((message) => message.role === "system") as Array<
		Record<string, unknown>
	>;
}

describe("pi-session: the built extension in a real AgentSession (#4632)", () => {
	it("runs session_start and a turn through the loaded copy", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "turn", "proj"),
			responses: [fauxAssistantMessage(fauxText("ready"))],
		});

		await handle.prompt("hello");

		// One prompt, one provider round trip: the request count is pi's own.
		expect(handle.requests).toHaveLength(1);
		const transcript = handle.requests[0];
		expect(transcript[0]).toMatchObject({ role: "system" });
		expect(transcript.at(-1)).toMatchObject({ role: "user" });
		expect(JSON.stringify(transcript.at(-1))).toContain("hello");

		// No handler error from the loaded copy.
		expect(handle.errors).toEqual([]);
		// The start persisted a session, so the resume seam has a file to open.
		expect(handle.sessionFile()).toMatch(/\.jsonl$/);
	});

	it("runs a tool call through pi's own tool loop", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "tool-loop", "proj"),
			responses: [
				fauxAssistantMessage([
					fauxText("checking"),
					fauxToolCall("lens_diagnostics", {}),
				]),
				fauxAssistantMessage(fauxText("done")),
			],
		});

		await handle.prompt("check this project");

		// The tool call took a second provider round trip, and pi sent the
		// result of the LOADED copy's tool back to the model.
		expect(handle.requests).toHaveLength(2);
		const second = handle.requests[1];
		expect(second.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"toolResult",
		]);
		const toolResult = second[3] as { content?: unknown; isError?: unknown };
		const resultText = textBlocks(toolResult.content).join("\n");
		// The diagnostics tool's own answer, not a value this test supplied.
		expect(resultText).toContain("No issues in the current turn delta.");
		expect(toolResult.isError).toBeFalsy();
	});

	it("waits on a reply that settles later, and sends its message as the answer", async () => {
		// #4943 R1: a case runs two sessions in a fixed interleaving by letting
		// one session's reply wait on the other's prompt. Recurrence prevented:
		// a host whose faux provider stops awaiting a reply factory hands pi the
		// pending promise in place of the scripted message, and the interleaving
		// in tests/index-4943-turn-end-delivery-slot.test.ts no longer runs.
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "async-reply", "proj"),
			responses: [
				async () => {
					await gate;
					return fauxAssistantMessage(fauxText("answered after the wait"));
				},
				fauxAssistantMessage(fauxText("second answer")),
			],
		});
		const first = handle.prompt("first question");
		release?.();
		await first;
		await handle.prompt("second question");

		const assistant = handle.requests[1].filter(
			(message) => message.role === "assistant",
		);
		expect(assistant.flatMap((message) => textBlocks(message.content))).toEqual(
			["answered after the wait"],
		);
	});

	// #4732: a case that drives a tool pi-lens has never met registers it
	// through pi's own `customTools`. Recurrence prevented: the option is
	// dropped on its way to `createAgentSessionFromServices`, and pi answers
	// the call as an unknown tool, so a witness of that tool observes nothing.
	it("runs a tool the case registers through pi's own tool loop", async () => {
		const cwd = path.join(fixture.root, "custom-tool", "proj");
		const ran: string[] = [];
		const handle = await startPiSession({
			root: fixture.root,
			cwd,
			customTools: [
				{
					name: "fixture_probe",
					label: "Fixture probe",
					description: "Record that pi ran it.",
					parameters: Type.Object({ tag: Type.String() }),
					async execute(toolCallId, params) {
						ran.push(`${toolCallId}:${(params as { tag: string }).tag}`);
						return {
							content: [{ type: "text", text: "probed" }],
							details: undefined,
						};
					},
				},
			],
			responses: [
				fauxAssistantMessage([fauxToolCall("fixture_probe", { tag: "t1" })]),
				fauxAssistantMessage(fauxText("done")),
			],
		});

		await handle.prompt("probe");

		// pi executed it with the arguments the model sent, under pi's own call
		// id, and answered the model with a successful tool result for it.
		expect(ran).toHaveLength(1);
		expect(ran[0]).toMatch(/^.+:t1$/);
		const toolResult = handle.requests[1]?.find(
			(message) => message.role === "toolResult",
		) as { toolName?: unknown; isError?: unknown } | undefined;
		expect(toolResult?.toolName).toBe("fixture_probe");
		expect(toolResult?.isError).toBeFalsy();
	});

	// #5120: a composition case loads another extension before or after the
	// built entry. Recurrence prevented: the paths are dropped or loaded in
	// another order, and a case that means "a guard after pi-lens" runs the
	// guard first, where pi-lens's rewrite never reaches it.
	it("loads extra extensions before and after the built entry, in that order", async () => {
		const cwd = path.join(fixture.root, "extra-extensions", "proj");
		fs.mkdirSync(cwd, { recursive: true });
		const log = path.join(fixture.root, "extra-extensions", "calls.log");
		const extension = (name: string): string => {
			const file = path.join(fixture.root, "extra-extensions", `${name}.mjs`);
			fs.writeFileSync(
				file,
				`import fs from "node:fs";\nexport default function (pi) {\n\tpi.on("tool_call", (event) => {\n\t\tfs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + ":" + event.toolName + "\\n");\n\t});\n}\n`,
			);
			return file;
		};
		const before = extension("before");
		const after = extension("after");
		const handle = await startPiSession({
			root: fixture.root,
			cwd,
			extraExtensions: { before: [before], after: [after] },
			responses: [
				fauxAssistantMessage([fauxToolCall("lens_diagnostics", {})]),
				fauxAssistantMessage(fauxText("done")),
			],
		});
		const paths = handle.session.extensionRunner.getExtensionPaths();
		expect(paths).toHaveLength(3);
		expect(paths[0]).toBe(before);
		expect(path.basename(paths[1] ?? "")).toBe("index.js");
		expect(paths[2]).toBe(after);

		await handle.prompt("check");

		expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
			"before:lens_diagnostics",
			"after:lens_diagnostics",
		]);
		await expect(
			outcome(
				startPiSession({
					root: fixture.root,
					cwd,
					extraExtensions: { after: [after] },
					inlineFactory: async () => () => {},
					responses: [],
				}),
			),
		).resolves.toContain("extraExtensions is path mode only");
	});

	it("reopens the persisted session file for the next turn", async () => {
		const first = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "resume", "proj"),
			responses: [fauxAssistantMessage(fauxText("first answer"))],
		});
		await first.prompt("first question");

		const resumed = await first.resume([
			fauxAssistantMessage(fauxText("second answer")),
		]);
		await resumed.prompt("second question");

		// pi restored the transcript from the file, then appended the new turn:
		// the resumed process sees the earlier conversation, which is the whole
		// point of the resume axis.
		const transcript = resumed.requests[0];
		expect(transcript.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"user",
		]);
		expect(textBlocks(transcript[1].content).join("\n")).toContain(
			"first question",
		);
		expect(textBlocks(transcript[2].content).join("\n")).toContain(
			"first answer",
		);
		expect(textBlocks(transcript[3].content).join("\n")).toContain(
			"second question",
		);
		// The resumed session continued the SAME conversation identity.
		expect(resumed.session.sessionManager.getSessionId()).toBe(
			first.session.sessionManager.getSessionId(),
		);
	});

	it("runs the loaded copy's shutdown handler when dispose() emits session_shutdown", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "tee", "proj"),
			responses: [fauxAssistantMessage(fauxText("ok"))],
		});
		await handle.prompt("hello");
		// The start registered this session as the process primary, in state the
		// LOADED copy's own graph holds (a `getProcessSingleton` cell, so this
		// graph reads the same one). Removing the emit from `dispose()` reds the
		// release below — and that, not the log row, is what separates "the
		// handler ran" from "a writer drained on its own": `flushAllNdjsonWriters`
		// reaches the same process-global sinks from either side, so the row
		// lands either way (#4664 F2).
		const sessionId = handle.session.sessionManager.getSessionId();
		expect(getActiveSessionId()).toBe(sessionId);

		await handle.dispose();

		expect(getActiveSessionId()).toBeUndefined();
		expect(getActivePrimaryRoot()).toBeUndefined();
		expect(handle.errors).toEqual([]);

		// The row the copy's writer queued is on disk under the home the copy
		// pinned — the sink a later case would read, settled when `dispose()`
		// returns. `latencyRows()` is the helper's own accessor: it flushes the
		// process-global writer map (the copy's writers are in it) and reads the
		// home the copy pinned, so no case has to spell either path.
		const rows = (await handle.latencyRows()).rows;
		expect(
			rows.some(
				(row) => (row as { phase?: string }).phase === "session_start_total",
			),
		).toBe(true);
	});

	it("reports a latency.log line it cannot parse instead of dropping it", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "latency-read", "proj"),
			responses: [fauxAssistantMessage(fauxText("ok"))],
		});
		await handle.prompt("hello");

		// `shape`: a clean run of the copy's own writers skips nothing, and the
		// rows are the ones it queued (a capability case for `latencyRows()`
		// itself, AGENTS.md's "a new tier capability adds a case first").
		const clean = await handle.latencyRows();
		expect(clean.skipped).toBe(0);
		expect(clean.rows.length).toBeGreaterThan(0);
		expect(clean.rows.some((row) => row.phase === "session_start_total")).toBe(
			true,
		);

		// Sourcery on #4699: a mangled row and a line cut mid-write were both
		// DROPPED, so an exact-count or absence assertion could not see a corrupt
		// record at all (`PROBE-A`/`PROBE-B2` in the review). The count is the
		// record, and the good rows beside a bad line are never lost (the
		// one-direction rule: a skip is not a licence to drop the fresh answer).
		const file = path.join(fixture.root, "home", "latency.log");
		const settled = fs.readFileSync(file);
		try {
			fs.appendFileSync(file, 'not a row\n{"phase":"memory_sam');
			const read = await handle.latencyRows();
			expect(read.skipped).toBe(2);
			expect(read.rows.length).toBeGreaterThanOrEqual(clean.rows.length);
		} finally {
			// The file is shared by every case in this file: put the bytes back, so
			// a corrupt line this case planted cannot red a neighbour.
			fs.writeFileSync(file, settled);
		}
	});

	// #4724: pi read the real `$HOME/.agents/skills`, so a host's skills reached
	// every request and a prefix-ratio verdict differed between hosts.
	it("keeps the host's own skills out of the session's system prompt", async () => {
		// pinFixtureHome pins HOME and USERPROFILE to a home beside the worker's
		// scratch root, never inside a fixture root the harness deletes (#4591).
		const { home, restore } = pinFixtureHome("4729-host-skills");
		const skill = path.join(home, ".agents", "skills", "host-only-probe");
		fs.mkdirSync(skill, { recursive: true });
		fs.writeFileSync(
			path.join(skill, "SKILL.md"),
			"---\nname: host-only-probe\ndescription: A skill only this host has.\n---\n\nBody.\n",
		);
		try {
			const handle = await startPiSession({
				root: fixture.root,
				cwd: path.join(fixture.root, "host-skills", "proj"),
				responses: [fauxAssistantMessage(fauxText("ok"))],
			});
			await handle.prompt("hello");
			const system = handle.requests[0]?.[0];
			expect(system).toMatchObject({ role: "system" });
			expect(JSON.stringify(system)).not.toContain("host-only-probe");
		} finally {
			restore();
		}
	});

	it("refuses a manual compaction the fixture transcript is too small for", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "compact", "proj"),
			responses: [fauxAssistantMessage(fauxText("ok"))],
		});
		await handle.prompt("hello");

		// pi's compaction entry point is reachable from this tier and answers
		// through its own precondition (`prepareCompaction`); a case that wants
		// a real summary needs a transcript past that threshold, which the
		// fixture-sized sessions this batch runs are not.
		await expect(handle.compact()).rejects.toThrow("Nothing to compact");
	});

	it("injects its session-start guidance through the provider request", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "guidance", "proj"),
			responses: [fauxAssistantMessage(fauxText("ok"))],
		});
		await handle.prompt("hello");

		// The guidance pi-lens staged at `session_start` reaches the model on
		// the first request — appended to the prompt, not as its own message.
		const transcript = handle.requests[0];
		expect(transcript).toHaveLength(2);
		const blocks = textBlocks(transcript[1].content);
		expect(blocks[0]).toBe("hello");
		expect(blocks[1]).toContain(INJECTION_DELIMITER);
		expect(blocks[1]).toContain("pi-lens active");
	});

	it("replaces the session: the old conversation ends, and the next one starts empty under a new id", async () => {
		const first = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "replace", "proj"),
			responses: [fauxAssistantMessage(fauxText("first answer"))],
		});
		await first.prompt("first question");
		const firstId = first.session.sessionManager.getSessionId();
		const firstFile = first.sessionFile();
		expect(getActiveSessionId()).toBe(firstId);

		const second = await first.restart({ reason: "new" }, [
			fauxAssistantMessage(fauxText("second answer")),
		]);
		const secondId = second.session.sessionManager.getSessionId();

		// A replacement is a DIFFERENT conversation: pi minted a new session id,
		// so nothing that keys on the session identity can cross it by accident.
		expect(secondId).not.toBe(firstId);
		// The old conversation's own state was released, and the new one binds its
		// own provider script.
		expect(second.requests).toHaveLength(0);
		expect(second.errors).toEqual([]);

		// The new conversation starts empty: pi restored nothing from the old
		// session file, which is still on disk under the first id.
		await second.prompt("second question");
		expect(second.requests[0].map((message) => message.role)).toEqual([
			"system",
			"user",
		]);
		expect(fs.readFileSync(firstFile ?? "", "utf8")).toContain("first answer");
	});

	it("starts the replacement as a primary once the old session's shutdown named it", async () => {
		// pi's own teardown runs the old session's `session_shutdown` handler
		// with `targetSessionFile`, which leaves the primary slot pending for
		// that successor; the next start claims it. Nothing process-wide is
		// reset, because pi resets nothing (round 1 did, to make up for a
		// shutdown event without `targetSessionFile`: #4692 H2). This is also
		// the witness that the shutdown RAN: without it the old primary stays a
		// live member, and pi-lens's #473 classifier declines the next start as
		// a `concurrent-secondary`, so the active id stays the old one.
		const first = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "replace-primary", "proj"),
			responses: [fauxAssistantMessage(fauxText("one"))],
		});
		await first.prompt("hello");
		const firstId = first.session.sessionManager.getSessionId();

		const second = await first.restart({ reason: "new" }, [
			fauxAssistantMessage(fauxText("two")),
		]);
		await second.prompt("hello again");
		const secondId = second.session.sessionManager.getSessionId();

		// The replacement took the primary slot the previous conversation left.
		expect(secondId).not.toBe(firstId);
		expect(getActiveSessionId()).toBe(secondId);
		expect(normalizeFilePath(getActivePrimaryRoot() ?? "")).toBe(
			normalizeFilePath(path.join(fixture.root, "replace-primary", "proj")),
		);
		expect(second.errors).toEqual([]);
	});

	it("refuses a replacement it cannot run through pi, and a restart of a handle already replaced", async () => {
		const first = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "replace-refused", "proj"),
			responses: [fauxAssistantMessage(fauxText("one"))],
		});
		await first.prompt("hello");
		const firstId = first.session.sessionManager.getSessionId();

		// A reason with no pi entry point here fails closed BEFORE pi tears the
		// session down: no synthesised event, and the session stays live.
		expect(
			await outcome(first.restart({ reason: "quit" } as never, [])),
		).toContain("no faithful replacement");
		expect(getActiveSessionId()).toBe(firstId);

		// A handle being replaced cannot be restarted beside it: the overlapping
		// call would build a second replacement while the first is still in
		// flight (Sourcery T3). Its own message names that state, so this
		// assertion cannot be satisfied by the stale handle's refusal.
		const pending = first.restart({ reason: "new" }, [
			fauxAssistantMessage(fauxText("two")),
		]);
		expect(await outcome(first.restart({ reason: "new" }, []))).toContain(
			"restart() while that session is being replaced",
		);
		// A replaced handle cannot be restarted again: that would build a third
		// session beside the live replacement and take its identity (#4692 L2).
		// Its message is the other state's, so the two guards are distinguishable.
		const second = await pending;
		const secondId = second.session.sessionManager.getSessionId();
		expect(secondId).not.toBe(firstId);
		expect(await outcome(first.restart({ reason: "new" }, []))).toContain(
			"restart() on a session that already ended",
		);
		expect(getActiveSessionId()).toBe(secondId);
	});

	it("runs a second live session in one root as a concurrent secondary", async () => {
		// The documented multi-session shape: a second `startPiSession` under
		// another cwd of the SAME fixture root is a separate extension load, and
		// the process-global guard classifies it `concurrent-secondary` while the
		// first session stays the registered primary (#4632 slice 5 consumes
		// this). Each handle is its own activation; what they share is the
		// process-scoped session state.
		const primary = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "second-live", "primary"),
			responses: [fauxAssistantMessage(fauxText("ok"))],
		});
		const primaryId = primary.session.sessionManager.getSessionId();
		const secondary = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "second-live", "secondary"),
			responses: [fauxAssistantMessage(fauxText("ok"))],
		});

		expect(secondary.session.sessionManager.getSessionId()).not.toBe(primaryId);
		expect(getActiveSessionId()).toBe(primaryId);
		expect(getSecondarySessionCount()).toBe(1);

		await secondary.dispose();
		expect(getActiveSessionId()).toBe(primaryId);
		expect(getSecondarySessionCount()).toBe(0);
		await primary.dispose();
		expect(getActiveSessionId()).toBeUndefined();
	});

	it("pins the startup mode the loaded copy reports", async () => {
		// The third production mode has no warm-up timer and no deferred load,
		// so it is the one mode whose config resolution runs ONLY through the
		// ensure path (slice 5's minimal-mode cell depends on that). The row the
		// loaded copy writes is the assertion: the env pin and the mode the
		// extension observes are the same value.
		const cwd = path.join(fixture.root, "minimal-mode", "proj");
		const handle = await startPiSession({
			root: fixture.root,
			cwd,
			startupMode: "minimal",
			responses: [fauxAssistantMessage(fauxText("ok"))],
		});
		// `handle.latencyRows()` flushes this side's writer map, then reads through
		// the shared `readNdjsonRows`; `skipped` is the record of a line the reader
		// could not parse, and a count assertion built on a short read is a red.
		const read = await handle.latencyRows();
		expect(read.skipped, "a torn line would shorten this read").toBe(0);
		// The row is written through `normalizeLoggedPath`, so the comparison uses
		// the same fold; `cwd` carries native separators on win32.
		const rows = read.rows.filter(
			(row) =>
				row.phase === "session_start_total" &&
				row.filePath === normalizeFilePath(cwd),
		);
		expect(rows).toHaveLength(1);
		const metadata = rows[0]?.metadata as { mode?: string } | undefined;
		expect(metadata?.mode).toBe("minimal");
		await handle.dispose();
	});

	it("owns every scanner report directory a session's background scans create", async () => {
		// #4632 slice 7 round 2. A `session_start` scanner (jscpd, the ast-grep
		// exports pass, ...) creates its report directory under
		// `scannerReportParentDir()` and removes it in the scan's own `finally`.
		// The scan is fire-and-forget, and `drainBackgroundWritesForTests()`
		// (#4505) reaches only THIS process's copy of the resident clients: the
		// loaded copy owns its own (header, point 1), so a worker that ends before
		// the scan settles strands the directory. Measured on a host pre-push: two
		// `pi-lens-jscpd-*` entries sat in the shared tmp root, attributed to the
		// slice-7 ordering file. The seam's own contract (`scanner-temp-root.ts`)
		// is that a harness owning a root points `PI_LENS_TEST_SCANNER_TMPDIR` at
		// it, so an orphan lands inside the root the harness removes.
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "scanner-root", "proj"),
			responses: [fauxAssistantMessage(fauxText("ok"))],
		});
		await handle.prompt("hello");

		// The resolver the loaded copy's scanners call, read through this side's
		// copy of it: the environment is shared, and the copy cleared VITEST
		// (`PI_LENS_TEST_MODE=0`), so the scanner-only harness marker is what lets
		// the override through at all.
		const parent = scannerReportParentDir();
		expect(parent, "the scanner report parent is the fixture's own").toBe(
			path.join(fixture.root, "scanner-tmp"),
		);
		// Created with the pin, so `mkdtempSync` in the scan has a parent to
		// write under even when the file's first scan starts immediately.
		expect(fs.existsSync(parent)).toBe(true);
	});

	it("pins the tool-loadout declaration pi builds for a request", async () => {
		// #4632 acceptance 4, recurrence acceptance 3: the dynamic-tooling cases
		// moved by slice 6 read the active tool set, so the host's declaration of
		// it is pinned here BEFORE any consumer uses it. `toolsAdded` /
		// `toolsRemoved` are not fields of an ExtensionAPI event
		// (`core/extensions/types.d.ts` carries only `getActiveTools` /
		// `setActiveTools`): they are system messages pi's agent loop writes into
		// the transcript, and a `context_with_system` handler is handed them for
		// the request it answers (the `context` phase strips system messages).
		// The case pins all three seams a consumer can reach: the host's own API,
		// the model-visible request, and the handler-visible transcript.
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "tool-loadout", "proj"),
			responses: [
				fauxAssistantMessage([
					fauxText("activating"),
					fauxToolCall("pi_lens_activate_tools", {
						tools: ["ast_grep_search"],
					}),
				]),
				fauxAssistantMessage(fauxText("ready")),
				fauxAssistantMessage(fauxText("ready")),
			],
		});
		const runner = handle.session.extensionRunner;
		const emitContext = vi.spyOn(runner, "emitContext");
		try {
			// The load-time set, before the activation below changes it.
			const initialActive = runner.getActiveTools();
			await handle.prompt("activate the search tool");

			const active = runner.getActiveTools();
			expect(active).toContain("ast_grep_search");
			expect(active).not.toEqual(initialActive);
			const head = handle.requests[0][0] as {
				role: string;
				toolsAdded?: Array<{
					name: string;
					description?: unknown;
					parameters?: unknown;
				}>;
				toolsRemoved?: unknown;
			};
			// The first request declares the WHOLE active set, each tool with the
			// schema the host sends (a name-only double cannot see a schema drift).
			expect(head.role).toBe("system");
			expect(head.toolsRemoved).toBeUndefined();
			expect(head.toolsAdded?.map((tool) => tool.name)).toEqual(initialActive);
			for (const tool of head.toolsAdded ?? []) {
				expect(tool.description).toBeTypeOf("string");
				expect(tool.parameters).toBeTypeOf("object");
			}

			// An activation in a later request declares a DELTA: the added tool only,
			// no removal. A consumer that reads this must fold it onto the head.
			const activationDelta = systemMessages(handle.requests[1]).at(-1) as {
				toolsAdded?: Array<{ name: string }>;
				toolsRemoved?: unknown;
			};
			expect(activationDelta.toolsAdded?.map((tool) => tool.name)).toEqual([
				"ast_grep_search",
			]);
			expect(activationDelta.toolsRemoved).toBeUndefined();

			// A shrink declares a removal in the same shape, and the replayed tool
			// state equals what the host's own API answers.
			handle.session.setActiveToolsByName(
				runner.getActiveTools().filter((name) => name !== "symbol_search"),
			);
			await handle.prompt("second turn");
			const shrinkDelta = systemMessages(handle.requests[2]).at(-1) as {
				toolsAdded?: unknown;
				toolsRemoved?: Array<{ name: string }>;
			};
			expect(shrinkDelta.toolsRemoved?.map((tool) => tool.name)).toEqual([
				"symbol_search",
			]);
			expect(shrinkDelta.toolsAdded).toBeUndefined();
			expect(replayToolNames(handle.requests[2])).toEqual(
				runner.getActiveTools(),
			);

			// The seam a handler reads: the request's own delta is in the messages
			// `emitContext` is handed, not only in the provider's copy.
			const handed = emitContext.mock.calls.at(-1)?.[0] as Array<
				Record<string, unknown>
			>;
			const handedLast = systemMessages(
				handed as Array<{ role: string; [key: string]: unknown }>,
			).at(-1) as {
				toolsRemoved?: Array<{ name: string }>;
			};
			expect(handedLast?.toolsRemoved?.map((tool) => tool.name)).toEqual([
				"symbol_search",
			]);
		} finally {
			emitContext.mockRestore();
		}
	});

	it("hands the provider the model's compat facts and switches models through pi's own setModel", async () => {
		// #4687 item 7: the tier capability lands before its consumers. pi-ai's
		// fauxProvider drops `compat` from its model definitions, so the helper
		// sets it on the model object pi is handed; this case pins that the fact
		// reaches the PROVIDER (the model a reply factory is called with) and that
		// `switchModel` goes through `AgentSession.setModel`, which emits
		// `model_select`. Recurrence: a case asserting a per-model decision on a
		// model that silently carries no compat, so every cell reads "unknown".
		const seen: Array<{ id?: unknown; compat?: unknown }> = [];
		const reply =
			(text: string) =>
			(
				_context: unknown,
				_options: unknown,
				_state: unknown,
				model: unknown,
			) => {
				const typed = model as { id?: unknown; compat?: unknown };
				seen.push({ id: typed.id, compat: typed.compat });
				return fauxAssistantMessage(fauxText(text));
			};
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "model-compat", "proj"),
			modelCompat: {},
			responses: [reply("first"), reply("second")],
		});
		const runner = handle.session.extensionRunner;
		const emit = vi.spyOn(runner, "emit");
		try {
			await handle.prompt("first question");
			await handle.switchModel({ supportsMidConvoSystemMessages: true });
			await handle.prompt("second question");
			const selected = emit.mock.calls
				.map(([event]) => event as { type: string; model?: { id?: unknown } })
				.filter((event) => event.type === "model_select")
				.map((event) => event.model?.id);
			expect(selected).toEqual(["faux-2"]);
		} finally {
			emit.mockRestore();
		}

		expect(seen).toEqual([
			{ id: "faux-1", compat: {} },
			{ id: "faux-2", compat: { supportsMidConvoSystemMessages: true } },
		]);
	});

	it("gives the default model the faux provider's real mid-conversation system support", async () => {
		// The faux provider answers from the raw transcript and never folds
		// system messages into one head, so its honest fact is `true`; a case
		// that needs a collapsing model passes `modelCompat: {}` (above).
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "model-default-compat", "proj"),
			responses: [],
		});
		expect(
			(handle.session.model as { compat?: unknown } | undefined)?.compat,
		).toEqual({ supportsMidConvoSystemMessages: true });
	});

	it("records what the copy asks the host's UI to show", async () => {
		// #4632 acceptance 6: the capability lands BEFORE its consumers. A case that
		// asserts what pi-lens asks the USER to see (the smells rollup's note, the
		// LSP status line) cannot read a handler's return value: the message leaves
		// through `ctx.ui.notify`, which is the host's own boundary. The helper
		// binds a real `ExtensionUIContext` (`bindExtensions`), and `/lens-toggle`
		// is the smallest production path that notifies — the same command the
		// `real-ui-harness` row pins on the double.
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "ui-recorder", "proj"),
			captureUi: true,
			responses: [
				fauxAssistantMessage(fauxText("ready")),
				fauxAssistantMessage(fauxText("ready")),
			],
		});

		expect(handle.notifications).toEqual([]);
		await handle.prompt("hello");
		expect(handle.notifications).toEqual([]);

		// pi dispatches the extension command from the prompt text, so the command
		// runs against pi's real ctx — the mode is `tui`, so `notifyUi` renders
		// instead of logging the suppression.
		await handle.prompt("/lens-toggle");
		expect(handle.notifications).toEqual([
			{
				message:
					"pi-lens disabled for this session. Run /lens-toggle again to resume.",
				type: "warning",
			},
		]);
	});

	describe("inline-factory mode (#4937 L6)", () => {
		/**
		 * A prototype spy is the discriminator: the path load builds its OWN copy of
		 * `clients/read-guard.ts` (consequence 1), so a spy on THIS graph's class is
		 * called only when the extension runs on this graph's modules. Recurrence
		 * it prevents: a file moved to tier 2 for a `vi.mock` or a spy and an
		 * inline mode that quietly loaded by path would pass every assertion that
		 * does not read the spy, and the moved file would test nothing.
		 */
		async function readOnce(
			slug: string,
			inline: boolean,
		): Promise<{ spyCalls: number; modelSawFile: boolean }> {
			const cwd = path.join(fixture.root, slug, "proj");
			fs.mkdirSync(cwd, { recursive: true });
			const target = path.join(cwd, "inline-target.ts");
			fs.writeFileSync(target, "export const inlineTarget = 4937;\n");
			const spy = vi.spyOn(ReadGuard.prototype, "recordRead");
			try {
				const handle = await startPiSession({
					root: fixture.root,
					cwd,
					...(inline
						? {
								inlineFactory: async () =>
									(await import("../../index.js")).default,
							}
						: {}),
					responses: [
						fauxAssistantMessage([
							fauxText("reading"),
							fauxToolCall("read", { path: target }),
						]),
						fauxAssistantMessage(fauxText("done")),
					],
				});
				await handle.prompt("read it");
				expect(handle.errors).toEqual([]);
				return {
					spyCalls: spy.mock.calls.length,
					// The control: the read itself ran in both modes.
					modelSawFile: JSON.stringify(handle.requests.at(-1)).includes(
						"inlineTarget = 4937",
					),
				};
			} finally {
				spy.mockRestore();
			}
		}

		// One session per case: the helper's `afterEach` disposes the first arm's
		// session, so the second is not classified a concurrent secondary and
		// declined (a single case holding both sessions recorded 0 calls on the
		// inline arm).
		it("runs the extension on the module copies pi's own loader builds by default", async () => {
			expect(await readOnce("inline-off", false)).toEqual({
				spyCalls: 0,
				modelSawFile: true,
			});
		});

		it("runs the extension on this test graph's modules when handed a factory", async () => {
			const inline = await readOnce("inline-on", true);
			expect(inline.modelSawFile).toBe(true);
			expect(inline.spyCalls).toBeGreaterThan(0);
		});

		it("resolves the factory after the env pins, so a first import reads the pinned home", async () => {
			// Recurrence: `index.js` and its clients read `PI_LENS_HOME` when they
			// first load. A loader called before the pins would import them against
			// the maintainer's real home and write there.
			let homeAtImport: string | undefined;
			// An earlier case in this file already pinned the same home, so the
			// variable is cleared: only a pin made BY this start can satisfy the read.
			vi.stubEnv("PI_LENS_HOME", undefined);
			try {
				await startPiSession({
					root: fixture.root,
					cwd: path.join(fixture.root, "inline-pin", "proj"),
					inlineFactory: async () => {
						homeAtImport = process.env.PI_LENS_HOME;
						return (await import("../../index.js")).default;
					},
					responses: [fauxAssistantMessage(fauxText("ready"))],
				});
			} finally {
				vi.unstubAllEnvs();
			}
			expect(homeAtImport).toBe(path.join(fixture.root, "home"));
		});
	});

	it("refuses a second fixture root in one file", async () => {
		// A session under a SECOND fixture root writes into the FIRST root's home
		// and nothing into its own — measured: 78 `session_start` rows against 0
		// — while its own fixture path still gets a `home/` directory. The helper
		// fails closed instead of running a case that observes nothing. Where the
		// copy binds that first home is not isolated, and it is demonstrably NOT
		// `clients/probe-home-state.ts`, which re-reads `PI_LENS_HOME` per call
		// (#4664 F4).
		await expect(
			startPiSession({
				root: path.join(fixture.root, "a-second-root"),
				responses: [fauxAssistantMessage(fauxText("never"))],
			}),
		).rejects.toThrow("one fixture root per test file");
	});
});
