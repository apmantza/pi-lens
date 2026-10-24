/**
 * #4682: the session-start orientation names the situational tools and tells
 * the model how to reach them. That activation clause must hold under every
 * `tools.lazy` posture, on the REAL host (`tests/support/pi-session.ts`, tier 2).
 *
 * With `tools.lazy: false` the situational tools are already declared to the
 * model, so "activate via pi_lens_activate_tools" describes a state that never
 * happens. Under `"auto"` the posture is decided per model at session_start, so
 * the one text rendered at that moment must be true for both outcomes. The
 * clause is one literal under every posture, so the text does not depend on the
 * posture at all (the renderer receives no posture input).
 *
 * Recurrence each case names: the orientation bullet asserts "activate via
 * pi_lens_activate_tools" while the tools are already active (tools.lazy=false,
 * and auto on a model that gets every tool from the start).
 *
 * Every case reads what the provider was sent (`handle.requests`) and what the
 * host holds (`getActiveTools`); no value comes from this file's own setup.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	fauxAssistantMessage,
	fauxText,
	piSessionFixture,
	startPiSession,
	type PiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

const READY = fauxAssistantMessage(fauxText("ready"));
/** The five lazy tools; the bullet must name every enabled one (#4682). */
const LAZY_TOOLS = [
	"ast_grep_search",
	"ast_grep_replace",
	"ast_grep_outline",
	"lsp_navigation",
	"lens_diagnostic_mark",
];
/** A model without the fact: pi-ai collapses its system messages (auto is eager). */
const COLLAPSING: Readonly<Record<string, unknown>> = {};
/** A model that keeps mid-list system messages (auto is lazy). */
const MID_CONVO: Readonly<Record<string, unknown>> = {
	supportsMidConvoSystemMessages: true,
};
/** The one clause every posture must render (the literal, not a regex). */
const CLAUSE = "activate via pi_lens_activate_tools if unlisted";

interface Posture {
	readonly name: string;
	readonly lazy: boolean | "auto";
	readonly modelCompat: Readonly<Record<string, unknown>>;
	/** Whether every lazy tool is active from the first turn. */
	readonly eager: boolean;
}

const POSTURES: readonly Posture[] = [
	{
		name: "tools.lazy true",
		lazy: true,
		modelCompat: MID_CONVO,
		eager: false,
	},
	{
		name: "tools.lazy false",
		lazy: false,
		modelCompat: MID_CONVO,
		eager: true,
	},
	{
		name: "tools.lazy auto on a collapsing model (eager)",
		lazy: "auto",
		modelCompat: COLLAPSING,
		eager: true,
	},
	{
		name: "tools.lazy auto on a mid-convo model (lazy)",
		lazy: "auto",
		modelCompat: MID_CONVO,
		eager: false,
	},
];

function projectRoot(...segments: string[]): string {
	return path.join(fixture.root, ...segments, "proj");
}

function activeTools(handle: PiSession): string[] {
	return handle.session.extensionRunner.getActiveTools();
}

/**
 * Run `body` with `PI_LENS_CONFIG_PATH` naming a global config file under the
 * fixture. The loaded copy reads the global config at its own factory run, so
 * the session must start inside `body`; the `finally` restores the variable.
 */
async function withGlobalConfig(
	slug: string,
	config: Record<string, unknown>,
	body: () => Promise<void>,
): Promise<void> {
	const configPath = path.join(fixture.root, "global", slug, "config.json");
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify(config));
	const previous = process.env.PI_LENS_CONFIG_PATH;
	process.env.PI_LENS_CONFIG_PATH = configPath;
	try {
		await body();
	} finally {
		if (previous === undefined) delete process.env.PI_LENS_CONFIG_PATH;
		else process.env.PI_LENS_CONFIG_PATH = previous;
	}
}

/** The text of one provider request, as its JSON, for literal searches. */
function requestText(request: unknown): string {
	return JSON.stringify(request);
}

/** The parenthetical of the situational bullet the model was sent, or undefined. */
function situationalClause(request: unknown): string | undefined {
	const match = /Situational \(([^)]*)\)/.exec(requestText(request));
	return match?.[1];
}

/** The tool names the situational bullet lists, as the model was sent them. */
function situationalNames(request: unknown): string[] {
	const match = /Situational \([^)]*\): ([^.]*)\./.exec(requestText(request));
	return match ? match[1].split(", ") : [];
}

describe("the situational orientation is true under every tools.lazy posture (#4682)", () => {
	it.each(POSTURES)(
		"$name: the bullet's clause is the one posture-independent literal",
		async (posture) => {
			const slug = posture.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
			await withGlobalConfig(
				`4682-${slug}`,
				{ tools: { lazy: posture.lazy } },
				async () => {
					const handle = await startPiSession({
						root: fixture.root,
						cwd: projectRoot("4682", slug),
						modelCompat: posture.modelCompat,
						responses: [READY, READY, READY],
					});

					// The posture the host really applied. The clause must describe it.
					for (const tool of LAZY_TOOLS) {
						if (posture.eager) {
							expect(activeTools(handle), tool).toContain(tool);
						} else {
							expect(activeTools(handle), tool).not.toContain(tool);
						}
					}

					await handle.prompt("first question");
					const first = handle.requests[0];
					expect(first, "first request").toBeDefined();
					// The orientation is staged at session_start and reaches the model.
					expect(requestText(first)).toContain("pi-lens active");

					// The clause names the loader only for an UNLISTED tool, so it is
					// true whichever posture the session holds: under an eager posture
					// every tool is listed and nothing needs activating. The literal is
					// the same under every posture.
					expect(situationalClause(first)).toBe(CLAUSE);
					// Every enabled lazy tool is named, whatever the posture (#4682 F1).
					expect([...situationalNames(first)].sort()).toEqual(
						[...LAZY_TOOLS].sort(),
					);
					expect(requestText(first)).not.toContain(
						"Situational (activate via pi_lens_activate_tools)",
					);

					// No later-turn assertion: the orientation is a request-local `context`
					// message consumed on first read (clients/runtime-context.ts), so
					// turn-2 and turn-3 requests never carry it and a comparison there
					// cannot fail (PR #4730 review F2). The turn-1 checks above are the
					// whole proof of what this PR changes.
				},
			);
		},
	);
});
