/**
 * Analyzer-bootstrap warm/first-use liveness — #2467, extending #1394.
 *
 * The #1394 lesson this file exists for: a lazified subsystem that silently
 * stops firing is worse than a slow one. So every "did NOT load" assertion
 * here is paired with a "still loads when a consumer needs it" assertion
 * against the same seam, and both run through `index.ts`'s real registrations
 * — the extension the host actually activates, not a hand-built handler.
 *
 * The seam is spied rather than replaced: the double resolves the same client
 * set through the same loader, so a case cannot pass because the double
 * quietly answered differently from production.
 *
 * TIER 2 (#4937 L6). Every case runs the extension inside a real pi
 * `AgentSession` (`tests/support/pi-session.ts`, inline-factory mode), so the
 * seam it spies is the one pi's own `session_start`, `tool_call` and turn loop
 * call: the file hand-emitted those events on the pi double before. The
 * `vi.doMock` of `clients/bootstrap.js` is registered before the factory import
 * the helper makes, which is the one thing the path load could not do.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	endTurn,
	readTarget,
	step,
} from "../support/pi-session-commit-gate.js";
import {
	fauxToolCall,
	piSessionFixture,
	startPiSession,
	type PiFauxReply,
	type PiSession,
} from "../support/pi-session.js";

/** Every demand made on the bootstrap seam, in order, with its stated reason. */
const demands: string[] = [];

/**
 * The demands that were actually SERVED with clients.
 *
 * A demand that answers `null` still appears in `demands` — the caller asked
 * — but the analyzers behind it never ran. Distinguishing the two is the
 * whole point of #1394's lesson: "the scan was requested" and "the scan
 * happened" are different facts, and only the second one is liveness.
 */
const served: string[] = [];

/** Stub clients that answer "nothing available" for every analyzer. */
function stubClients(): Record<string, unknown> {
	return {
		todoScanner: { scanDirectory: () => ({ items: [] }) },
		biomeClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		ruffClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		knipClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
			analyze: async () => ({ success: false, summary: "", issues: [] }),
		},
		jscpdClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		depChecker: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		govulncheckClient: { ensureAvailable: async () => false },
		gitleaksClient: { ensureAvailable: async () => false },
		trivyClient: { ensureAvailable: async () => false },
		opengrepClient: { ensureAvailable: async () => false },
		deadCodeClients: [],
		testRunnerClient: { detectRunner: () => null },
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		agentBehaviorClient: { recordToolCall: () => [], formatWarnings: () => "" },
		complexityClient: {
			// Supported, so the tool_call baseline branch is genuinely armed: a
			// double that answered "unsupported" would make the liveness case
			// pass without the branch ever asking for a client.
			isSupportedFile: (file: string) => file.endsWith(".ts"),
			analyzeFile: async () => null,
		},
	};
}

/** What `startSpied` hands back beside the session. */
interface Spied {
	readonly handle: PiSession;
	/** The demands on the seam when the factory returned, before any session event. */
	readonly demandsAfterFactory: readonly string[];
	/**
	 * The demands made INSIDE each `tool_call` hook, in order, one entry per
	 * event. pi runs the whole turn around a tool call (`tool_result`,
	 * `turn_end`), and those hooks load the clients legitimately; the claims
	 * below are about the `tool_call` hook alone.
	 */
	readonly toolCallWindows: readonly (readonly string[])[];
}

/**
 * Install the counting seam and start a real session behind it. The factory is
 * wrapped so the demand count is read the moment it returns: pi emits
 * `session_start` only after that, so the count is activation's alone.
 */
async function startSpied(options: {
	cwd: string;
	startupMode: "quick" | "full";
	responses?: readonly PiFauxReply[];
	flags?: ReadonlyMap<string, boolean | string>;
	/**
	 * Runs after the module graph is reset and the seam is mocked, before the
	 * session starts: a module it imports is the copy the extension will use.
	 */
	prepare?: () => Promise<void>;
}): Promise<Spied> {
	vi.resetModules();
	demands.length = 0;
	served.length = 0;
	vi.doMock("../../clients/bootstrap.js", async () => {
		const { bootstrapSeamMock } = await import("../support/bootstrap-mock.js");
		const seam = bootstrapSeamMock(async () => stubClients());
		return {
			...seam,
			loadBootstrapClients: () => {
				demands.push("load");
				return seam.loadBootstrapClients();
			},
			requestBootstrapClients: async (options?: {
				reason?: string;
				signal?: AbortSignal;
			}) => {
				const reason = options?.reason ?? "?";
				demands.push(`request:${reason}`);
				// The double honours the signal exactly as production does, so a
				// caller that binds the wrong one is visible HERE rather than
				// only in production.
				const clients = await seam.requestBootstrapClients(
					options as { reason: string; signal?: AbortSignal },
				);
				if (clients) served.push(reason);
				return clients;
			},
		};
	});
	// The concurrent-session registry lives behind `getProcessSingleton`, so
	// `vi.resetModules()` does NOT clear it (AGENTS.md shape 25). Without this,
	// the second case's session_start in a different temp cwd classifies
	// `secondary-root`, declines, and never runs the handler at all — every
	// "did not load" assertion would then pass for the wrong reason.
	const { _resetSessionLifecycleForTests } =
		await import("../../clients/session-lifecycle.js");
	_resetSessionLifecycleForTests();
	await options.prepare?.();
	let demandsAfterFactory: readonly string[] = [];
	const toolCallWindows: string[][] = [];
	const handle = await startPiSession({
		root: fixture.root,
		cwd: options.cwd,
		startupMode: options.startupMode,
		responses: options.responses ?? [endTurn()],
		...(options.flags ? { flags: options.flags } : {}),
		inlineFactory: async () => {
			const { default: registerExtension } = await import("../../index.js");
			return (pi) => {
				// Two probe handlers bracket pi-lens's own `tool_call` handlers:
				// pi runs one extension's handlers in registration order, so the
				// slice between them is what the hook asked of the seam.
				let windowStart = 0;
				pi.on("tool_call", () => {
					windowStart = demands.length;
				});
				registerExtension(pi);
				demandsAfterFactory = [...demands];
				pi.on("tool_call", () => {
					toolCallWindows.push(demands.slice(windowStart));
				});
			};
		},
	});
	return { handle, demandsAfterFactory, toolCallWindows };
}

/** A project directory of its own under the file's one fixture root. */
function project(slug: string): string {
	const cwd = path.join(fixture.root, slug, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	return cwd;
}

afterEach(() => {
	// resetModules does not clear the mock registry (#2883).
	vi.doUnmock("../../clients/bootstrap.js");
	vi.resetModules();
});

const fixture = piSessionFixture();

describe("#2467 — activation never loads the analyzer bootstrap", () => {
	it("registers every host surface without one demand on the seam", async () => {
		const { handle, demandsAfterFactory } = await startSpied({
			cwd: project("activate"),
			startupMode: "quick",
		});
		// The registrations really happened — otherwise "no demands" would be
		// satisfied by an activation that did nothing at all (shape 7).
		// The extension runner's own tool list, not the session's: the session
		// also counts pi's built-in tools, so a count there passes with nothing
		// of pi-lens registered.
		expect(
			handle.session.extensionRunner
				.getAllRegisteredTools()
				.map((tool) => tool.definition.name),
		).toEqual(expect.arrayContaining(["lens_diagnostics", "ast_grep_search"]));
		expect(handle.session.extensionRunner.hasHandlers("tool_call")).toBe(true);
		expect(handle.session.extensionRunner.hasHandlers("session_start")).toBe(
			true,
		);
		expect(demandsAfterFactory).toEqual([]);
	}, 30_000);
});

describe("#2467 — session start pays only for what it uses", () => {
	it("quick mode completes without loading the analyzer graph", async () => {
		const { handle } = await startSpied({
			cwd: project("quick"),
			startupMode: "quick",
		});
		// Quick mode is the process's FIRST session — the start the user is
		// waiting on — and it uses none of these clients.
		expect(handle.errors).toEqual([]);
		expect(demands).toEqual([]);
	}, 30_000);

	it("full mode still reaches the analyzers, on demand", async () => {
		const cwd = project("full");
		fs.writeFileSync(path.join(cwd, "index.ts"), "export const a = 1;\n");
		const { handle } = await startSpied({ cwd, startupMode: "full" });
		expect(handle.errors).toEqual([]);
		// The liveness half: lazification must not mean "never".
		expect(demands.some((d) => d.startsWith("request:session-start"))).toBe(
			true,
		);
	}, 60_000);
});

describe("#2467 — session-start demands are not turn-scoped", () => {
	it("a leftover aborted turn signal does not cancel the startup scans", async () => {
		// A `session_start` can land mid-turn (sequential replacement, /new), so
		// the ambient signal of the turn that is being torn down is still
		// installed when the handler runs. Binding it to the deferred scans
		// meant the whole session silently ran with no todo/dead-code/knip/jscpd
		// scan and no retry — #1394's exact lesson.
		const cwd = project("stale");
		fs.writeFileSync(path.join(cwd, "index.ts"), "export const a = 1;\n");
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({ name: "stale-signal-fixture", version: "0.0.0" }),
		);
		let clearSignal: () => void = () => undefined;
		try {
			const { handle } = await startSpied({
				cwd,
				startupMode: "full",
				// The signal goes on the safe-spawn copy the extension will import:
				// one imported before the reset would be a second copy.
				prepare: async () => {
					const { setAmbientAbortSignal } =
						await import("../../clients/safe-spawn.js");
					const stale = new AbortController();
					stale.abort();
					setAmbientAbortSignal(stale.signal);
					clearSignal = () => setAmbientAbortSignal(undefined);
				},
			});
			expect(handle.errors).toEqual([]);
			// Not merely "the demand was made" — EVERY demand was SERVED, so the
			// scan and probe bodies behind them actually ran. Pre-fix the demands
			// are identical and `served` is empty: the aborted signal made every
			// one of them answer `null`, and nothing retries.
			const requested = demands
				.filter((d) => d.startsWith("request:"))
				.map((d) => d.slice("request:".length));
			expect(requested.length).toBeGreaterThan(0);
			expect(served).toEqual(requested);
			expect(served).toContain("session-start-tool-probes");
		} finally {
			clearSignal();
		}
	}, 60_000);
});

/**
 * One scripted turn over a quick-started session: what the `tool_call` hook
 * itself asked of the seam, across `calls` scripted calls.
 */
async function demandsOfOneToolCall(
	slug: string,
	call: (cwd: string) => Record<string, unknown>,
	prepare?: (cwd: string) => void,
	flags?: ReadonlyMap<string, boolean | string>,
	calls = 1,
): Promise<{ handle: PiSession; turnDemands: string[] }> {
	const cwd = project(slug);
	prepare?.(cwd);
	const { handle, toolCallWindows } = await startSpied({
		cwd,
		startupMode: "quick",
		responses: [
			...Array.from({ length: calls }, () => step(call(cwd))),
			endTurn(),
		],
		...(flags ? { flags } : {}),
	});
	await handle.prompt("go");
	expect(handle.errors).toEqual([]);
	// The hook ran once per scripted call: a window count short of that would
	// make an empty answer vacuous.
	expect(toolCallWindows).toHaveLength(calls);
	return { handle, turnDemands: toolCallWindows.flat() };
}

describe("#2467 — tool_call loads only for a branch that needs it", () => {
	it("an irrelevant tool call neither loads nor awaits the graph", async () => {
		const { turnDemands } = await demandsOfOneToolCall("bash", () =>
			fauxToolCall("bash", { command: "echo hi" }),
		);
		expect(turnDemands).toEqual([]);
	}, 30_000);

	it("a read of a vendored file neither loads nor awaits the graph", async () => {
		// A `node_modules` read is the shape the pre-fix code paid the whole
		// seventeen-module load for and then threw away: `isExternalOrVendor` is
		// the very next check after the load it used to sit above. The bash case
		// above returns before that point, so it cannot see this defect at all.
		const { turnDemands } = await demandsOfOneToolCall(
			"vendor",
			(cwd) =>
				readTarget(path.join(cwd, "node_modules", "left-pad", "index.ts")),
			(cwd) => {
				const vendorDir = path.join(cwd, "node_modules", "left-pad");
				fs.mkdirSync(vendorDir, { recursive: true });
				fs.writeFileSync(
					path.join(vendorDir, "index.ts"),
					"export const pad = 1;\n",
				);
			},
			new Map([["no-complexity", false]]),
		);
		expect(turnDemands).toEqual([]);
	}, 30_000);

	it("a read of an unsupported file type never demands the graph", async () => {
		// A markdown read resolves to a real, in-project, non-vendored path, so
		// every cheap guard admits it — and then the complexity client answers
		// "unsupported" and no baseline is ever produced. Because a baseline is
		// what memoizes the file, the demand fires again on EVERY later read of
		// it. Docs, JSON, YAML, CSS, Java, shell: the whole non-analyzed
		// majority of a repo used to pay the seventeen-module load per read.
		// Twice, because the never-cached half of the defect only shows on the
		// second read.
		const { turnDemands } = await demandsOfOneToolCall(
			"markdown",
			(cwd) => readTarget(path.join(cwd, "README.md")),
			(cwd) => fs.writeFileSync(path.join(cwd, "README.md"), "# readme\n"),
			new Map([["no-complexity", false]]),
			2,
		);
		expect(turnDemands).toEqual([]);
	}, 30_000);

	it("a bootstrap-dependent tool call does demand the clients", async () => {
		const { turnDemands } = await demandsOfOneToolCall(
			"sample",
			(cwd) => readTarget(path.join(cwd, "sample.ts")),
			(cwd) =>
				fs.writeFileSync(
					path.join(cwd, "sample.ts"),
					"export const sample = 1;\n",
				),
			new Map([["no-complexity", false]]),
		);
		expect(turnDemands).toContain("request:tool-call-complexity-baseline");
	}, 30_000);
});
