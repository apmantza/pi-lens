/**
 * #5361 r3: the `tool_set_mutation` deferral field states whether the host
 * sends this model's tools natively or deferred, for EVERY path pi-ai uses to
 * decide that.
 *
 * Round 3 opens with the state table (PR body, `STATE_TABLE.md`): a grep census
 * over `pi-ai/dist/api/*.js` on three installed hosts (pi-0.86.1, pi-1.4.0,
 * pi-1.5.0) enumerates every place that decides how tools reach the model. Four
 * of those paths do NOT resend the full tool list, so the predicate has to carry
 * four arms; the table's rows are cited per arm below.
 *   A `api/openai-responses.js:242` → `getResponsesToolSupport`
 *     (`api/openai-responses-shared.js:73-77`, shared with azure and codex):
 *     `compat.supportsToolSearch` selects "additions" support, where
 *     `resolveTranscriptTools` (`utils/transcript.js:208`) keeps only the folded
 *     prefix in the request's tool field.
 *   B `api/anthropic-messages.js:897`: `nativeToolChanges` is
 *     `supportsMidConvoSystemMessages && supportsMidConvoToolChanges`, and the
 *     request then carries the initial tools plus a deferred placeholder
 *     (`:951`).
 *   C `api/openai-responses-shared.js:74-75`: the same helper returns "changes"
 *     for `supportsMidConvoSystemMessages && supportsAdditionalTools`, and
 *     `resolveTranscriptTools` returns `requestTools: []` for "changes" — every
 *     tool arrives in `additional_tools` items.
 *   D `api/openai-completions.js:551-553`: "additions" for
 *     `supportsMidConvoSystemMessages && supportsMidConvoToolAdditions`.
 * A model matching no row gets the current tool list on every request (rows 2
 * and 5, and `google-generative-ai.js:282`, `google-vertex.js:352`,
 * `bedrock-converse-stream.js:151`, `mistral-conversations.js:376`), so the
 * field is false for it honestly.
 *
 * The guard reads the host install's OWN catalog
 * (`<pi-ai>/dist/providers/all.js`, `getBuiltinProviders` +
 * `getBuiltinModels` — the export the 0.86.1 floor also has, review r2 F5) and
 * selects its models by the compat shape, never by an id that a catalog refresh
 * may drop. Recurrence it names: pi renames a compat flag or moves an arm's
 * gate, and the field silently reports false on a host that supports the
 * capability — #5361 itself read the 0.80-era `supportsToolReferences`; r1 read
 * only the OpenAI tool-search arm; and r2 still missed the "changes" arm and the
 * `openai-completions` arm, which is 50 catalog models on pi-1.5.0. A case that
 * hand-shaped its own compat object could not notice any of that (review r1 F2),
 * which is why these cases read real model objects and a real session row.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { supportsDeferredTools } from "../clients/tool-set-policy.js";
import { flushAllNdjsonWriters } from "../clients/ndjson-logger.js";
import { readNdjsonRows } from "./support/ndjson-rows.js";
import {
	fauxAssistantMessage,
	fauxText,
	piAiPackageDir,
	piSessionFixture,
	startPiSession,
	drainPiSessionWrites,
} from "./support/pi-session.js";
import { withGlobalConfig } from "./support/global-config.js";

const fixture = piSessionFixture();
const READY = fauxAssistantMessage(fauxText("ready"));

/** The compat cells these decision paths read, as the host spells them. */
interface HostCompat {
	supportsToolSearch?: boolean;
	supportsMidConvoSystemMessages?: boolean;
	supportsMidConvoToolChanges?: boolean;
	supportsAdditionalTools?: boolean;
	supportsMidConvoToolAdditions?: boolean;
}

interface HostModel {
	id: string;
	provider: string;
	api?: string;
	compat?: HostCompat;
}

/**
 * One state-table row in which the host does NOT resend the full tool list,
 * spelled as the compat shape that selects it. This list is derived from the
 * table (each row's `pi-ai` file:line is in the header), NOT from the predicate:
 * an arm missing here cannot hide behind the "matches no row" cell either,
 * because the row's own case then has no population to assert on the host.
 */
const DEFERRING_ROWS: ReadonlyArray<{
	name: string;
	why: string;
	matches: (compat: HostCompat) => boolean;
}> = [
	{
		name: "the Responses-family tool-search arm (table row 4)",
		why: 'getResponsesToolSupport returns "additions" for supportsToolSearch, so the request holds only the folded prefix',
		matches: (compat) => compat.supportsToolSearch === true,
	},
	{
		name: "the Anthropic native tool-change arm (table row 1)",
		why: "nativeToolChanges needs mid-convo system messages AND tool changes, and then the request holds initial tools plus the deferred placeholder",
		matches: (compat) =>
			compat.supportsMidConvoSystemMessages === true &&
			compat.supportsMidConvoToolChanges === true,
	},
	{
		name: 'the Responses-family "changes" arm (table row 3)',
		why: 'getResponsesToolSupport returns "changes" for mid-convo system messages AND supportsAdditionalTools, and resolveTranscriptTools sends requestTools: [] with every tool in additional_tools items',
		matches: (compat) =>
			compat.supportsMidConvoSystemMessages === true &&
			compat.supportsAdditionalTools === true,
	},
	{
		name: "the chat-completions tool-additions arm (table row 8)",
		why: 'openai-completions.js passes "additions" for mid-convo system messages AND supportsMidConvoToolAdditions, so later tools are anchored at their system message',
		matches: (compat) =>
			compat.supportsMidConvoSystemMessages === true &&
			compat.supportsMidConvoToolAdditions === true,
	},
];

/** The host install's built-in model catalog, or a loud failure. */
async function hostCatalog(): Promise<HostModel[]> {
	const entry = path.join(piAiPackageDir(), "dist", "providers", "all.js");
	if (!fs.existsSync(entry))
		throw new Error(
			`pi-ai at ${piAiPackageDir()} carries no dist/providers/all.js, so its built-in model catalog cannot be read (#5361 r2)`,
		);
	const loaded = (await import(pathToFileURL(entry).href)) as {
		getBuiltinProviders?(): string[];
		getBuiltinModels?(provider: string): HostModel[];
	};
	// `getBuiltinModels` is the export all three certified hosts have;
	// `getAllBuiltinModels` (1.4.0+) also folds in the image and classifier
	// catalogs, which no conversation loop selects (review r2 F5).
	if (
		typeof loaded.getBuiltinProviders !== "function" ||
		typeof loaded.getBuiltinModels !== "function"
	)
		throw new Error(
			`${entry} exports neither getBuiltinProviders nor getBuiltinModels, so the #5361 catalog guard cannot run on this host`,
		);
	const models: HostModel[] = [];
	for (const provider of loaded.getBuiltinProviders())
		models.push(...loaded.getBuiltinModels(provider));
	// A catalog that came back empty would make every population assertion
	// below vacuously true, so it fails here instead.
	expect(models.length, `${entry} produced no model objects`).toBeGreaterThan(
		0,
	);
	return models;
}

/** `provider/id` for a model, for a readable assertion message. */
function name(model: HostModel): string {
	return `${model.provider}/${model.id}`;
}

/** The models whose compat shape selects one table row. */
function modelsInRow(
	models: HostModel[],
	row: (typeof DEFERRING_ROWS)[number],
): HostModel[] {
	return models.filter((model) => row.matches(model.compat ?? {}));
}

describe("the deferred-tool capability covers every host deferral row (#5361 r3)", () => {
	for (const row of DEFERRING_ROWS) {
		it(`is true for every catalog model in ${row.name}`, async () => {
			const models = await hostCatalog();
			const armed = modelsInRow(models, row);
			expect(
				armed.length,
				`the host catalog carries no model with the compat shape of ${row.name} (${row.why}), so that row cannot be observed on this host`,
			).toBeGreaterThan(0);
			for (const model of armed)
				expect(supportsDeferredTools(model), name(model)).toBe(true);
		});
	}

	it("is false for every catalog model that matches no deferral row", async () => {
		const models = await hostCatalog();
		const plain = models.filter(
			(model) => !DEFERRING_ROWS.some((row) => row.matches(model.compat ?? {})),
		);
		expect(
			plain.length,
			"every catalog model matches a deferral row, so the unknown-as-false cell cannot be observed",
		).toBeGreaterThan(0);
		for (const model of plain)
			expect(supportsDeferredTools(model), name(model)).toBe(false);
	});

	it("keeps every deferring api family in the true population", async () => {
		const models = await hostCatalog();
		const apis = new Set(
			models
				.filter((model) => supportsDeferredTools(model))
				.map((model) => model.api),
		);
		// The r1 predicate produced {"openai-responses", "openai-codex-responses"}
		// only; r2 lost the openai-completions arm (table row 8), which reaches
		// the capability through its own gate. A predicate that drops a row drops
		// the family that reaches it ONLY through that row.
		for (const api of [
			"anthropic-messages",
			"openai-responses",
			"openai-completions",
		])
			expect(apis.has(api), `the true population lost the ${api} family`).toBe(
				true,
			);
	});
});

/**
 * The same predicate through the REAL caller: index.ts stamps `deferralApplies`
 * on the `tool_set_mutation` row it records when a fresh session starts lazy.
 * Each case keeps `supportsMidConvoSystemMessages` true so the `auto` posture
 * stays lazy and the row is written; the arm under test is the other flag.
 */
const MID_CONVO: Readonly<Record<string, unknown>> = {
	supportsMidConvoSystemMessages: true,
};

async function rowsBefore(phase: string): Promise<number> {
	// Settle the loaded copy's sinks before counting, so a row an earlier case
	// still has queued cannot land inside this case's window: the NDJSON writer
	// map is process-global (`clients/ndjson-logger.ts`,
	// `Symbol.for("pi-lens.ndjson-logger.state")`), so this side's flush reaches
	// the copy's writers, and `drainPiSessionWrites()` joins its deferred drains.
	await drainPiSessionWrites();
	await flushAllNdjsonWriters();
	const file = path.join(fixture.root, "home", "latency.log");
	if (!fs.existsSync(file)) return 0;
	return readNdjsonRows(file).rows.filter((row) => row.phase === phase).length;
}

async function deferralAtSessionStart(
	slug: string,
	modelCompat: Readonly<Record<string, unknown>>,
): Promise<unknown> {
	const before = await rowsBefore("tool_set_mutation");
	let value: unknown;
	await withGlobalConfig(
		path.join(fixture.root, "global", slug, "config.json"),
		{ tools: { lazy: "auto" } },
		async () => {
			const handle = await startPiSession({
				root: fixture.root,
				cwd: path.join(fixture.root, slug, "proj"),
				modelCompat,
				responses: [READY],
			});
			await handle.prompt("first question");
			// Settle this session's own writes before the read, so its row cannot
			// arrive inside the NEXT case's window (`dispose()` is idempotent, so
			// the helper's `afterEach` still runs it).
			await handle.dispose();
			const read = await handle.latencyRows();
			expect(read.skipped).toBe(0);
			// Filter by phase FIRST, then drop the rows that were already in the
			// sink: `rowsBefore` counts phase rows, so slicing the unfiltered row
			// list by that count would keep most of the earlier cases' rows.
			const rows = read.rows
				.filter(
					(row) =>
						row.phase === "tool_set_mutation" &&
						typeof row.metadata === "object" &&
						row.metadata !== null,
				)
				.slice(before)
				.map((row) => row.metadata as Record<string, unknown>);
			const fresh = rows.filter(
				(row) => row.reason === "fresh_session_lazy_deactivation",
			);
			expect(fresh.length, `${slug}: no session_start deferral row`).toBe(1);
			value = fresh[0]?.deferralApplies;
		},
	);
	return value;
}

describe("the session_start row reports the deferral capability (#5361 r3)", () => {
	it("reports true for a model with supportsToolSearch", async () => {
		expect(
			await deferralAtSessionStart("arm-tool-search", {
				...MID_CONVO,
				supportsToolSearch: true,
			}),
		).toBe(true);
	});

	it("reports true for a model with the Anthropic mid-convo tool-change arm", async () => {
		expect(
			await deferralAtSessionStart("arm-mid-convo-tools", {
				...MID_CONVO,
				supportsMidConvoToolChanges: true,
			}),
		).toBe(true);
	});

	it("reports true for a model with the Responses-family additional-tools arm", async () => {
		// Review r2 F4: 33 catalog models on pi-1.5.0 state this shape and the r2
		// predicate read false on the 17 of them that state no other arm.
		expect(
			await deferralAtSessionStart("arm-additional-tools", {
				...MID_CONVO,
				supportsAdditionalTools: true,
			}),
		).toBe(true);
	});

	it("reports true for a model with the chat-completions tool-additions arm", async () => {
		// State table row 8: 17 catalog models on pi-1.5.0 (the Kimi family) reach
		// deferral only through openai-completions.js:551.
		expect(
			await deferralAtSessionStart("arm-mid-convo-tool-additions", {
				...MID_CONVO,
				supportsMidConvoToolAdditions: true,
			}),
		).toBe(true);
	});

	it("reports false for a model that matches no deferral row", async () => {
		expect(await deferralAtSessionStart("arm-none", MID_CONVO)).toBe(false);
	});
});
