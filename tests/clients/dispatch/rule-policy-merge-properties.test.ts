/**
 * Property tests for the `rules.<id>` tier merge (#5250).
 *
 * Recurrence this file prevents: #5232. A project `.pi-lens.json` that listed
 * one rule in `rules.<id>.disable` re-enabled every rule the global (or root)
 * config had disabled, because the tiers REPLACED the list. #5237 fixed it and
 * pinned twelve hand-picked stacks; the review then needed separate probes for
 * `select` per key and for non-string members, and none of that was pinned for
 * every stack. The merge obeys rules that hold for ALL tier stacks, and an
 * example list only covers the stacks someone wrote.
 *
 * Production chain, nothing stubbed: real config files written under a temp
 * tree, then `resolvePiLensConfig` -> `rulePolicyMapFromResolution` ->
 * `evaluateRulePolicy`. Generated stacks cover every tier the resolver
 * populates with `rules`: the global `config.json`, and per directory (repo
 * root, `pkg/`, `pkg/deep/`) the legacy `pi-lens.json` below the canonical
 * `.pi-lens.json`.
 *
 * Generators include the shapes older released writers produced (AGENTS.md
 * shape 57, #3594): the 4.0 `rules` examples (`ast-grep:` and `-js` spellings
 * of one rule, threshold-only and policy-only entries, hand-padded and blank
 * list entries, repeated members, an empty list), the undotted `pi-lens.json`
 * file, and the #444 spelling that put the lists directly under `rules`
 * (`rules.disable`), which the resolver rejects with a notice.
 *
 * Properties (the oracle below is the test's own: it reads the generated
 * documents, never the resolver):
 *   1. `disable` is a monotone union: adding a tier never removes a rule, and
 *      the effective set is exactly the union of every tier's valid members
 *      (two tests: the monotone claim, and the exact-union oracle).
 *   2. `select` replaces per grouping key: the nearest tier that sets
 *      `k.select` supplies `k`'s list and never drops another key's list.
 *   3. `disable` wins over `select` for the same rule, whatever the tiers.
 *   4. A non-string `disable` or `select` member (or a non-array value) never
 *      throws, and removing it changes no verdict.
 *
 * Determinism: fixed seed and bounded runs. Replay a failure with
 * `PI_LENS_PROP_SEED=<seed> PI_LENS_PROP_RUNS=<runs> npx vitest run <file>`;
 * fast-check prints the seed and the shrunk counterexample.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, it } from "vitest";
import { resolvePiLensConfig } from "../../../clients/config-resolve.js";
import {
	evaluateRulePolicy,
	rulePolicyMapFromResolution,
} from "../../../clients/dispatch/rule-policy.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";
import { useConfigPath } from "../../support/global-config.js";
import { removeTempDirSync } from "../test-utils.js";

const NUM_RUNS = Number(process.env.PI_LENS_PROP_RUNS) || 120;
const SEED = Number(process.env.PI_LENS_PROP_SEED) || 5250;
const PROPERTY_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// The document model
// ---------------------------------------------------------------------------

type Spelling = "plain" | "prefixed" | "suffixed";

/** One list member as a released or hand-edited config can spell it. */
type Member =
	| { kind: "id"; base: string; spelling: Spelling }
	| { kind: "padded"; base: string }
	| { kind: "blank"; text: string }
	| { kind: "junk"; value: unknown };

/** A list value: an array of members, or a value that is not an array. */
type ListValue =
	| { kind: "list"; members: Member[] }
	| { kind: "bad"; value: unknown };

interface Entry {
	disable?: ListValue;
	select?: ListValue;
	threshold?: number;
	unrelated?: boolean;
}

/** `rules.<key>` is an entry object, or something that is not one. */
type EntryValue =
	| { kind: "entry"; entry: Entry }
	| { kind: "bad"; value: unknown };

/** The `rules` value of one document: a block of keys, or a non-object. */
type RulesValue =
	| { kind: "block"; entries: [string, EntryValue][] }
	| { kind: "bad"; value: unknown };

/** The tiers, in ASCENDING precedence (nearer to the file = later). */
const SLOTS = [
	"global",
	"repoLegacy",
	"repo",
	"pkgLegacy",
	"pkg",
	"deepLegacy",
	"deep",
] as const;
type Slot = (typeof SLOTS)[number];
type Stack = Partial<Record<Slot, RulesValue>>;
type Cwd = "repo" | "pkg" | "deep";

/** The slots whose file the resolver reads when it starts at `cwd`. */
function visibleSlots(cwd: Cwd): readonly Slot[] {
	const depth = { repo: 0, pkg: 1, deep: 2 }[cwd];
	return SLOTS.filter((slot) => {
		if (slot === "global") return true;
		if (slot.startsWith("repo")) return true;
		if (slot.startsWith("pkg")) return depth >= 1;
		return depth >= 2;
	});
}

const GROUPING_KEYS = ["k", "K", " k ", "other", "__proto__"] as const;
const BASES = ["ra", "rb", "rc", "rd", "ts:2322", "S1219"] as const;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** A rule id. Hyphen-free on purpose: the `-js`-style suffix strip is the matcher's. */
const baseArb: fc.Arbitrary<string> = fc.oneof(
	{ weight: 6, arbitrary: fc.constantFrom(...BASES) },
	{ weight: 1, arbitrary: fc.stringMatching(/^[a-z]{2,5}[0-9]{1,3}$/) },
);

const spellingArb = fc.constantFrom<Spelling>("plain", "prefixed", "suffixed");

const idMemberArb: fc.Arbitrary<Member> = fc.record({
	kind: fc.constant("id" as const),
	base: baseArb,
	spelling: fc.oneof(
		{ weight: 3, arbitrary: fc.constant<Spelling>("plain") },
		{ weight: 1, arbitrary: spellingArb },
	),
});

const paddedMemberArb: fc.Arbitrary<Member> = fc.record({
	kind: fc.constant("padded" as const),
	base: baseArb,
});

const blankMemberArb: fc.Arbitrary<Member> = fc.record({
	kind: fc.constant("blank" as const),
	text: fc.constantFrom("", " ", "  ", "\t"),
});

const junkValueArb: fc.Arbitrary<unknown> = fc.oneof(
	fc.integer(),
	fc.double({ noNaN: true, noDefaultInfinity: true }),
	fc.constant(null),
	fc.boolean(),
	fc.constant({}),
	fc.constant([]),
	fc.constant(["ra"]),
	fc.constant({ a: "ra" }),
);

const junkMemberArb: fc.Arbitrary<Member> = fc.record({
	kind: fc.constant("junk" as const),
	value: junkValueArb,
});

/** A value in place of a list: what a typo or an older writer left behind. */
const badListValueArb: fc.Arbitrary<unknown> = fc.oneof(
	fc.constant(null),
	fc.constant("ra"),
	fc.integer(),
	fc.boolean(),
	fc.constant({}),
	fc.constant({ 0: "ra" }),
);

const badValueArb: fc.Arbitrary<unknown> = fc.oneof(
	fc.constant(null),
	fc.constant("ra"),
	fc.integer(),
	fc.boolean(),
	fc.constant([]),
	fc.constant(["ra"]),
);

interface DocOptions {
	/** Member kinds a `disable` list may hold. */
	disableMembers: Arbitrary<Member>;
	/** Member kinds a `select` list may hold. */
	selectMembers: Arbitrary<Member>;
	disable: boolean;
	select: boolean;
	/** Allow lists, entries and `rules` values that are not the right type. */
	bad: boolean;
}

type Arbitrary<T> = fc.Arbitrary<T>;

function listArb(
	members: Arbitrary<Member>,
	bad: boolean,
): Arbitrary<ListValue> {
	const list = fc.record({
		kind: fc.constant("list" as const),
		members: fc.array(members, { maxLength: 4 }),
	});
	if (!bad) return list;
	return fc.oneof(
		{ weight: 5, arbitrary: list },
		{
			weight: 1,
			arbitrary: fc.record({
				kind: fc.constant("bad" as const),
				value: badListValueArb,
			}),
		},
	);
}

function entryArb(options: DocOptions): Arbitrary<EntryValue> {
	const entry = fc
		.record(
			{
				...(options.disable
					? { disable: listArb(options.disableMembers, options.bad) }
					: {}),
				...(options.select
					? { select: listArb(options.selectMembers, options.bad) }
					: {}),
				threshold: fc.integer({ min: 1, max: 50 }),
				unrelated: fc.constant(true),
			},
			{ requiredKeys: [] },
		)
		.map((value): EntryValue => ({ kind: "entry", entry: value as Entry }));
	if (!options.bad) return entry;
	return fc.oneof(
		{ weight: 6, arbitrary: entry },
		{
			weight: 1,
			arbitrary: fc.record({
				kind: fc.constant("bad" as const),
				value: badValueArb,
			}),
		},
	);
}

function rulesArb(options: DocOptions): Arbitrary<RulesValue> {
	const keysAndEntries = fc
		.uniqueArray(
			fc.tuple(fc.constantFrom<string>(...GROUPING_KEYS), entryArb(options)),
			{ selector: ([key]) => key, maxLength: 4 },
		)
		.map((pairs): RulesValue => ({ kind: "block", entries: pairs }));
	const block = options.bad
		? // #444 wrote the lists directly under `rules`: a `disable` key holding an array.
			fc.oneof(
				{ weight: 6, arbitrary: keysAndEntries },
				{
					weight: 1,
					arbitrary: fc.constant<RulesValue>({
						kind: "block",
						entries: [
							[
								"disable",
								{
									kind: "bad",
									value: ["ra", "rb"],
								},
							],
						],
					}),
				},
			)
		: keysAndEntries;
	if (!options.bad) return block;
	return fc.oneof(
		{ weight: 8, arbitrary: block },
		{
			weight: 1,
			arbitrary: fc.record({
				kind: fc.constant("bad" as const),
				value: badValueArb,
			}),
		},
	);
}

function stackArb(options: DocOptions): Arbitrary<{ stack: Stack; cwd: Cwd }> {
	const slot = fc.option(rulesArb(options), { nil: undefined, freq: 2 });
	return fc
		.record({
			global: slot,
			repoLegacy: slot,
			repo: slot,
			pkgLegacy: slot,
			pkg: slot,
			deepLegacy: slot,
			deep: slot,
		})
		.chain((stack) =>
			fc.constantFrom<Cwd>("repo", "pkg", "deep").map((cwd) => ({
				stack: stack as Stack,
				cwd,
			})),
		);
}

const cleanMembers = fc.oneof(
	{ weight: 6, arbitrary: idMemberArb },
	{ weight: 1, arbitrary: paddedMemberArb },
	{ weight: 1, arbitrary: blankMemberArb },
);
const idOnlyMembers = idMemberArb;
/** Select members: a padded or blank entry would open the allowlist, so ids and junk only. */
const dirtySelectMembers = fc.oneof(
	{ weight: 4, arbitrary: idMemberArb },
	{ weight: 3, arbitrary: junkMemberArb },
);
const dirtyMembers = fc.oneof(
	{ weight: 4, arbitrary: idMemberArb },
	{ weight: 1, arbitrary: paddedMemberArb },
	{ weight: 1, arbitrary: blankMemberArb },
	{ weight: 3, arbitrary: junkMemberArb },
);

// ---------------------------------------------------------------------------
// Serialization: documents -> JSON text, in the released spellings
// ---------------------------------------------------------------------------

function memberText(member: Member): unknown {
	switch (member.kind) {
		case "id":
			if (member.spelling === "prefixed") return `ast-grep:${member.base}`;
			if (member.spelling === "suffixed") return `${member.base}-js`;
			return member.base;
		case "padded":
			return `  ${member.base} `;
		case "blank":
			return member.text;
		case "junk":
			return member.value;
	}
}

function listText(list: ListValue): unknown {
	return list.kind === "list" ? list.members.map(memberText) : list.value;
}

function entryText(value: EntryValue): unknown {
	if (value.kind === "bad") return value.value;
	const out: Record<string, unknown> = {};
	const { disable, select, threshold, unrelated } = value.entry;
	if (threshold !== undefined) out.threshold = threshold;
	if (disable) out.disable = listText(disable);
	if (select) out.select = listText(select);
	if (unrelated) out.note = "kept";
	return out;
}

/**
 * The JSON text of one `rules` value. Built by hand so a `__proto__` grouping
 * key is an own key of the parsed object, as a user's file would carry it
 * (`JSON.stringify` of an object literal would drop it).
 */
function rulesText(rules: RulesValue): string {
	const value =
		rules.kind === "bad"
			? JSON.stringify(rules.value)
			: `{${rules.entries
					.map(
						([key, e]) =>
							`${JSON.stringify(key)}:${JSON.stringify(entryText(e))}`,
					)
					.join(",")}}`;
	return `{"rules":${value}}`;
}

// ---------------------------------------------------------------------------
// The oracle: reads the generated documents only
// ---------------------------------------------------------------------------

/** The documents the resolver reads from `cwd`, in ascending precedence. */
function visibleDocs(stack: Stack, cwd: Cwd): RulesValue[] {
	return visibleSlots(cwd).flatMap((slot) => {
		const doc = stack[slot];
		return doc ? [doc] : [];
	});
}

/** `__proto__` is refused by the config core's prototype-key policy. */
const isUnsafeKey = (key: string): boolean => key === "__proto__";

function entriesOf(doc: RulesValue): [string, Entry][] {
	if (doc.kind !== "block") return [];
	const out: [string, Entry][] = [];
	for (const [key, value] of doc.entries) {
		if (isUnsafeKey(key) || value.kind !== "entry") continue;
		out.push([key, value.entry]);
	}
	return out;
}

/** The bases of the members that name a rule exactly (not padded or blank). */
function idBases(list: ListValue | undefined): string[] {
	if (!list || list.kind !== "list") return [];
	return list.members.flatMap((m) => (m.kind === "id" ? [m.base] : []));
}

function paddedBases(list: ListValue | undefined): string[] {
	if (!list || list.kind !== "list") return [];
	return list.members.flatMap((m) => (m.kind === "padded" ? [m.base] : []));
}

/** Every tier's valid `disable` members: the union a nearer tier cannot shrink. */
function expectedDisabled(docs: readonly RulesValue[]): Set<string> {
	const out = new Set<string>();
	for (const doc of docs)
		for (const [, entry] of entriesOf(doc))
			for (const base of idBases(entry.disable)) out.add(base);
	return out;
}

/**
 * The bases a padded `disable` member names. A hand-padded id (`" ra "`) does
 * not match `ra` in the resolved value today (the legacy project parser trims,
 * the dispatch path does not), so the oracle leaves those verdicts open rather
 * than pinning either reading.
 */
function paddedDisabled(docs: readonly RulesValue[]): Set<string> {
	const out = new Set<string>();
	for (const doc of docs)
		for (const [, entry] of entriesOf(doc))
			for (const base of paddedBases(entry.disable)) out.add(base);
	return out;
}

/**
 * The effective allowlist: per exact grouping key, the nearest tier that sets
 * `select` supplies the list (an empty list included), then every key's list
 * unions into one project-wide allowlist.
 */
function expectedSelect(docs: readonly RulesValue[]): Set<string> {
	const perKey = new Map<string, string[]>();
	for (const doc of docs)
		for (const [key, entry] of entriesOf(doc))
			if (entry.select?.kind === "list") perKey.set(key, idBases(entry.select));
	return new Set([...perKey.values()].flat());
}

function expectedDropped(
	base: string,
	disabled: ReadonlySet<string>,
	select: ReadonlySet<string>,
): boolean {
	if (disabled.has(base)) return true;
	return select.size > 0 && !select.has(base);
}

/** Every base the stack names, plus ones it never names. */
function queryBases(stack: Stack): string[] {
	const out = new Set<string>([...BASES, "zzz9"]);
	for (const doc of Object.values(stack))
		for (const [, entry] of entriesOf(doc ?? { kind: "bad", value: null })) {
			for (const b of idBases(entry.disable)) out.add(b);
			for (const b of paddedBases(entry.disable)) out.add(b);
			for (const b of idBases(entry.select)) out.add(b);
		}
	return [...out];
}

const SPELLED = (base: string): string[] => [
	base,
	`ast-grep:${base}`,
	`${base}-js`,
];

// ---------------------------------------------------------------------------
// The production chain under a real directory tree
// ---------------------------------------------------------------------------

const setConfigPath = useConfigPath();
let workDir: string;
let runSeq = 0;

beforeEach(() => {
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rule-merge-prop-"));
});

afterEach(() => {
	resetProjectLensConfigCache();
	removeTempDirSync(workDir);
});

/** The verdict function of one stack: id -> dropped, through the real seam. */
function verdictsOf(stack: Stack, cwd: Cwd): (ruleId: string) => boolean {
	const tmp = path.join(workDir, `run-${runSeq++}`);
	const globalDir = path.join(tmp, ".pi-lens");
	const repo = path.join(tmp, "repo");
	const dirs: Record<Cwd, string> = {
		repo,
		pkg: path.join(repo, "pkg"),
		deep: path.join(repo, "pkg", "deep"),
	};
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	fs.mkdirSync(dirs[cwd], { recursive: true });
	const files: Record<Slot, string> = {
		global: path.join(globalDir, "config.json"),
		repoLegacy: path.join(dirs.repo, "pi-lens.json"),
		repo: path.join(dirs.repo, ".pi-lens.json"),
		pkgLegacy: path.join(dirs.pkg, "pi-lens.json"),
		pkg: path.join(dirs.pkg, ".pi-lens.json"),
		deepLegacy: path.join(dirs.deep, "pi-lens.json"),
		deep: path.join(dirs.deep, ".pi-lens.json"),
	};
	for (const slot of SLOTS) {
		const doc = stack[slot];
		if (!doc) continue;
		fs.mkdirSync(path.dirname(files[slot]), { recursive: true });
		fs.writeFileSync(files[slot], rulesText(doc));
	}
	setConfigPath(files.global);
	resetProjectLensConfigCache();
	const policy = rulePolicyMapFromResolution(
		resolvePiLensConfig({
			cwd: dirs[cwd],
			globalDir,
			globalConfigPath: files.global,
			homeDir: tmp,
		}),
		repo,
	);
	return (ruleId) => evaluateRulePolicy(ruleId, policy).dropped;
}

/** The files a stack writes, in precedence order: the readable counterexample. */
function render(stack: Stack, cwd: Cwd): string {
	const lines = visibleSlots(cwd).flatMap((slot) => {
		const doc = stack[slot];
		return doc ? [`  ${slot}: ${rulesText(doc)}`] : [];
	});
	return `cwd=${cwd}\n${lines.join("\n") || "  (no config files)"}`;
}

const assertProperty = (property: fc.IPropertyWithHooks<unknown[]>) =>
	fc.assert(property, { numRuns: NUM_RUNS, seed: SEED });

describe("rules.<id> tier merge: properties (#5250)", () => {
	it(
		"disable is monotone: a tier added anywhere in the stack never removes a rule",
		{ timeout: PROPERTY_TIMEOUT_MS },
		() => {
			assertProperty(
				fc.property(
					stackArb({
						disable: true,
						select: false,
						disableMembers: cleanMembers,
						selectMembers: idOnlyMembers,
						bad: false,
					}),
					fc.constantFrom(...SLOTS),
					({ stack, cwd }, addedSlot) => {
						const dropped = verdictsOf(stack, cwd);
						const droppedWithout = verdictsOf(
							{ ...stack, [addedSlot]: undefined },
							cwd,
						);
						for (const base of queryBases(stack))
							for (const id of SPELLED(base))
								if (droppedWithout(id) && !dropped(id))
									throw new Error(
										`adding ${addedSlot} re-enabled ${id}\n${render(stack, cwd)}`,
									);
					},
				),
			);
		},
	);

	it(
		"the effective disable set is exactly the union of every tier's valid members",
		{ timeout: PROPERTY_TIMEOUT_MS },
		() => {
			assertProperty(
				fc.property(
					stackArb({
						disable: true,
						select: false,
						disableMembers: cleanMembers,
						selectMembers: idOnlyMembers,
						bad: false,
					}),
					({ stack, cwd }) => {
						const dropped = verdictsOf(stack, cwd);
						const docs = visibleDocs(stack, cwd);
						const open = paddedDisabled(docs);
						const union = expectedDisabled(docs);
						for (const base of queryBases(stack)) {
							if (open.has(base) && !union.has(base)) continue;
							for (const id of SPELLED(base))
								if (dropped(id) !== union.has(base))
									throw new Error(
										`${id}: dropped=${dropped(id)}, union says ${union.has(base)}\n${render(stack, cwd)}`,
									);
						}
					},
				),
			);
		},
	);

	it(
		"select replaces per grouping key: a nearer tier's k.select never drops another key's list",
		{ timeout: PROPERTY_TIMEOUT_MS },
		() => {
			assertProperty(
				fc.property(
					stackArb({
						disable: false,
						select: true,
						disableMembers: idOnlyMembers,
						selectMembers: idOnlyMembers,
						bad: false,
					}),
					({ stack, cwd }) => {
						const dropped = verdictsOf(stack, cwd);
						const select = expectedSelect(visibleDocs(stack, cwd));
						for (const base of queryBases(stack))
							for (const id of SPELLED(base))
								if (dropped(id) !== expectedDropped(base, new Set(), select))
									throw new Error(
										`${id}: dropped=${dropped(id)}, per-key select says ${[...select].join(",") || "no allowlist"}\n${render(stack, cwd)}`,
									);
					},
				),
			);
		},
	);

	it(
		"disable wins over select for the same rule, in every tier combination",
		{ timeout: PROPERTY_TIMEOUT_MS },
		() => {
			assertProperty(
				fc.property(
					stackArb({
						disable: true,
						select: true,
						disableMembers: idOnlyMembers,
						selectMembers: idOnlyMembers,
						bad: false,
					}),
					({ stack, cwd }) => {
						const dropped = verdictsOf(stack, cwd);
						const docs = visibleDocs(stack, cwd);
						const disabled = expectedDisabled(docs);
						const select = expectedSelect(docs);
						for (const base of queryBases(stack))
							for (const id of SPELLED(base)) {
								if (disabled.has(base) && !dropped(id))
									throw new Error(
										`${id} is disabled but select let it through\n${render(stack, cwd)}`,
									);
								if (dropped(id) !== expectedDropped(base, disabled, select))
									throw new Error(
										`${id}: dropped=${dropped(id)}, expected ${expectedDropped(base, disabled, select)}\n${render(stack, cwd)}`,
									);
							}
					},
				),
			);
		},
	);

	it(
		"a non-string disable or select member never throws and valid siblings keep their verdicts",
		{ timeout: PROPERTY_TIMEOUT_MS },
		() => {
			assertProperty(
				fc.property(
					stackArb({
						disable: true,
						select: true,
						disableMembers: dirtyMembers,
						selectMembers: dirtySelectMembers,
						bad: true,
					}),
					({ stack, cwd }) => {
						const dropped = verdictsOf(stack, cwd);
						const clean = verdictsOf(withoutJunk(stack), cwd);
						const docs = visibleDocs(stack, cwd);
						const disabled = expectedDisabled(docs);
						const open = paddedDisabled(docs);
						const select = expectedSelect(docs);
						for (const base of queryBases(stack))
							for (const id of SPELLED(base)) {
								// Removing the junk changes no verdict (and neither call threw).
								if (dropped(id) !== clean(id))
									throw new Error(
										`${id}: junk changed the verdict ${clean(id)} -> ${dropped(id)}\n${render(stack, cwd)}`,
									);
								// Valid siblings keep the verdict the valid members alone give.
								if (open.has(base) && !disabled.has(base)) continue;
								if (dropped(id) !== expectedDropped(base, disabled, select))
									throw new Error(
										`${id}: valid siblings lost their verdict, expected ${expectedDropped(base, disabled, select)}\n${render(stack, cwd)}`,
									);
							}
					},
				),
			);
		},
	);
});

/** The same stack with every non-string member and every non-list value removed. */
function withoutJunk(stack: Stack): Stack {
	const out: Stack = {};
	for (const slot of SLOTS) {
		const doc = stack[slot];
		if (!doc) continue;
		if (doc.kind !== "block") {
			out[slot] = { kind: "block", entries: [] };
			continue;
		}
		out[slot] = {
			kind: "block",
			entries: doc.entries.flatMap(([key, value]): [string, EntryValue][] => {
				if (value.kind !== "entry") return [];
				const { disable, select, ...rest } = value.entry;
				const kept: Entry = { ...rest };
				if (disable?.kind === "list")
					kept.disable = {
						kind: "list",
						members: disable.members.filter((m) => m.kind !== "junk"),
					};
				if (select?.kind === "list")
					kept.select = {
						kind: "list",
						members: select.members.filter((m) => m.kind !== "junk"),
					};
				return [[key, { kind: "entry", entry: kept }]];
			}),
		};
	}
	return out;
}
