/**
 * WHICH keys get migration advice, WHO reports a config notice, and how many
 * notices one bad file can produce (#2426 review round 4).
 *
 * Five defects, one surface — the notices a user actually reads:
 *
 * F1. `~/.pi-lens/config.json` carrying a legacy ROOT LSP key had its value
 *     APPLIED by the LSP loader and simultaneously called a typo by the global
 *     loader, whose recognized-key catalog never picked up the legacy root keys.
 * F2/F5. `deprecationRecords` emitted one "move it" record per EVERY top-level
 *     key of a legacy file, recognized or not, outside the bounded collector.
 * F3. The project loader's OWN `config-ignored` warnings were not captured into
 *     the cache entry, so a warm cache HIT replayed only the deprecation half.
 * F4. The half-migrated notices were produced only by `loadLSPConfig`; under
 *     `--no-lsp` / `lsp.enabled:false` / a subagent session nobody produced them.
 * #2445. `loadPiLensGlobalConfig`'s bare `catch { return undefined }` gave a
 *     malformed global config zero signal of its own.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MIGRATION_RECORDS } from "../../clients/config-core/records.js";
import {
	LSP_KEY_TYPES,
	PI_LENS_CONFIG_SCHEMA,
} from "../../clients/config-schema.js";
import { resetIgnoredConfigWarnCache } from "../../clients/config-warn.js";
import {
	resetUserNotifier,
	wireUserNotifier,
} from "../../clients/user-notify.js";
import { removeTempDirSync } from "./test-utils.js";
import { useConfigPath } from "../support/global-config.js";

const notices: string[] = [];
const userNotices: string[] = [];
const ledgerRows: Array<{ kind: string; subject: string; reason: string }> = [];

vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: { message: string }) => {
			notices.push(entry.message);
		},
	};
});

vi.mock("../../clients/degradation-ledger.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../clients/degradation-ledger.js")
		>();
	return {
		...actual,
		recordDegradationOnce: (entry: {
			kind: string;
			subject: string;
			reason: string;
		}) => {
			ledgerRows.push({
				kind: entry.kind,
				subject: entry.subject,
				reason: entry.reason,
			});
		},
	};
});

const roots: string[] = [];

function tmpRoot(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

function write(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const setConfigPath = useConfigPath();
let previousHome: string | undefined;

beforeEach(() => {
	notices.length = 0;
	userNotices.length = 0;
	resetUserNotifier();
	wireUserNotifier(() => (message) => {
		userNotices.push(message);
	});
	ledgerRows.length = 0;
	previousHome = process.env.PI_LENS_HOME;
	resetIgnoredConfigWarnCache();
});

afterEach(async () => {
	resetUserNotifier();
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
	resetIgnoredConfigWarnCache();
	const { resetProjectLensConfigCache } =
		await import("../../clients/project-lens-config.js");
	resetProjectLensConfigCache();
	for (const dir of roots.splice(0)) removeTempDirSync(dir);
});

const deprecationNotices = (): string[] =>
	notices.filter((message) => message.startsWith("deprecated "));
const ignoredNotices = (): string[] =>
	notices.filter((message) => message.startsWith("ignoring invalid "));
/**
 * The truncation summary is its OWN prose shape since #2426 review round 6
 * (F2): a suppressed-notice count says nothing was ignored and nothing is
 * deprecated, so it must match neither predicate above.
 */
const suppressionNotices = (): string[] =>
	notices.filter((message) =>
		message.includes("further config notices were suppressed"),
	);

describe("F1: a legacy root LSP key in the GLOBAL config is a migration, not a typo", () => {
	it("gives all four legacy root keys a migration notice and no typo notice", async () => {
		const home = tmpRoot("pi-lens-f1-home-");
		const globalFile = path.join(home, ".pi-lens", "config.json");
		setConfigPath(globalFile);
		process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
		write(globalFile, {
			servers: {},
			serverOverrides: {},
			disabledServers: ["typescript"],
			warmFiles: ["a.ts"],
		});

		const { loadPiLensGlobalConfig, resetGlobalConfigWarnCache } =
			await import("../../clients/lens-config.js");
		resetGlobalConfigWarnCache();
		loadPiLensGlobalConfig(globalFile);

		// The values ARE applied by the LSP loader out of this same file, so
		// calling them typos is the contradiction under test.
		const { loadLSPConfig } = await import("../../clients/lsp/config.js");
		const lsp = await loadLSPConfig(path.join(home, "proj"), home);
		expect(lsp.disabledServers).toEqual(["typescript"]);
		expect(lsp.warmFiles).toEqual(["a.ts"]);

		const typos = notices.filter((message) => message.includes("unknown key"));
		expect(typos, `typo notices: ${JSON.stringify(typos)}`).toEqual([]);
		for (const key of [
			"servers",
			"serverOverrides",
			"disabledServers",
			"warmFiles",
		]) {
			expect(
				deprecationNotices().filter((message) =>
					message.includes(`move "${key}"`),
				),
				key,
			).toHaveLength(1);
		}
	});
});

describe("F2/F5: migration advice only for keys the schema recognizes, bounded", () => {
	it("does not tell the user to move a key that is not a pi-lens setting", async () => {
		const home = tmpRoot("pi-lens-f2-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-f2-global-");
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(projectDir, { recursive: true });
		const legacy: Record<string, unknown> = {
			ignore: ["dist/**"],
			maxProjectFiles: 500,
		};
		for (let index = 0; index < 98; index += 1) {
			legacy[`notASetting${index}`] = index;
		}
		write(path.join(projectDir, "pi-lens.json"), legacy);

		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		loadPiLensProjectConfig(projectDir);

		const misdirected = deprecationNotices().filter((message) =>
			message.includes('move "notASetting'),
		);
		expect(
			misdirected.length,
			`migration advice for unrecognized keys: ${misdirected.length}`,
		).toBe(0);

		// A typo key still gets its typo notice — that half is correct.
		expect(
			ignoredNotices().filter((message) =>
				message.includes('unknown key "notASetting0"'),
			),
		).toHaveLength(1);
	});

	it("bounds the notices one 100-key legacy file can produce", async () => {
		const home = tmpRoot("pi-lens-f2b-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-f2b-global-");
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(projectDir, { recursive: true });
		const legacy: Record<string, unknown> = {
			ignore: ["dist/**"],
			maxProjectFiles: 500,
		};
		for (let index = 0; index < 98; index += 1) {
			legacy[`notASetting${index}`] = index;
		}
		write(path.join(projectDir, "pi-lens.json"), legacy);

		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		loadPiLensProjectConfig(projectDir);

		// TWO bounded collectors, one per class of record: the shared resolution's
		// (deprecations + core validation drops) and this loader's own unknown-key
		// scan. Each holds one slot back for the count of what it suppressed, so
		// each class is capped at MAX_MIGRATION_RECORDS however many keys the file
		// has. Pre-fix this was 198 notifications for the same file.
		const counts = `deprecated=${deprecationNotices().length} ignored=${
			ignoredNotices().length
		} total=${userNotices.length}`;
		expect(deprecationNotices().length, counts).toBeLessThanOrEqual(
			MAX_MIGRATION_RECORDS,
		);
		expect(ignoredNotices().length, counts).toBeLessThanOrEqual(
			MAX_MIGRATION_RECORDS,
		);
		expect(userNotices.length, counts).toBeLessThanOrEqual(
			2 * MAX_MIGRATION_RECORDS,
		);

		// ONE whole-file record naming how many keys were not recognized …
		expect(
			deprecationNotices().filter((message) =>
				message.includes(
					"98 of its top-level keys are not recognized pi-lens settings",
				),
			),
			JSON.stringify(deprecationNotices()),
		).toHaveLength(1);
		// … and the suppression is COUNTED rather than silent. One prose shape for
		// every producer since round 5, because there is now one producer — and
		// since round 6 it is its own shape, not the ignored-config one.
		expect(suppressionNotices(), JSON.stringify(notices)).toHaveLength(1);
		expect(
			ignoredNotices().filter((message) =>
				message.includes("further config notices were suppressed"),
			),
			JSON.stringify(ignoredNotices()),
		).toEqual([]);
	});
});

describe("F3: a warm cache HIT replays the config-ignored rows too", () => {
	it("re-records the project loader's own ignored-key rows on a cache hit", async () => {
		const home = tmpRoot("pi-lens-f3-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-f3-global-");
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(projectDir, { recursive: true });
		write(path.join(projectDir, ".pi-lens.json"), {
			maxProjectFile: 500,
			maxProjectFiles: "nope",
			rules: { "high-complexity": [] },
		});

		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		loadPiLensProjectConfig(projectDir);
		const first = ledgerRows.filter((row) => row.kind === "config-ignored");
		expect(first.length, "session 1 config-ignored rows").toBeGreaterThan(0);

		// Session 2, warm: the ledger is reset at session_start, the config cache
		// is not, and `resetProjectLensConfigCache` has no production caller.
		ledgerRows.length = 0;
		loadPiLensProjectConfig(projectDir);
		const second = ledgerRows.filter((row) => row.kind === "config-ignored");
		expect(
			second.map((row) => row.reason).sort(),
			`session 2 config-ignored rows: ${JSON.stringify(second)}`,
		).toEqual(first.map((row) => row.reason).sort());
	});
});

describe("F4: the project loader alone produces the half-migrated notices", () => {
	it("reports a legacy SIBLING file without the LSP loader running", async () => {
		const home = tmpRoot("pi-lens-f4a-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-f4a-global-");
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(projectDir, { recursive: true });
		write(path.join(projectDir, "pi-lens.json"), {
			ignore: ["legacy/**"],
			maxProjectFiles: 500,
		});
		write(path.join(projectDir, ".pi-lens.json"), { ignore: ["canonical/**"] });

		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		loadPiLensProjectConfig(projectDir);

		const forKey = (key: string): string[] =>
			deprecationNotices().filter((message) =>
				message.includes(`move "${key}" to`),
			);
		expect(forKey("ignore"), JSON.stringify(deprecationNotices())).toHaveLength(
			1,
		);
		expect(forKey("maxProjectFiles")).toHaveLength(1);
	});

	it("reports a legacy ANCESTOR file without the LSP loader running", async () => {
		const home = tmpRoot("pi-lens-f4b-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-f4b-global-");
		const root = path.join(home, "root");
		const nested = path.join(root, "pkg");
		fs.mkdirSync(nested, { recursive: true });
		write(path.join(root, "pi-lens.json"), {
			ignore: ["root-legacy/**"],
			maxProjectFiles: 700,
		});
		write(path.join(nested, ".pi-lens.json"), { ignore: ["pkg/**"] });

		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		loadPiLensProjectConfig(nested);

		const forKey = (key: string): string[] =>
			deprecationNotices().filter((message) =>
				message.includes(`move "${key}" to`),
			);
		expect(forKey("ignore"), JSON.stringify(deprecationNotices())).toHaveLength(
			1,
		);
		expect(forKey("maxProjectFiles")).toHaveLength(1);
	});
});

describe("S1: an internal resolution failure names a file and one subsystem", () => {
	/**
	 * The core's outer guard is the floor UNDER the bounds inside `validate` and
	 * `merge`, so nothing a user can write reaches it any more — the only way to
	 * exercise it is to make reading a SOURCE throw, which is what the getter
	 * below does. That is the point: the record it emits is the one a user would
	 * see if a future bug in either half fired, and it carried `file: ""` and no
	 * tier, so it rendered as `ignoring invalid LSP config : …` three times over.
	 */
	function throwingSource(file: string) {
		return {
			tier: "project" as const,
			file,
			get trust(): never {
				throw new Error("boom");
			},
			value: {},
		};
	}

	it("anchors the record to the resolution's highest-precedence source", async () => {
		const { resolveConfig } =
			await import("../../clients/config-core/resolve.js");
		const { PI_LENS_CONFIG_SCHEMA } =
			await import("../../clients/config-schema.js");
		const file = path.join(tmpRoot("pi-lens-s1-"), ".pi-lens.json");

		const resolution = resolveConfig({
			sources: [throwingSource(file)],
			schema: PI_LENS_CONFIG_SCHEMA,
		});

		// `0008`, the whole-config failure code, since round 6's S1 split it off
		// the per-field `PILENS_CFG_0005`.
		const failure = resolution.records.find(
			(record) => record.code === "PILENS_CFG_0008",
		);
		expect(failure, JSON.stringify(resolution.records)).toBeDefined();
		expect(failure?.file).toBe(file);
		expect(failure?.subject).toBe(file);
		expect(failure?.tier).toBe("project");
	});

	it("reports it under ONE subsystem, naming the file", async () => {
		const { resolveConfig } =
			await import("../../clients/config-core/resolve.js");
		const { PI_LENS_CONFIG_SCHEMA } =
			await import("../../clients/config-schema.js");
		const { reportPiLensConfigRecords } =
			await import("../../clients/config-resolve.js");
		const file = path.join(tmpRoot("pi-lens-s1b-"), ".pi-lens.json");

		reportPiLensConfigRecords(
			resolveConfig({
				sources: [throwingSource(file)],
				schema: PI_LENS_CONFIG_SCHEMA,
			}).records,
		);

		expect(notices, JSON.stringify(notices)).toHaveLength(1);
		expect(notices[0]).toContain("ignoring invalid project config");
		expect(notices[0]).toContain(file);
		// Never the empty-path shape `ignoring invalid LSP config : …`.
		expect(notices[0]).not.toContain("config : ");
	});
});

describe("#2445: a malformed GLOBAL config is not silent, and is not LSP's", () => {
	it("emits a lens-config notice from the global loader itself", async () => {
		const home = tmpRoot("pi-lens-2445-home-");
		const globalFile = path.join(home, ".pi-lens", "config.json");
		setConfigPath(globalFile);
		process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
		fs.mkdirSync(path.dirname(globalFile), { recursive: true });
		fs.writeFileSync(globalFile, '{ "ignore": [ ');

		const { loadPiLensGlobalConfig, resetGlobalConfigWarnCache } =
			await import("../../clients/lens-config.js");
		resetGlobalConfigWarnCache();
		expect(loadPiLensGlobalConfig(globalFile)).toBeUndefined();

		expect(
			notices,
			`notices from the global loader: ${JSON.stringify(notices)}`,
		).toHaveLength(1);
		expect(notices[0]).toContain("ignoring invalid global config");
	});

	it("does not let the LSP loader relabel a pi-lens global document as LSP", async () => {
		const home = tmpRoot("pi-lens-2445b-home-");
		const globalFile = path.join(home, ".pi-lens", "config.json");
		setConfigPath(globalFile);
		process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
		fs.mkdirSync(path.dirname(globalFile), { recursive: true });
		fs.writeFileSync(globalFile, '{ "ignore": [ ');
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(projectDir, { recursive: true });

		const { loadLSPConfig } = await import("../../clients/lsp/config.js");
		await loadLSPConfig(projectDir, home);

		const mislabelled = notices.filter(
			(message) =>
				message.includes("ignoring invalid LSP config") &&
				message.includes(globalFile),
		);
		expect(mislabelled, `mislabelled: ${JSON.stringify(notices)}`).toEqual([]);
		expect(
			notices.filter((message) =>
				message.includes("ignoring invalid global config"),
			),
		).toHaveLength(1);
	});
});

/**
 * Round 5, F-A/F-B/S-A/F-D: ONE bound, on every producer of a record list.
 *
 * "Bound a record list and say so when it truncates" existed three times —
 * `boundedResolutionRecords` in `config-resolve.ts`, `ignoredRecordCollector`
 * in `project-lens-config.ts`, and NOT AT ALL on the third producer, the
 * project loader's legacy-document enumeration, which shipped
 * `deprecationRecords(...)` raw. Which is the single-source-of-truth defect
 * doing what it always does: the copy that matters is the one nobody wrote.
 *
 * The probes below are the LEGACY path specifically, because that is the one
 * with no bound at all. Neutering either of the two existing copies leaves the
 * suite green, so those copies were never the thing under test.
 */
const recognizedTopLevelKeys = (): string[] =>
	Object.keys(
		(PI_LENS_CONFIG_SCHEMA as { properties?: Record<string, unknown> })
			.properties ?? {},
	);

/**
 * A legacy document spelling EVERY key pi-lens recognizes — 28 of them, well
 * past the bound of 20, and every one of them a key the user is being told to
 * move.
 *
 * The values VALIDATE on purpose. A rejected value would add a validation
 * record to the same finalized list and change the count the two loaders are
 * compared on in the parity probe. Four MORE keys constrain their value than
 * used to (#2427 review round 2, F1): `resolvePiLensConfig` normalizes the
 * legacy root LSP keys into the `lsp` namespace at source injection, so
 * `warmFiles: true` is now checked against the namespace node that declares it
 * an array instead of against an opaque root node that declared nothing. The
 * filler is taken from `LSP_KEY_TYPES` rather than hand-listed, so a new typed
 * key cannot quietly re-introduce the confound.
 */
function everyRecognizedKey(): Record<string, unknown> {
	const value: Record<string, unknown> = {};
	for (const key of recognizedTopLevelKeys()) {
		value[key] = validFillerFor(key);
	}
	return value;
}

/** A value the canonical schema accepts for one top-level key. */
function validFillerFor(key: string): unknown {
	const emptyObject: Record<string, unknown> = {};
	const emptyArray: unknown[] = [];
	if (key === "$schema") return "https://pi-lens.dev/schema/v1.json";
	const declared = LSP_KEY_TYPES[key];
	if (key === "lsp") return emptyObject;
	if (declared === "object") return emptyObject;
	if (declared === "array") return emptyArray;
	return true;
}

const isSuppressionSummaryFor = (message: string, file: string): boolean =>
	message.includes(file) &&
	message.includes("further config notices were suppressed");

/**
 * The notices one file's LEGACY list emitted, by POSITION: the run that starts
 * at the file's first move notice and holds only that file's move notices and
 * summaries. The list closes with its own summary, so the legacy summary is the
 * one inside this run.
 *
 * A file that spells every recognized key ends up to two bounded lists, each
 * with its own summary: the legacy moves, and the global-only settings the
 * project loader refuses (#4946 added three global-only sections and tipped
 * that second list past its bound). Matching on the summary's phrase alone
 * counts both and made these probes depend on how many global-only sections
 * the registry holds; keeping the first one hid the second. Position tells
 * them apart, and a lost legacy summary leaves the run without one.
 */
function legacyListFor(file: string): { summaries: string[]; end: number } {
	const start = notices.findIndex(
		(message) => message.startsWith("deprecated ") && message.includes(file),
	);
	if (start < 0) return { summaries: [], end: 0 };
	let end = start;
	while (
		end < notices.length &&
		((notices[end] as string).startsWith("deprecated ") ||
			isSuppressionSummaryFor(notices[end] as string, file))
	) {
		end += 1;
	}
	return {
		summaries: notices
			.slice(start, end)
			.filter((message) => isSuppressionSummaryFor(message, file)),
		end,
	};
}

/** The summary that closes the file's legacy list: exactly one, or none. */
const suppressionNoticesFor = (file: string): string[] =>
	legacyListFor(file).summaries;

/**
 * The summaries after the legacy list: the refused global-only settings list
 * the PROJECT loader ends (the LSP loader does not produce it).
 */
const refusalSuppressionFor = (file: string): string[] =>
	notices
		.slice(legacyListFor(file).end)
		.filter((message) => isSuppressionSummaryFor(message, file));

const deprecationNoticesFor = (file: string): string[] =>
	deprecationNotices().filter((message) => message.includes(file));

describe("round 5 F-A/F-B/S-A: every record list goes through the one bound", () => {
	it("bounds a legacy file with more RECOGNIZED keys than the bound", async () => {
		const home = tmpRoot("pi-lens-r5a-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-r5a-global-");
		setConfigPath(path.join(home, "absent", "config.json"));
		const projectDir = path.join(home, "proj");
		const legacyFile = path.join(projectDir, "pi-lens.json");
		write(legacyFile, everyRecognizedKey());

		// The premise the probe rests on: this file's RECOGNIZED key count — the
		// count that survives round 4's "advice only for keys we recognize" fix —
		// is itself past the bound.
		expect(
			recognizedTopLevelKeys().length,
			"recognized top-level keys",
		).toBeGreaterThan(MAX_MIGRATION_RECORDS);

		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		loadPiLensProjectConfig(projectDir);

		const moves = deprecationNoticesFor(legacyFile);
		const suppressed = suppressionNoticesFor(legacyFile);
		const detail = `moves=${moves.length} suppressed=${suppressed.length}`;
		// One slot of the bound is held back for the count, so the notices this
		// one file can produce never exceed the bound however many keys it has.
		expect(moves.length + suppressed.length, detail).toBeLessThanOrEqual(
			MAX_MIGRATION_RECORDS,
		);
		// … and the truncation is COUNTED, not silent.
		expect(suppressed, detail).toHaveLength(1);
		// The refused global-only list is its own bounded list with its own
		// summary (#4946): one, not folded into the legacy one and not lost.
		expect(refusalSuppressionFor(legacyFile), detail).toHaveLength(1);
	});

	it("bounds five nested legacy files PER FILE, each with its own count", async () => {
		const home = tmpRoot("pi-lens-r5b-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-r5b-global-");
		setConfigPath(path.join(home, "absent", "config.json"));
		const dirs = ["root", "root/a", "root/a/b", "root/a/b/c", "root/a/b/c/d"];
		const legacyFiles = dirs.map((relative) =>
			path.join(home, ...relative.split("/"), "pi-lens.json"),
		);
		for (const file of legacyFiles) write(file, everyRecognizedKey());

		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		loadPiLensProjectConfig(path.dirname(legacyFiles[4] as string));

		// Per FILE, not per walk: each file is separately actionable, so a
		// per-walk bound would silently drop whole files' advice.
		for (const file of legacyFiles) {
			const moves = deprecationNoticesFor(file);
			const suppressed = suppressionNoticesFor(file);
			const detail = `${file}: moves=${moves.length} suppressed=${suppressed.length}`;
			expect(moves.length + suppressed.length, detail).toBeLessThanOrEqual(
				MAX_MIGRATION_RECORDS,
			);
			expect(suppressed, detail).toHaveLength(1);
			// Only the nearest file's global-only settings are refused (an ancestor
			// is a legacy document, not the file in force), so only it ends the
			// second list.
			expect(refusalSuppressionFor(file), detail).toHaveLength(
				file === legacyFiles[4] ? 1 : 0,
			);
		}
		// Pre-fix this walk produced 5 x 28 deprecation notices and no
		// suppression record anywhere.
		expect(
			deprecationNotices().length,
			`total deprecation notices: ${deprecationNotices().length}`,
		).toBeLessThanOrEqual(legacyFiles.length * MAX_MIGRATION_RECORDS);
	});

	it("gives the same file the same notice count through either loader", async () => {
		const home = tmpRoot("pi-lens-r5c-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-r5c-global-");
		setConfigPath(path.join(home, "absent", "config.json"));
		const projectDir = path.join(home, "proj");
		const legacyFile = path.join(projectDir, "pi-lens.json");
		write(legacyFile, everyRecognizedKey());

		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		loadPiLensProjectConfig(projectDir);
		const viaProject = {
			moves: deprecationNoticesFor(legacyFile).length,
			suppressed: suppressionNoticesFor(legacyFile).length,
		};
		const projectRefusalSummaries = refusalSuppressionFor(legacyFile).length;

		// Same file, other loader, from a clean latch.
		notices.length = 0;
		resetIgnoredConfigWarnCache();
		resetProjectLensConfigCache();
		const { loadLSPConfig } = await import("../../clients/lsp/config.js");
		await loadLSPConfig(projectDir, home);
		const viaLsp = {
			moves: deprecationNoticesFor(legacyFile).length,
			suppressed: suppressionNoticesFor(legacyFile).length,
		};

		// The half-migrated notices for a pi-lens-owned file must not depend on
		// which loader happened to run — the F4 premise. Pre-fix the project
		// loader said 28 and the LSP loader said 19 plus a count.
		expect(
			viaProject,
			`project=${JSON.stringify(viaProject)} lsp=${JSON.stringify(viaLsp)}`,
		).toEqual(viaLsp);
		expect(viaProject.suppressed).toBe(1);
		// The loaders differ in exactly one disclosed way: only the project loader
		// refuses global-only settings, so only it ends the second bounded list
		// and discloses that list's truncation.
		expect(projectRefusalSummaries).toBe(1);
		expect(refusalSuppressionFor(legacyFile)).toHaveLength(0);
	});
});

describe("round 5 F-D: a WARM load replays a bounded ledger, not the raw list", () => {
	it("keeps a warm load's config-deprecated rows inside the bound", async () => {
		const home = tmpRoot("pi-lens-r5d-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-r5d-global-");
		setConfigPath(path.join(home, "absent", "config.json"));
		const projectDir = path.join(home, "proj");
		write(path.join(projectDir, "pi-lens.json"), everyRecognizedKey());

		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		loadPiLensProjectConfig(projectDir);

		// Session 2: the ledger is reset at session_start, the discovery cache is
		// not, so the cached record list is replayed verbatim. An unbounded list
		// in the cache is an unbounded ledger write on EVERY later load, not just
		// the first.
		ledgerRows.length = 0;
		loadPiLensProjectConfig(projectDir);
		// DISTINCT (kind, subject), because that is what the real ledger stores:
		// `recordDegradationOnce` dedupes on the pair, and this file's mock does
		// not, so counting raw calls would count the by-design double report of
		// the same file by two loaders (which the latch and the ledger both
		// collapse) instead of the thing under test — how long the replayed list
		// is.
		const deprecated = new Set(
			ledgerRows
				.filter((row) => row.kind === "config-deprecated")
				.map((row) => row.subject),
		);
		expect(
			deprecated.size,
			`warm-load config-deprecated rows: ${deprecated.size}`,
		).toBeLessThanOrEqual(MAX_MIGRATION_RECORDS);
	});
});
