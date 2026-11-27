/**
 * #5770: `contextInjection.retain` defaults to on for the `anthropic-messages`
 * API and stays off for every other one; an explicit setting wins either way.
 *
 * Recurrence prevented: retained injections only helped users who found the
 * opt-in, so an anthropic session kept paying a prompt-cache miss from the
 * message after every injection (the #4743 recurrence) unless it knew the
 * flag. The default must follow the model's API at each request, not the API
 * at load: pi can switch models in a session, and a default decided once at
 * load would keep answering for the model the session started on.
 *
 * Every cell runs a real `AgentSession` through `tests/support/pi-session.ts`
 * and reads what the PROVIDER received: the finding is staged once, so the
 * request after the injecting one carries it again only when retained.
 *
 * Does not prove: a real Anthropic transport. The scripted provider answers
 * whatever `api` label the model object carries; what is pinned is that
 * pi-lens reads the label off `ctx.model` per request.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { snapshotAdvisoryProvenance } from "../clients/advisory-provenance.js";
import { CacheManager } from "../clients/cache-manager.js";
import { flushAllNdjsonWriters } from "../clients/ndjson-logger.js";
import { RuntimeCoordinator } from "../clients/runtime-coordinator.js";
import {
	fauxAssistantMessage,
	type PiProviderRequest,
	type PiSession,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

const ANTHROPIC = "anthropic-messages";
const OPENAI = "openai-completions";
const MARKER = "RETAIN_DEFAULT_5770_FINDING";
const DEFAULT_ROW = "context_injection_retain_default";

afterEach(() => {
	vi.unstubAllEnvs();
});

/** Stage the turn-end finding the next request consumes, once. */
function seedFinding(cwd: string, marker: string): void {
	const file = path.join(cwd, `unchanged-${marker}.ts`);
	fs.writeFileSync(file, "export const unchanged = true;\n");
	new CacheManager().writeCache(
		"turn-end-findings",
		{
			content: `${marker} blocking finding`,
			provenance: snapshotAdvisoryProvenance({
				cwd,
				runtime: new RuntimeCoordinator(),
				generation: 1,
				files: [{ path: file, role: "affected" }],
			}),
		},
		cwd,
	);
}

const count = (request: PiProviderRequest, marker = MARKER): number =>
	JSON.stringify(request).split(marker).length - 1;

/** An explicit `contextInjection.retain` in the global config the session loads. */
function stubConfig(name: string, retain: boolean): void {
	const configPath = path.join(fixture.root, `${name}-config.json`);
	fs.writeFileSync(
		configPath,
		JSON.stringify({ contextInjection: { retain } }),
	);
	vi.stubEnv("PI_LENS_CONFIG_PATH", configPath);
}

async function start(
	name: string,
	options: {
		api?: string;
		flags?: ReadonlyMap<string, boolean>;
		prompts: number;
	},
): Promise<PiSession> {
	const cwd = path.join(fixture.root, name, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	return startPiSession({
		root: fixture.root,
		cwd,
		startupMode: "quick",
		...(options.api ? { modelApi: options.api } : {}),
		...(options.flags ? { flags: options.flags } : {}),
		responses: Array.from({ length: options.prompts }, (_, index) =>
			fauxAssistantMessage(`answer ${index}`),
		),
	});
}

/**
 * Warm turn, injecting turn, then one quiet turn: the injecting request must
 * carry the finding, and the quiet one carries it again only when retained.
 */
async function injectThenQuiet(
	handle: PiSession,
): Promise<{ injecting: PiProviderRequest; quiet: PiProviderRequest }> {
	await handle.prompt("first question");
	seedFinding(handle.cwd, MARKER);
	await handle.prompt("second question");
	await handle.prompt("third question");
	const [, injecting, quiet] = handle.requests;
	return { injecting, quiet };
}

async function defaultRows(handle: PiSession) {
	await flushAllNdjsonWriters();
	const { rows, skipped } = await handle.latencyRows();
	expect(skipped).toBe(0);
	const sessionId = handle.session.sessionManager.getSessionId();
	return rows.filter(
		(row) =>
			row.phase === DEFAULT_ROW &&
			(row.metadata as { sessionId?: string } | undefined)?.sessionId ===
				sessionId,
	);
}

describe("#5770 contextInjection.retain defaults by the request's API", () => {
	it("retains on anthropic-messages when nothing is set, and records the default once", async () => {
		const handle = await start("anthropic-default", {
			api: ANTHROPIC,
			prompts: 3,
		});
		try {
			const { injecting, quiet } = await injectThenQuiet(handle);
			expect(count(injecting)).toBe(1);
			expect(count(quiet)).toBe(1);
			// One row for the session, though three requests resolved the default.
			const rows = await defaultRows(handle);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.phase).toBe("context_injection_retain_default");
			expect(rows[0]?.metadata).toMatchObject({ api: ANTHROPIC });
		} finally {
			await handle.dispose();
		}
	}, 60_000);

	it("does not retain on openai-completions when nothing is set", async () => {
		const handle = await start("openai-default", { api: OPENAI, prompts: 3 });
		try {
			const { injecting, quiet } = await injectThenQuiet(handle);
			expect(count(injecting)).toBe(1);
			expect(count(quiet)).toBe(0);
			expect(await defaultRows(handle)).toHaveLength(0);
		} finally {
			await handle.dispose();
		}
	}, 60_000);

	it("does not retain when the model names no recognised API", async () => {
		// The faux model carries its own random `faux:` API label, which no
		// default names; `anthropic-messages-v2` is a near miss, not the API.
		const unnamed = await start("unknown-api", { prompts: 3 });
		const nearMiss = await start("near-miss-api", {
			api: "anthropic-messages-v2",
			prompts: 3,
		});
		try {
			for (const handle of [unnamed, nearMiss]) {
				const { injecting, quiet } = await injectThenQuiet(handle);
				expect(count(injecting)).toBe(1);
				expect(count(quiet)).toBe(0);
				expect(await defaultRows(handle)).toHaveLength(0);
			}
		} finally {
			await nearMiss.dispose();
			await unnamed.dispose();
		}
	}, 60_000);

	it("an explicit contextInjection.retain: false wins on anthropic-messages", async () => {
		stubConfig("explicit-false", false);
		const handle = await start("anthropic-explicit-false", {
			api: ANTHROPIC,
			prompts: 3,
		});
		try {
			const { injecting, quiet } = await injectThenQuiet(handle);
			expect(count(injecting)).toBe(1);
			expect(count(quiet)).toBe(0);
			expect(await defaultRows(handle)).toHaveLength(0);
		} finally {
			await handle.dispose();
		}
	}, 60_000);

	it("an explicit contextInjection.retain: true wins on openai-completions", async () => {
		stubConfig("explicit-true", true);
		const handle = await start("openai-explicit-true", {
			api: OPENAI,
			prompts: 3,
		});
		try {
			const { injecting, quiet } = await injectThenQuiet(handle);
			expect(count(injecting)).toBe(1);
			expect(count(quiet)).toBe(1);
			// The setting decided it, so the API default is not what is recorded.
			expect(await defaultRows(handle)).toHaveLength(0);
		} finally {
			await handle.dispose();
		}
	}, 60_000);

	it("--lens-retain-injections retains on openai-completions", async () => {
		const handle = await start("openai-flag", {
			api: OPENAI,
			flags: new Map([["lens-retain-injections", true]]),
			prompts: 3,
		});
		try {
			const { quiet } = await injectThenQuiet(handle);
			expect(count(quiet)).toBe(1);
			expect(await defaultRows(handle)).toHaveLength(0);
		} finally {
			await handle.dispose();
		}
	}, 60_000);

	it("follows a mid-session switch from anthropic-messages to openai-completions", async () => {
		const handle = await start("switch-away", { api: ANTHROPIC, prompts: 4 });
		try {
			await handle.prompt("first question");
			seedFinding(handle.cwd, MARKER);
			await handle.prompt("second question");
			await handle.prompt("third question");
			// Control: the anthropic session repeats the finding.
			expect(count(handle.requests[2])).toBe(1);

			await handle.switchModel({}, OPENAI);
			await handle.prompt("fourth question");
			// The new model's default is off, so nothing is re-sent to it.
			expect(count(handle.requests[3])).toBe(0);
		} finally {
			await handle.dispose();
		}
	}, 60_000);

	it("follows a mid-session switch from openai-completions to anthropic-messages", async () => {
		const handle = await start("switch-toward", { api: OPENAI, prompts: 5 });
		try {
			await handle.prompt("first question");
			seedFinding(handle.cwd, MARKER);
			await handle.prompt("second question");
			// Control: on openai the finding reached its one request only.
			await handle.prompt("third question");
			expect(count(handle.requests[2])).toBe(0);

			await handle.switchModel({}, ANTHROPIC);
			const later = "RETAIN_DEFAULT_5770_AFTER_SWITCH";
			seedFinding(handle.cwd, later);
			await handle.prompt("fourth question");
			await handle.prompt("fifth question");
			expect(count(handle.requests[3], later)).toBe(1);
			expect(count(handle.requests[4], later)).toBe(1);
		} finally {
			await handle.dispose();
		}
	}, 60_000);
});
