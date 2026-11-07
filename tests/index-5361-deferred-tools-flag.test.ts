/**
 * #5361 r2: the `tool_set_mutation` deferral field states the host's deferred
 * (searchable) tool capability for EVERY model that has it, not one family.
 *
 * pi 1.5.0 pi-ai gates that capability in two places, and the predicate has to
 * carry both arms (review r1 F1, maintainer decision to widen):
 *  - `api/openai-responses.js` (`getResponsesToolSupport` in
 *    `openai-responses-shared.js`, shared with azure and codex):
 *    `compat.supportsToolSearch` selects the "additions" tool support;
 *  - `api/anthropic-messages.js:153,897`: `nativeToolChanges` is
 *    `compat.supportsMidConvoSystemMessages && compat.supportsMidConvoToolChanges`.
 * A model with neither gets the full inline tool list on every request, so the
 * field is false for it honestly.
 *
 * The guard reads the host install's OWN catalog
 * (`<pi-ai>/dist/providers/all.js`) and selects its models by the compat shape,
 * never by an id that a catalog refresh may drop. Recurrence it names: pi
 * renames a compat flag or moves one arm's gate, and the field silently reports
 * false on a host that supports the capability — #5361 itself read the
 * 0.80-era `supportsToolReferences`, so it was false on every supported host;
 * and the r1 fix read only the OpenAI arm, so the Anthropic models with native
 * tool changes still read false. A case that hand-shaped its own compat object
 * could not notice either drift (review r1 F2), which is why these cases read
 * real model objects and a real session row.
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

/** The compat cells this seam reads, as the host spells them. */
interface HostCompat {
	supportsToolSearch?: boolean;
	supportsMidConvoSystemMessages?: boolean;
	supportsMidConvoToolChanges?: boolean;
}

interface HostModel {
	id: string;
	provider: string;
	api?: string;
	compat?: HostCompat;
}

/** The host install's built-in model catalog, or a loud failure. */
async function hostCatalog(): Promise<HostModel[]> {
	const entry = path.join(piAiPackageDir(), "dist", "providers", "all.js");
	if (!fs.existsSync(entry))
		throw new Error(
			`pi-ai at ${piAiPackageDir()} carries no dist/providers/all.js, so its built-in model catalog cannot be read (#5361 r2)`,
		);
	const loaded = (await import(pathToFileURL(entry).href)) as {
		getBuiltinProviders?(): string[];
		getAllBuiltinModels?(provider: string): HostModel[];
	};
	if (
		typeof loaded.getBuiltinProviders !== "function" ||
		typeof loaded.getAllBuiltinModels !== "function"
	)
		throw new Error(
			`${entry} exports neither getBuiltinProviders nor getAllBuiltinModels, so the #5361 catalog guard cannot run on this host`,
		);
	const models: HostModel[] = [];
	for (const provider of loaded.getBuiltinProviders())
		models.push(...loaded.getAllBuiltinModels(provider));
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

describe("the deferred-tool capability covers both host arms (#5361 r2)", () => {
	it("is true for every catalog model whose provider gates it on supportsToolSearch", async () => {
		const models = await hostCatalog();
		const armed = models.filter(
			(model) => model.compat?.supportsToolSearch === true,
		);
		expect(
			armed.length,
			"the host catalog carries no model with compat.supportsToolSearch, so the OpenAI arm cannot be observed",
		).toBeGreaterThan(0);
		for (const model of armed)
			expect(supportsDeferredTools(model), name(model)).toBe(true);
	});

	it("is true for every catalog model whose provider gates it on the Anthropic mid-convo arm", async () => {
		const models = await hostCatalog();
		const armed = models.filter(
			(model) =>
				model.compat?.supportsToolSearch !== true &&
				model.compat?.supportsMidConvoSystemMessages === true &&
				model.compat?.supportsMidConvoToolChanges === true,
		);
		expect(
			armed.length,
			"the host catalog carries no model with the Anthropic arm (mid-convo system messages AND tool changes) without supportsToolSearch, so that arm cannot be observed",
		).toBeGreaterThan(0);
		// Review r1 F1: pi-1.5.0 shipped 7 such models (Claude Fable 5 and
		// friends) and the r1 predicate read false on all of them.
		for (const model of armed)
			expect(supportsDeferredTools(model), name(model)).toBe(true);
	});

	it("is false for every catalog model that states neither arm", async () => {
		const models = await hostCatalog();
		const plain = models.filter(
			(model) =>
				model.compat?.supportsToolSearch !== true &&
				!(
					model.compat?.supportsMidConvoSystemMessages === true &&
					model.compat?.supportsMidConvoToolChanges === true
				),
		);
		expect(
			plain.length,
			"every catalog model states a deferral arm, so the unknown-as-false cell cannot be observed",
		).toBeGreaterThan(0);
		for (const model of plain)
			expect(supportsDeferredTools(model), name(model)).toBe(false);
	});

	it("covers both provider families, so one arm cannot drop out silently", async () => {
		const models = await hostCatalog();
		const apis = new Set(
			models
				.filter((model) => supportsDeferredTools(model))
				.map((model) => model.api),
		);
		// The r1 predicate produced {"openai-responses", "openai-codex-responses"}
		// only. Anthropic models reach the capability through
		// anthropic-messages.js:897, so a predicate that lost that arm leaves
		// this set at the OpenAI families.
		expect(
			[...apis].sort(),
			"the true population lost the Anthropic arm",
		).toEqual(expect.arrayContaining(["anthropic-messages"]));
		expect(
			[...apis].some((api) => api?.startsWith("openai")),
			"the true population lost the OpenAI supportsToolSearch arm",
		).toBe(true);
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

describe("the session_start row reports the deferral capability (#5361 r2)", () => {
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

	it("reports false for a model that states neither arm", async () => {
		expect(await deferralAtSessionStart("arm-none", MID_CONVO)).toBe(false);
	});
});
