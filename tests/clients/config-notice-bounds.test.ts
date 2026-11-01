/**
 * What the per-resolution notice bound actually REPORTS (#2426 review round 6).
 *
 * Round 5 gave every producer one bounding seam. Round 6 is about the three
 * things that seam still got wrong once it had them:
 *
 * F1. The bound is applied TWICE on the shared path — once by `config-core`'s
 *     own collector inside `resolveConfig` (limit 20) and again by
 *     `finalizeRecords` over what survived — and only the second one was
 *     counted. A file producing 40 records was truncated 21 times and told the
 *     user 1.
 * F2. `PILENS_CFG_0007` fell through `warnIgnoredConfigOnce`'s DEFAULT prose
 *     and its default kind, so a fully valid legacy file whose every setting
 *     was applied got an "ignoring invalid project config" notice and a
 *     `config-ignored` ledger row — the exact inversion that file's own comment
 *     forbids for the deprecation branch.
 * F3. The global loader's unknown-top-level-key scan warned once per key with
 *     no collector at all, so a 100-key `~/.pi-lens/config.json` produced 100
 *     notifications while the project loader's identical scan produced 19 and a
 *     count.
 * S1. Both whole-config failure paths borrowed `PILENS_CFG_0005`, which is
 *     registered and documented as a PER-FIELD rejection. A user matching on
 *     0005 expects to have lost one field, not the file.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MIGRATION_RECORDS } from "../../clients/config-core/records.js";
import { PI_LENS_CONFIG_SCHEMA } from "../../clients/config-schema.js";
import { resetIgnoredConfigWarnCache } from "../../clients/config-warn.js";
import {
	resetUserNotifier,
	wireUserNotifier,
} from "../../clients/user-notify.js";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { removeTempDirSync } from "./test-utils.js";
import { useConfigPath } from "../support/global-config.js";

const notices: string[] = [];
const userNotices: string[] = [];
const ledgerRows: Array<{
	kind: string;
	subject: string;
	reason: string;
	code?: string;
}> = [];

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
			code?: string;
		}) => {
			ledgerRows.push({
				kind: entry.kind,
				subject: entry.subject,
				reason: entry.reason,
				...(entry.code === undefined ? {} : { code: entry.code }),
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

/**
 * A document whose every section carries one prototype-polluting key, written
 * as RAW JSON text: a `{ __proto__: ... }` object literal in TypeScript sets
 * the prototype instead of creating an own property, so building this through
 * `JSON.stringify` yields a file with no `__proto__` key in it at all — and a
 * probe that proves nothing.
 */
function protoSectionsJson(count: number): string {
	const parts: string[] = [];
	for (let index = 0; index < count; index += 1) {
		parts.push(`"section${index}": {"__proto__": {"polluted": true}}`);
	}
	return `{${parts.join(",")}}`;
}

/** The count a `PILENS_CFG_0007` reason leads with. */
function suppressedCount(reason: string): number {
	const match = /(\d+) further config notices/.exec(reason);
	return match ? Number(match[1]) : Number.NaN;
}

function recognizedTopLevelKeys(): string[] {
	const properties = (
		PI_LENS_CONFIG_SCHEMA as { properties?: Record<string, unknown> }
	).properties;
	return properties ? Object.keys(properties) : [];
}

function everyRecognizedKey(): Record<string, unknown> {
	const value: Record<string, unknown> = {};
	for (const key of recognizedTopLevelKeys()) {
		if (key === "$schema") value[key] = "https://pi-lens.dev/schema/v1.json";
		else if (key === "lsp") value[key] = {};
		else value[key] = true;
	}
	return value;
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

const PROTO_SECTIONS = 40;

describe("F1: the suppression count is the TRUE total, across both bounds", () => {
	it("counts what the core's collector dropped, not only the sink's overflow", async () => {
		const home = tmpRoot("pi-lens-r6f1-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-r6f1-global-");
		setConfigPath(path.join(home, "absent", "config.json"));
		const projectDir = path.join(home, "proj");
		const file = path.join(projectDir, ".pi-lens.json");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(file, protoSectionsJson(PROTO_SECTIONS));

		const { resolvePiLensConfig } =
			await import("../../clients/config-resolve.js");
		const resolution = resolvePiLensConfig({ cwd: projectDir, homeDir: home });

		const detail = JSON.stringify(
			resolution.records.map((record) => record.code),
		);
		const suppression = resolution.records.filter(
			(record) => record.code === "PILENS_CFG_0007",
		);
		expect(suppression, detail).toHaveLength(1);
		const kept = resolution.records.length - suppression.length;
		// The file holds one refused key per section and nothing else, so the
		// arithmetic is closed: what is not in the list was suppressed.
		expect(
			suppressedCount(suppression[0]?.reason ?? ""),
			`kept=${kept} reason=${suppression[0]?.reason}`,
		).toBe(PROTO_SECTIONS - kept);
	});

	it("counts it on the single-document path too", async () => {
		const home = tmpRoot("pi-lens-r6f1b-home-");
		const file = path.join(home, "proj", ".pi-lens.json");
		const { resolveOnePiLensConfigDocument, projectLocationFor } =
			await import("../../clients/config-resolve.js");
		const resolved = resolveOnePiLensConfigDocument(
			{
				tier: "project",
				file,
				location: projectLocationFor(file),
				value: JSON.parse(protoSectionsJson(PROTO_SECTIONS)) as unknown,
			},
			home,
		);

		const suppression = resolved.records.filter(
			(record) => record.code === "PILENS_CFG_0007",
		);
		expect(suppression, JSON.stringify(resolved.records)).toHaveLength(1);
		const kept = resolved.records.length - suppression.length;
		expect(
			suppressedCount(suppression[0]?.reason ?? ""),
			`kept=${kept} reason=${suppression[0]?.reason}`,
		).toBe(PROTO_SECTIONS - kept);
	});
});

const SUPPRESSION_REASON =
	"9 further config notices were suppressed by the bound of 20";

describe("F2: a suppression notice never reads as an ignored config", () => {
	it("renders PILENS_CFG_0007 with neither the ignored prose nor the ignored kind", async () => {
		const file = path.join(tmpRoot("pi-lens-r6f2u-"), "pi-lens.json");
		const { warnIgnoredConfigOnce } =
			await import("../../clients/config-warn.js");

		warnIgnoredConfigOnce({
			subsystem: "project-lens-config",
			file,
			reason: SUPPRESSION_REASON,
			code: "PILENS_CFG_0007",
		});

		expect(notices, JSON.stringify(notices)).toHaveLength(1);
		expect(notices[0]).toContain(file);
		expect(notices[0]).toContain(SUPPRESSION_REASON);
		// The whole point: a truncated LIST is not an ignored or invalid CONFIG.
		expect(notices[0]).not.toContain("invalid");
		expect(notices[0]).not.toContain("ignor");
		expect(userNotices[0], JSON.stringify(userNotices)).not.toContain(
			"invalid",
		);

		expect(ledgerRows, JSON.stringify(ledgerRows)).toHaveLength(1);
		expect(ledgerRows[0]?.kind).toBe("config-notice-suppressed");
		expect(ledgerRows[0]?.code).toBe("PILENS_CFG_0007");
		expect(ledgerRows[0]?.subject).toBe(file);
	});

	it("keeps a legacy file's overflow out of the ignored/invalid vocabulary", async () => {
		const home = tmpRoot("pi-lens-r6f2-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-r6f2-global-");
		setConfigPath(path.join(home, "absent", "config.json"));
		const projectDir = path.join(home, "proj");
		const legacyFile = path.join(projectDir, "pi-lens.json");
		// Every key is one the canonical schema recognizes, so every one of them
		// earns a "move it" notice and the advice list for the file's deprecated
		// LOCATION overflows the bound. The overflow is what is under test here;
		// the unit case above pins the code -> prose/kind mapping on its own.
		write(legacyFile, everyRecognizedKey());
		expect(
			recognizedTopLevelKeys().length,
			"recognized top-level keys",
		).toBeGreaterThan(MAX_MIGRATION_RECORDS);

		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		loadPiLensProjectConfig(projectDir);

		const suppression = notices.filter(
			(message) =>
				message.includes(legacyFile) &&
				message.includes("further config notices were suppressed"),
		);
		// One summary per bounded list the file ends: the legacy moves close with
		// theirs right after the last move notice, and the refused global-only
		// settings (#4946 pushed that list past its own bound) with theirs after
		// that list. Exactly two, told apart by position.
		expect(suppression, JSON.stringify(notices)).toHaveLength(2);
		const lastMove = notices.reduce(
			(last, message, index) =>
				message.startsWith("deprecated ") && message.includes(legacyFile)
					? index
					: last,
			-1,
		);
		expect(notices.indexOf(suppression[0] as string), "legacy summary").toBe(
			lastMove + 1,
		);
		expect(
			notices.indexOf(suppression[1] as string),
			"refusal summary",
		).toBeGreaterThan(lastMove + 1);
		for (const summary of suppression) {
			expect(summary).not.toContain("ignoring invalid");
			expect(summary).not.toContain("invalid");
		}

		// The SUPPRESSION row, wherever it landed: every ledger row carrying the
		// truncation reason must be the neutral kind, and none of them the
		// ignored one. Filtering on the reason rather than on the file is what
		// makes this a probe of the code -> kind mapping instead of a probe of
		// how many other things this fixture happens to warn about.
		const suppressionRows = ledgerRows.filter((row) =>
			row.reason.includes("further config notices were suppressed"),
		);
		expect(suppressionRows, JSON.stringify(ledgerRows)).not.toEqual([]);
		for (const row of suppressionRows) {
			expect(row.kind, JSON.stringify(row)).toBe("config-notice-suppressed");
			expect(row.code, JSON.stringify(row)).toBe("PILENS_CFG_0007");
		}
	});
});

describe("F3: the GLOBAL loader's unknown-key scan is bounded like every other", () => {
	it("summarises past the bound instead of one notification per key", async () => {
		const home = tmpRoot("pi-lens-r6f3-home-");
		const globalFile = path.join(home, ".pi-lens", "config.json");
		setConfigPath(globalFile);
		process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
		const value: Record<string, unknown> = {};
		for (let index = 0; index < 100; index += 1) {
			value[`unknownKey${index}`] = true;
		}
		write(globalFile, value);

		const { loadPiLensGlobalConfig, resetGlobalConfigWarnCache } =
			await import("../../clients/lens-config.js");
		resetGlobalConfigWarnCache();
		loadPiLensGlobalConfig(globalFile);

		const typos = notices.filter((message) =>
			message.includes("is not a recognized pi-lens setting"),
		);
		const suppression = notices.filter((message) =>
			message.includes("further config notices were suppressed"),
		);
		const detail = `typos=${typos.length} suppression=${suppression.length}`;
		expect(typos.length + suppression.length, detail).toBeLessThanOrEqual(
			MAX_MIGRATION_RECORDS,
		);
		expect(suppression, detail).toHaveLength(1);
		expect(suppressedCount(suppression[0] ?? ""), suppression[0]).toBe(
			100 - typos.length,
		);
	});

	it("still names every unknown key when the file stays inside the bound", async () => {
		const home = tmpRoot("pi-lens-r6f3b-home-");
		const globalFile = path.join(home, ".pi-lens", "config.json");
		setConfigPath(globalFile);
		process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
		write(globalFile, { lps: true, ignore: ["dist/**"] });

		const { loadPiLensGlobalConfig, resetGlobalConfigWarnCache } =
			await import("../../clients/lens-config.js");
		resetGlobalConfigWarnCache();
		expect(loadPiLensGlobalConfig(globalFile)?.ignore).toEqual(["dist/**"]);

		const typos = notices.filter((message) =>
			message.includes('unknown key "lps"'),
		);
		expect(typos, JSON.stringify(notices)).toHaveLength(1);
		expect(typos[0]).toContain("ignoring invalid global config");
		expect(
			notices.filter((message) =>
				message.includes("further config notices were suppressed"),
			),
			JSON.stringify(notices),
		).toEqual([]);
	});
});

describe("S1: a WHOLE-config failure has its own code", () => {
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

	it("does not borrow the per-FIELD rejection code", async () => {
		const { resolveConfig } =
			await import("../../clients/config-core/resolve.js");
		const file = path.join(tmpRoot("pi-lens-r6s1-"), ".pi-lens.json");

		const resolution = resolveConfig({
			sources: [throwingSource(file)],
			schema: PI_LENS_CONFIG_SCHEMA,
		});

		const detail = JSON.stringify(resolution.records);
		expect(
			resolution.records.map((record) => record.code),
			detail,
		).toEqual(["PILENS_CFG_0008"]);
		expect(resolution.records[0]?.file, detail).toBe(file);
	});
});

describe("round 7, F1: the whole-config failure record outranks the bound", () => {
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

	/**
	 * The record that says "NONE of this applied" used to go in through the same
	 * `collector.add()` the per-field records fill, so a resolution that had
	 * already produced `MAX_MIGRATION_RECORDS` per-field records swallowed it
	 * into the anonymous drop count.
	 *
	 * That is the round-6 inversion arriving through the bound instead of
	 * through prose: the user reads 19 "key rejected" notices plus "1 further
	 * notice suppressed" and concludes the rest of the file is in effect, while
	 * `merge([])` applied nothing at all. The failure record is not one more
	 * notice competing for a slot — it is the statement that the other notices
	 * are no longer the whole story — so it is appended OUTSIDE the limit, the
	 * same shape `finalize()` uses for its own overflow record.
	 */
	it("survives a collector the per-field records already filled", async () => {
		const { resolveConfig } =
			await import("../../clients/config-core/resolve.js");
		const root = tmpRoot("pi-lens-r7f1-");
		const refusedFile = path.join(root, ".pi-lens.json");
		const throwingFile = path.join(root, "nested", ".pi-lens.json");

		const resolution = resolveConfig({
			sources: [
				{
					tier: "project" as const,
					file: refusedFile,
					value: JSON.parse(protoSectionsJson(30)) as unknown,
				},
				throwingSource(throwingFile),
			],
			schema: PI_LENS_CONFIG_SCHEMA,
		});

		const codes = resolution.records.map((record) => record.code);
		const detail = JSON.stringify({
			codes,
			dropped: resolution.droppedRecordCount,
		});
		// The bound really did bite: without it this proves nothing.
		expect(resolution.droppedRecordCount, detail).toBeGreaterThan(0);
		expect(codes, detail).toContain("PILENS_CFG_0008");
		// Appended, not squeezed in: the per-field records keep every slot they
		// had, and the failure record sits past them.
		expect(
			codes.filter((code) => code === "PILENS_CFG_0006").length,
			detail,
		).toBe(MAX_MIGRATION_RECORDS);
		expect(codes[codes.length - 1], detail).toBe("PILENS_CFG_0008");
		// And the failure record is never itself counted as suppressed.
		expect(resolution.droppedRecordCount, detail).toBe(
			30 - MAX_MIGRATION_RECORDS,
		);
		const failure = resolution.records.find(
			(record) => record.code === "PILENS_CFG_0008",
		);
		expect(failure?.file, detail).toBe(throwingFile);
		expect(failure?.tier, detail).toBe("project");
	});
});

describe("round 7, F2: ONE buffer-notes-then-finalize seam, not one per loader", () => {
	/**
	 * Round 6 gave the global loader the bound the project loader already had —
	 * by copying it. Both then held the same record literal (`PILENS_CFG_0001`,
	 * key `""`, `migrationSubject(configPath, "")`) and the same
	 * `finalizeRecords` flush, differing only in a tier literal. Two copies of
	 * one policy is the shape round 5 collapsed three copies of this same bound
	 * to avoid, so the seam moved to `config-resolve.ts` — which both loaders
	 * already import — and takes the tier as an argument.
	 *
	 * Asserted on the SOURCE because the defect is duplication, which no
	 * behavioral probe can see: two correct copies pass every behavioral test
	 * right up until one of them is edited.
	 */
	it("composes the ignored-config note record in exactly one module", () => {
		const repoRoot = path.resolve(__dirname, "..", "..");
		const files = listSourceFiles(path.join(repoRoot, "clients"), {
			extensions: [".ts"],
			skipTests: true,
		});
		// A walk that found nothing must fail, not read as clean (defect shape 10).
		assertNonEmptyScan("config-0001 record-literal sweep", files.length, 60);

		const composers = files.filter((file) =>
			// `strings: "keep"`: the needle IS a string literal, so blanking string
			// contents would blind the sweep to every hit. Comments still go, which
			// is what matters here — three modules DISCUSS this record in prose.
			/\bcode:\s*"PILENS_CFG_0001"/.test(
				stripSource(fs.readFileSync(file, "utf8"), { strings: "keep" }),
			),
		);

		expect(
			composers.map((file) => relativePosix(repoRoot, file)),
			composers.join(", "),
		).toEqual(["clients/config-resolve.ts"]);
	});

	it("bounds and tiers BOTH loaders' notes through that one seam", async () => {
		const { ignoredRecordCollector } =
			await import("../../clients/config-resolve.js");
		const file = path.join(tmpRoot("pi-lens-r7f2-"), ".pi-lens.json");

		for (const tier of ["global", "project"] as const) {
			const { note, records } = ignoredRecordCollector(file, tier);
			for (let index = 0; index < MAX_MIGRATION_RECORDS + 5; index += 1) {
				note(`unknown top-level key "k${index}"`, "PILENS_CFG_0001");
			}
			const finalized = records();
			const detail = `${tier}: ${JSON.stringify(finalized)}`;
			expect(finalized.length, detail).toBe(MAX_MIGRATION_RECORDS);
			expect(
				finalized.every((record) => record.tier === tier),
				detail,
			).toBe(true);
			expect(finalized[0]?.code, detail).toBe("PILENS_CFG_0001");
			expect(finalized[finalized.length - 1]?.code, detail).toBe(
				"PILENS_CFG_0007",
			);
			expect(finalized[0]?.subject, detail).toBe(file);
		}
	});
});
