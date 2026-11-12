/**
 * #4913: a command-line flag value reaches the decisions `index.ts` takes.
 *
 * RECURRENCE THIS FILE PREVENTS. pi applies the command-line values of an
 * extension's flags AFTER every extension factory has run
 * (`agent-session-services.js` `applyExtensionFlagValues`, called from
 * `createAgentSessionServices` once the resource loader has loaded the
 * factories), so `pi.getFlag` inside the factory answers the registered
 * default. `index.ts` read `no-lens`, `no-lens-context`, `lens-compact-tool-line`
 * and `--no-tool` in the factory, and `pi --no-lens` still ran language
 * servers and write-time runners. The pi double (`tests/support/pi-mock.ts`)
 * applied flag values BEFORE the factory ran, which is why no test saw it.
 *
 * Every case here is tier 2 (`tests/support/pi-session.ts`): the built
 * extension in a real `AgentSession`, flags handed to pi's own
 * `extensionFlagValues`, which pi applies after the factory exactly as the CLI
 * does. Each case has a CONTROL session that runs the same script without the
 * flag, so an absence is read against a presence the same script produced.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	BLOCKING_FILE,
	endTurn,
	step,
	toolResults,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import {
	type PiFauxReply,
	type PiMessage,
	type PiSession,
	fauxToolCall,
	piSessionFixture,
	replayToolNames,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

/**
 * #5399: the fixture home holds one file — the orphan-backstop cooldown stamp,
 * the shape the #5294 rejected variant seeded — BEFORE this file's first
 * `session_start`, in every case order. The cloud flaky-test routine reported
 * the `/lens-toggle` case red 4/4 in exactly this state (`lsp_touch_file`
 * absent for the post-toggle edit); the routine, two reviewers, the pi 1.5.0 /
 * Node 24 control host and 20+ runs on the dev host (load-saturated, cold
 * jiti cache, `--sequence.shuffle`) never turned the red, and no consumer in
 * `session_start` lists the home's entries — the shipped harness itself holds
 * `orphan-backstop.json` in the home at every later `session_start`. So the
 * premise is not reproducible, and this plant pins the claim as behaviour:
 * every case below, and the named `#5399` cell in particular, must register
 * the lens seams with a file in the home from the first start. If an
 * environment ever proves the claim, this file reddens naming it.
 */
{
	const stamp = path.join(fixture.root, "home", "orphan-backstop.json");
	fs.mkdirSync(path.dirname(stamp), { recursive: true });
	fs.writeFileSync(stamp, JSON.stringify({ lastSweepAt: Date.now() }));
}

/** The bundled `debugger-statement` rule's message, as `write` reports it. */
const BLOCKER_TEXT = "debugger_statement";

/** A project of its own under the file's one fixture root. */
function project(slug: string): string {
	const proj = path.join(fixture.root, slug, "proj");
	fs.mkdirSync(proj, { recursive: true });
	return proj;
}

/** Every text block of one transcript, as one string. */
function transcriptText(transcript: readonly PiMessage[]): string {
	return JSON.stringify(transcript);
}

describe("#4913: --no-lens reaches the lens decision pi makes after the factory", () => {
	/**
	 * A project whose TypeScript server is a command that does not exist: a
	 * session that reaches the language-server seam records a launch attempt
	 * (`lsp_launch_candidate_attempt`) and one that never does records none, so
	 * the claim reads pi-lens's own launch record, with no child process.
	 */
	function lspProject(slug: string): string {
		const proj = project(slug);
		fs.writeFileSync(
			path.join(proj, "package.json"),
			'{"name":"synthetic-4913","private":true}\n',
		);
		fs.mkdirSync(path.join(proj, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(proj, ".pi-lens", "lsp.json"),
			JSON.stringify({
				serverOverrides: {
					typescript: {
						command: [path.join(proj, "missing-server"), "--stdio"],
					},
				},
				disabledServers: ["ast-grep", "zizmor", "typos", "deno", "opengrep"],
				warmFiles: ["no-such-warm-file.ts"],
			}),
		);
		fs.writeFileSync(path.join(proj, "b.ts"), "export const b = 1;\n");
		return proj;
	}

	/** The records the dispatch and language-server seams write for an edit. */
	const LENS_WORK_PHASES = ["dispatch_start", "lsp_touch_file"];

	/**
	 * The lens-work rows written since `after` rows of that kind existed. The
	 * file's sessions share one home, so `latency.log` accumulates every
	 * earlier case's rows: a case reads its own by the count at its start.
	 */
	async function lensWorkRows(handle: PiSession, after = 0): Promise<string[]> {
		const read = await handle.latencyRows();
		expect(read.skipped, "every latency row parsed").toBe(0);
		return read.rows
			.map((row) => String(row.phase))
			.filter((phase) => LENS_WORK_PHASES.includes(phase))
			.slice(after);
	}

	/** The text the model received as the result of its `write`. */
	function writeResult(handle: PiSession): string {
		return toolResults(handle.requests.at(-1) ?? [], "write")
			.map((result) => result.text)
			.join("\n");
	}

	/** Read, then write a blocking file, then end the turn. */
	async function readThenEdit(
		slug: string,
		flags: Array<[string, boolean]>,
	): Promise<{ handle: PiSession; rows: string[] }> {
		const proj = lspProject(slug);
		const target = path.join(proj, "b.ts");
		const handle = await startPiSession({
			root: fixture.root,
			cwd: proj,
			// LSP on: this claim is that `--no-lens` keeps the servers down.
			flags: new Map<string, boolean>([["no-lsp", false], ...flags]),
			responses: [
				step(fauxToolCall("read", { path: target }), "reading"),
				step(writeTarget(target, BLOCKING_FILE), "writing"),
				endTurn("done"),
			],
		});
		const before = (await lensWorkRows(handle)).length;
		await handle.prompt("edit b.ts");
		return { handle, rows: await lensWorkRows(handle, before) };
	}

	it("runs the dispatch and language-server seams when the flag is absent (control)", async () => {
		const { handle, rows } = await readThenEdit("lens-on", []);
		expect(handle.errors).toEqual([]);
		expect(rows).toEqual(expect.arrayContaining(LENS_WORK_PHASES));
		expect(writeResult(handle)).toContain(BLOCKER_TEXT);
	});

	it("starts no language server and runs no write-time runner on a read or an edit under --no-lens", async () => {
		const { handle, rows } = await readThenEdit("lens-off", [
			["no-lens", true],
		]);
		expect(handle.errors).toEqual([]);
		expect(rows, "no dispatch and no language-server touch").toEqual([]);
		expect(
			writeResult(handle),
			"the write result carries no lens finding",
		).not.toContain(BLOCKER_TEXT);
		// The write itself still ran: the file holds the model's content.
		expect(fs.readFileSync(path.join(handle.cwd, "b.ts"), "utf-8")).toContain(
			"debugger",
		);
	});

	it("lets /lens-toggle turn a session started with --no-lens back on", async () => {
		const proj = lspProject("lens-off-toggled");
		const target = path.join(proj, "b.ts");
		const handle = await startPiSession({
			root: fixture.root,
			cwd: proj,
			flags: new Map<string, boolean>([
				["no-lsp", false],
				["no-lens", true],
			]),
			responses: [
				step(writeTarget(target, BLOCKING_FILE), "writing"),
				endTurn("done"),
			],
		});
		const before = (await lensWorkRows(handle)).length;
		// pi runs the registered command; the toggle flips the session's state.
		await handle.prompt("/lens-toggle");
		await handle.prompt("edit b.ts");
		expect(handle.errors).toEqual([]);
		expect(await lensWorkRows(handle, before)).toEqual(
			expect.arrayContaining(LENS_WORK_PHASES),
		);
		expect(writeResult(handle)).toContain(BLOCKER_TEXT);
	});

	// #5399: the same toggle cycle with the home planted before the file's
	// first `session_start` (plant at the file head). The claimed cloud red was
	// this edit registering no `lsp_touch_file`; the cell pins the acceptance —
	// `/lens-toggle` registers the dispatch and language-server seams whatever
	// the home holds at the first start.
	it("lets /lens-toggle register the lens seams with the home planted before the first start (#5399)", async () => {
		const proj = lspProject("lens-off-toggled-home-planted");
		const target = path.join(proj, "b.ts");
		const handle = await startPiSession({
			root: fixture.root,
			cwd: proj,
			flags: new Map<string, boolean>([
				["no-lsp", false],
				["no-lens", true],
			]),
			responses: [
				step(writeTarget(target, BLOCKING_FILE), "writing"),
				endTurn("done"),
			],
		});
		const before = (await lensWorkRows(handle)).length;
		await handle.prompt("/lens-toggle");
		await handle.prompt("edit b.ts");
		expect(handle.errors).toEqual([]);
		expect(await lensWorkRows(handle, before)).toEqual(
			expect.arrayContaining(LENS_WORK_PHASES),
		);
		expect(writeResult(handle)).toContain(BLOCKER_TEXT);
	});
});

describe("#4913: --no-lens-context reaches the context hook", () => {
	/** The pi-lens injection blocks one request carries, in order. */
	function injections(transcript: readonly PiMessage[]): string[] {
		return transcript
			.filter((message) => message.role === "user")
			.map((message) => transcriptText([message]))
			.filter((text) => text.includes("[pi-lens automated"));
	}

	/** Every injection across the requests from `from` on, as one string. */
	function injectedSince(handle: PiSession, from: number): string {
		return handle.requests
			.slice(from)
			.flatMap((request) => injections(request))
			.join("\n");
	}

	const FINDING = "Debugger statement";

	function script(target: string): PiFauxReply[] {
		return [
			step(writeTarget(target, BLOCKING_FILE), "writing"),
			endTurn("turn 1 done"),
			step(writeTarget(target, BLOCKING_FILE), "writing again"),
			endTurn("turn 2 done"),
		];
	}

	it("delivers the turn-end finding to the model when the flag is absent (control)", async () => {
		const proj = project("ctx-on");
		const handle = await startPiSession({
			root: fixture.root,
			cwd: proj,
			responses: script(path.join(proj, "b.ts")),
		});
		await handle.prompt("write b.ts");
		expect(injectedSince(handle, 0)).toContain(FINDING);
	});

	it("injects nothing under --no-lens-context, then injects after /lens-context-toggle", async () => {
		const proj = project("ctx-off");
		const handle = await startPiSession({
			root: fixture.root,
			cwd: proj,
			flags: new Map<string, boolean>([["no-lens-context", true]]),
			responses: script(path.join(proj, "b.ts")),
		});
		await handle.prompt("write b.ts");
		expect(handle.requests.length, "turn 1 made its requests").toBeGreaterThan(
			1,
		);
		expect(
			injectedSince(handle, 0),
			"no pi-lens block rode any request while the flag is on",
		).toBe("");

		const before = handle.requests.length;
		await handle.prompt("/lens-context-toggle");
		await handle.prompt("write b.ts again");
		expect(handle.requests.length).toBeGreaterThan(before);
		expect(injectedSince(handle, before)).toContain(FINDING);
		expect(handle.errors).toEqual([]);
	});
});

describe("#4913: --lens-compact-tool-line reaches tool registration", () => {
	type Component = { render(width: number): string[] };
	type Renderers = {
		renderCall?: (args: unknown, theme: unknown, context: unknown) => Component;
		renderResult?: (
			result: unknown,
			options: unknown,
			theme: unknown,
			context: unknown,
		) => Component;
	};

	/** The registered definition pi holds for one pi-lens tool. */
	function registered(handle: PiSession, name: string): Renderers {
		const entry = handle.session.extensionRunner
			.getAllRegisteredTools()
			.find((tool) => tool.definition.name === name);
		if (!entry) throw new Error(`pi holds no registered tool ${name}`);
		return entry.definition as unknown as Renderers;
	}

	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const settled = {
		args: { mode: "all" },
		toolCallId: "x",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/repo",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
	};

	it("registers the original definitions when the flag is absent (control)", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: project("compact-off"),
			responses: [],
		});
		const tool = registered(handle, "lens_diagnostics");
		expect(tool.renderCall, "no renderCall is added").toBeUndefined();
		expect(tool.renderResult, "the tool keeps its own renderResult").toBeTypeOf(
			"function",
		);
	});

	it("registers the compact renderers under --lens-compact-tool-line", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: project("compact-on"),
			flags: new Map<string, boolean>([["lens-compact-tool-line", true]]),
			responses: [],
		});
		const tool = registered(handle, "lens_diagnostics");
		expect(tool.renderCall).toBeTypeOf("function");
		// The call row blanks once a settled result exists (collapsed).
		expect(
			tool.renderCall?.({ mode: "all" }, theme, settled).render(80),
		).toEqual([]);
		const lines =
			tool
				.renderResult?.(
					{
						content: [],
						details: { mode: "all", totalBlocking: 0, filesWithIssues: 0 },
					},
					{ expanded: false, isPartial: false },
					theme,
					settled,
				)
				.render(200) ?? [];
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("lens_diagnostics");
		// Registering the wrapped copies kept the lazy-tools posture.
		expect(handle.session.extensionRunner.getActiveTools()).not.toContain(
			"lsp_navigation",
		);
	});
});

describe("#4913: --no-tool reaches the tool set pi holds", () => {
	const ALWAYS_ACTIVE = "symbol_search";
	const LAZY = "ast_grep_search";

	it("keeps every tool when the flag is absent (control)", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: project("tool-on"),
			responses: [endTurn("hello")],
		});
		await handle.prompt("hello");
		expect(handle.session.extensionRunner.getActiveTools()).toContain(
			ALWAYS_ACTIVE,
		);
		expect(replayToolNames(handle.requests[0] ?? [])).toContain(ALWAYS_ACTIVE);
	});

	/**
	 * The `tool_set_mutation` rows stamped at or after `since`. The file's
	 * sessions share one `latency.log` and CI's shuffle step reorders the
	 * cases, so a case reads only what its own session wrote (#4917: under
	 * `--sequence.seed=2` another case's `--no-tool` row reached this one).
	 */
	async function mutationsSince(
		handle: PiSession,
		since: string,
	): Promise<Array<Record<string, unknown>>> {
		const read = await handle.latencyRows();
		expect(read.skipped, "every latency row parsed").toBe(0);
		return read.rows
			.filter(
				(row) => row.phase === "tool_set_mutation" && String(row.ts) >= since,
			)
			.map((row) => row.metadata as Record<string, unknown>);
	}

	/** The counts the lazy posture's session-start rows removed. */
	const lazyRemovedCounts = (rows: Array<Record<string, unknown>>) =>
		rows
			.filter((m) => m.reason === "fresh_session_lazy_deactivation")
			.map((m) => m.removedCount);

	it("drops a tool named by `--no-tool <name>` from the set the model is offered", async () => {
		// The control runs inside this case, so the comparison below does not
		// depend on which case ran first.
		const controlSince = new Date().toISOString();
		const control = await startPiSession({
			root: fixture.root,
			cwd: project("tool-off-control"),
			responses: [endTurn("hello")],
		});
		await control.prompt("hello");
		const controlLazy = lazyRemovedCounts(
			await mutationsSince(control, controlSince),
		);
		expect(controlLazy, "the control's lazy posture row").toHaveLength(1);
		const since = new Date().toISOString();
		const handle = await startPiSession({
			root: fixture.root,
			cwd: project("tool-off"),
			flags: new Map<string, string>([["no-tool", ALWAYS_ACTIVE]]),
			responses: [endTurn("hello")],
		});
		await handle.prompt("hello");
		expect(handle.session.extensionRunner.getActiveTools()).not.toContain(
			ALWAYS_ACTIVE,
		);
		const offered = replayToolNames(handle.requests[0] ?? []);
		expect(offered).not.toContain(ALWAYS_ACTIVE);
		// Only the named tool goes.
		expect(offered).toContain("lens_diagnostics");
		// #4917 F3: the removal has its own record, and the lazy posture's row
		// does not count it (the control's row and this session's row agree).
		const mutations = await mutationsSince(handle, since);
		expect(
			mutations.filter((m) => m.reason === "policy_disabled_tool"),
			"one row for the one tool the flag named",
		).toEqual([expect.objectContaining({ removedCount: 1, addedCount: 0 })]);
		expect(
			lazyRemovedCounts(mutations),
			"the lazy posture removes the same tools with and without the flag",
		).toEqual(controlLazy);
	});

	it("writes no empty lazy-posture row when the flag is the only change", async () => {
		// #4917 F3: with lazy tools off the posture changes nothing, so the only
		// row this session writes is the flag's own.
		const since = new Date().toISOString();
		const handle = await startPiSession({
			root: fixture.root,
			cwd: project("tool-off-not-lazy"),
			flags: new Map<string, boolean | string>([
				["no-tool", ALWAYS_ACTIVE],
				["no-lazy-tools", true],
			]),
			responses: [endTurn("hello")],
		});
		await handle.prompt("hello");
		expect(await mutationsSince(handle, since)).toEqual([
			expect.objectContaining({
				reason: "policy_disabled_tool",
				removedCount: 1,
				addedCount: 0,
			}),
		]);
	});

	it("does not let pi_lens_activate_tools bring back a situational tool the flag named", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: project("tool-off-lazy"),
			flags: new Map<string, string>([["no-tool", LAZY]]),
			responses: [
				step(
					fauxToolCall("pi_lens_activate_tools", { tools: [LAZY] }),
					"activating",
				),
				endTurn("done"),
			],
		});
		await handle.prompt("activate the search tool");
		expect(handle.session.extensionRunner.getActiveTools()).not.toContain(LAZY);
	});
});
