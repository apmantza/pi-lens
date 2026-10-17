/**
 * Governance: every TLA+ config constant that mirrors a code choice is pinned
 * to the code's real behaviour (#4393).
 *
 * Recurrence: #4387. #4235 (55fa5210c) removed the read guard's injected
 * whole-file read on the zero-read allow, while `formal/read-guard` kept
 * modelling that read. The coverage rule (#3802) only checks that a PR
 * touching a modelled file mentions the model, so TLC stayed green on the old
 * design and two read-guard defects stayed invisible until an external
 * report. AGENTS.md shape 68 ("Model switch drift") names the class.
 *
 * `formal/switch-pins.json` classifies every constant of every family:
 *
 * - `pins`: the constant mirrors a code choice, and a named test drives the
 *   real code (a dispatcher or the guard's entry point) and asserts the
 *   behaviour of the pinned `value`; `also` names further tests when one
 *   value encodes several behaviours. Flipping the code reds that test;
 *   flipping the model without the registry reds this one. Flipping the
 *   model and the registry together, without the code, reds neither: the
 *   registry ties a constant to a title, not to what the test asserts, so a
 *   value change in the registry is the reviewer's to judge.
 * - `notCodeChoice`: a scenario bound, an actor set, an environment
 *   behaviour, a mutant-only design, or a switch the model reads only under
 *   another switch's old value. Each group carries its reason.
 * - `deferred`: a code choice with no pin yet, with its reason. A family in
 *   `FULLY_PINNED` may defer nothing, and the counts of deferred and
 *   notCodeChoice members are pinned exactly (`DEFERRED_COUNT`,
 *   `NOT_CODE_CHOICE_COUNT`).
 *
 * The population is every name a family's configs assign in a `CONSTANTS`
 * section, `=` or `<-` (the `<-` form covers a module switch such as
 * `ZeroReadInjects <- ZeroReadInjectsPre4387`), and every module
 * `Name == TRUE|FALSE` that no config substitutes as a `<-` target. The as-built configs are the
 * ones whose header says `\* expect: pass` (the existing convention; no
 * family has a separate "current" config). A pin's value must be what every
 * as-built config resolves the constant to: its `=` value, the definition its
 * `<-` names, or else the module's own `Name == <literal>` definition. A
 * value a config uses only to narrow the explored schedules is admitted per
 * pin, per value and per named config, in `narrowedBy`, with its reason; a
 * config the entry does not list must match the pinned value.
 *
 * Detectors match code, not prose (principles §2):
 * - TLA+ text (`.cfg` and `.tla`) is read after `stripTlaComments` blanks
 *   `\*` line comments and nested `(* *)` blocks, so a comment that quotes
 *   `ZeroReadInjects == FALSE` or an old assignment cannot decide a value.
 *   TLA+ string literals are values and stay intact.
 * - A pin's evidence is a test title, which is itself a string literal, so
 *   the per-needle policy is positional and liveness-checked: the title
 *   counts only as the first argument of an `it(...)` / `test(...)` call (or
 *   of the call an `it.each(...)` returns) that a run reaches, in a file
 *   vitest's own config collects (`vitestCollects`). `testDeclarations`
 *   (tests/support/sweep-kit.ts) decides that: a comment is not a call, and
 *   a skipped, todo, conditional (`skipIf`/`runIf`) or `fails` test (by
 *   chain, by options object, or by unread options), a test whose body calls
 *   a skip, a test in such a suite, a dead branch or an uncalled function,
 *   and an `.only` file's siblings are absent. The title is compared as written in
 *   source: escape sequences unexpanded and `${...}` placeholders verbatim.
 *   Not seen: an empty `each` table, an early `return` in a suite, and a
 *   parametrized pin whose pinned row was removed from its table.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseModelHeader } from "../../scripts/check-tla-models.mjs";
import { assertNonEmptyScan, testDeclarations } from "../support/sweep-kit.js";
import { vitestCollects } from "../support/vitest-collection.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const REGISTRY_PATH = "formal/switch-pins.json";
/** Families whose every code-choice constant has a pin (#4393 acceptance). */
const FULLY_PINNED = [
	"read-guard",
	"format-drain",
	"dispatch-pipeline",
	"blocker-pending",
	"cascade-delivery",
];
/**
 * The deferred and notCodeChoice members across all families, pinned exactly
 * (#4399 verify r2 F4). A ceiling let a freed slot be reused, and let a member
 * move from `deferred` to `notCodeChoice` while a new code choice took its
 * place. Every change to either count is now a visible edit here: lower
 * `DEFERRED_COUNT` as pins land, and a reviewer judges every rise of either.
 */
const DEFERRED_COUNT = 136;
const NOT_CODE_CHOICE_COUNT = 233;

interface PinTest {
	test: string;
	title: string;
}
interface Pin extends PinTest {
	value: string;
	/** Further tests, when one value encodes several behaviours (a model
	 *  definition such as `SpendLicense == BridgeNoAdvance` reuses it). */
	also?: PinTest[];
	/** Per value, the as-built configs (file stems) that use it only to narrow
	 *  the explored schedules, with the reason. */
	narrowedBy?: Record<string, { configs: string[]; reason: string }>;
}
interface Group {
	reason: string;
	constants: string[];
}
interface FamilyEntry {
	pins?: Record<string, Pin>;
	notCodeChoice?: Group[];
	deferred?: Group[];
}
interface Registry {
	families: Record<string, FamilyEntry>;
}

/**
 * Blank TLA+ comments in place (`\*` to end of line, nested `(* *)`), keeping
 * string literals and newlines. A `\*` or `(*` inside a string is text.
 */
export function stripTlaComments(text: string): string {
	const out = text.split("");
	let depth = 0;
	let inString = false;
	let lineComment = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (lineComment) {
			if (ch === "\n") lineComment = false;
			else out[i] = " ";
			continue;
		}
		if (depth > 0) {
			if (ch === "(" && next === "*") {
				depth++;
				out[i] = " ";
				out[i + 1] = " ";
				i++;
			} else if (ch === "*" && next === ")") {
				depth--;
				out[i] = " ";
				out[i + 1] = " ";
				i++;
			} else if (ch !== "\n") out[i] = " ";
			continue;
		}
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "\\" && next === "*") {
			lineComment = true;
			out[i] = " ";
			out[i + 1] = " ";
			i++;
		} else if (ch === "(" && next === "*") {
			depth = 1;
			out[i] = " ";
			out[i + 1] = " ";
			i++;
		}
	}
	return out.join("");
}

/** Collapse whitespace outside TLA+ string literals. */
function normalizeValue(value: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (inString) {
			out += ch;
			if (ch === "\\") out += value[++i] ?? "";
			else if (ch === '"') inString = false;
		} else if (ch === '"') {
			inString = true;
			out += ch;
		} else if (!/\s/.test(ch)) out += ch;
	}
	return out;
}

const CFG_KEYWORD =
	/^\s*(CONSTANTS?|SPECIFICATION|INIT|NEXT|INVARIANTS?|PROPERTY|PROPERTIES|CHECK_DEADLOCK|CONSTRAINTS?|ACTION_CONSTRAINTS?|SYMMETRY|VIEW|ALIAS|POSTCONDITION)\b(.*)$/;

export interface CfgAssignment {
	kind: "=" | "<-";
	value: string;
}

/** The `CONSTANTS` assignments of a `.cfg`, read from comment-blanked text. */
export function parseCfgConstants(text: string): Map<string, CfgAssignment> {
	const entries = new Map<string, CfgAssignment>();
	let inConstants = false;
	let current: string | undefined;
	for (const raw of stripTlaComments(text).split("\n")) {
		let line = raw;
		const keyword = CFG_KEYWORD.exec(line);
		if (keyword) {
			inConstants = /^CONSTANTS?$/.test(keyword[1]);
			current = undefined;
			line = keyword[2];
		}
		if (!inConstants || line.trim() === "") continue;
		const start = /^\s*([A-Za-z_]\w*)\s*(=|<-)\s*(.*)$/.exec(line);
		if (start) {
			current = start[1];
			entries.set(current, {
				kind: start[2] as "=" | "<-",
				value: start[3],
			});
		} else if (current !== undefined) {
			const entry = entries.get(current);
			if (entry) entry.value += ` ${line}`;
		}
	}
	for (const entry of entries.values())
		entry.value = normalizeValue(entry.value);
	return entries;
}

/** Top-level one-line `Name == <literal>` definitions of a `.tla` module. */
export function parseLiteralDefinitions(text: string): Map<string, string> {
	const defs = new Map<string, string>();
	for (const match of stripTlaComments(text).matchAll(
		/^([A-Za-z_]\w*)\s*==\s*(TRUE|FALSE|-?\d+|"(?:[^"\\]|\\.)*")\s*$/gm,
	))
		defs.set(match[1], match[2]);
	return defs;
}

/**
 * Titles of the `it`/`test` declarations a run reaches, as written in source
 * (the shared walker, {@link testDeclarations}). A skipped, todo,
 * conditional or `fails` test, one in a skipped suite, a dead branch or an
 * uncalled function, and an `.only` file's siblings are absent.
 */
export function declaredTestTitles(source: string): Set<string> {
	return new Set(
		testDeclarations(source)
			.filter(
				(declaration) =>
					declaration.live &&
					(declaration.callee === "it" || declaration.callee === "test"),
			)
			.map((declaration) => declaration.title),
	);
}

interface FamilyModels {
	/** Every name a config of the family assigns, `=` or `<-`, and every
	 *  module boolean definition that is not a `<-` target. */
	population: Set<string>;
	/** Each `\* expect: pass` config with its module's literal definitions and
	 *  its comment-blanked text (undefined when the module file is absent). */
	asBuilt: Array<{
		file: string;
		constants: Map<string, CfgAssignment>;
		defs: Map<string, string>;
		moduleText: string | undefined;
	}>;
}

function readFamily(root: string, family: string): FamilyModels {
	const dir = path.join(root, "formal", family);
	const population = new Set<string>();
	const asBuilt: FamilyModels["asBuilt"] = [];
	const defsByModule = new Map<string, Map<string, string>>();
	const textByModule = new Map<string, string | undefined>();
	const targets = new Set<string>();
	for (const name of fs.readdirSync(dir).sort()) {
		if (!name.endsWith(".cfg")) continue;
		const text = fs.readFileSync(path.join(dir, name), "utf8");
		const constants = parseCfgConstants(text);
		for (const [constant, assignment] of constants) {
			population.add(constant);
			if (assignment.kind === "<-") targets.add(assignment.value);
		}
		const header = parseModelHeader(text);
		if ("error" in header || header.expect.status !== "pass") continue;
		let defs = defsByModule.get(header.module);
		if (!defs) {
			const tla = path.join(dir, `${header.module}.tla`);
			const moduleText = fs.existsSync(tla)
				? stripTlaComments(fs.readFileSync(tla, "utf8"))
				: undefined;
			defs =
				moduleText === undefined
					? new Map()
					: parseLiteralDefinitions(moduleText);
			defsByModule.set(header.module, defs);
			textByModule.set(header.module, moduleText);
		}
		asBuilt.push({
			file: `formal/${family}/${name}`,
			constants,
			defs,
			moduleText: textByModule.get(header.module),
		});
	}
	// A module's own boolean switch (`Name == TRUE`) that no config assigns is
	// a code choice too (#4399 review F4); a `<-` target such as
	// `ZeroReadInjectsPre4387` is a mutant's value, not a switch.
	for (const name of fs.readdirSync(dir).sort()) {
		if (!name.endsWith(".tla")) continue;
		const defs = parseLiteralDefinitions(
			fs.readFileSync(path.join(dir, name), "utf8"),
		);
		for (const [constant, value] of defs)
			if ((value === "TRUE" || value === "FALSE") && !targets.has(constant))
				population.add(constant);
	}
	return { population, asBuilt };
}

/**
 * The value an as-built config gives `constant`: its `=` value, the literal
 * definition its `<-` names, or the module's own literal definition.
 */
function resolveValue(
	config: FamilyModels["asBuilt"][number],
	constant: string,
): string | undefined {
	const assigned = config.constants.get(constant);
	if (assigned?.kind === "=") return assigned.value;
	return config.defs.get(assigned?.value ?? constant);
}

/** Every disagreement between the registry, the models and the tests. */
export function auditSwitchPins(root: string, registry: Registry): string[] {
	const errors: string[] = [];
	const formal = path.join(root, "formal");
	const familyDirs = fs
		.readdirSync(formal, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const listed = Object.keys(registry.families ?? {});
	for (const family of listed)
		if (!familyDirs.includes(family))
			errors.push(
				`${family}: listed in ${REGISTRY_PATH} but no formal/${family}/`,
			);
	const titleCache = new Map<string, Set<string> | undefined>();
	for (const family of familyDirs) {
		const entry = registry.families?.[family];
		if (!entry) {
			errors.push(
				`${family}: formal/${family}/ has no entry in ${REGISTRY_PATH}`,
			);
			continue;
		}
		const models = readFamily(root, family);
		const seen = new Map<string, string>();
		const classify = (constant: string, where: string) => {
			const prior = seen.get(constant);
			if (prior)
				errors.push(
					`${family}.${constant}: classified twice (${prior}, ${where})`,
				);
			seen.set(constant, where);
		};
		for (const constant of Object.keys(entry.pins ?? {}))
			classify(constant, "pins");
		for (const kind of ["notCodeChoice", "deferred"] as const)
			for (const group of entry[kind] ?? []) {
				if (!group.reason?.trim())
					errors.push(`${family}: a ${kind} group has no reason`);
				for (const constant of group.constants ?? []) classify(constant, kind);
			}
		for (const constant of models.population)
			if (!seen.has(constant))
				errors.push(
					`${family}.${constant}: unclassified; pin it, or give a notCodeChoice or deferred reason`,
				);
		for (const constant of seen.keys())
			if (!models.population.has(constant))
				errors.push(
					`${family}.${constant}: stale; no config of the family assigns it`,
				);
		if (FULLY_PINNED.includes(family) && (entry.deferred ?? []).length > 0)
			errors.push(`${family}: fully pinned, so it may defer nothing`);
		for (const [constant, pin] of Object.entries(entry.pins ?? {})) {
			const label = `${family}.${constant}`;
			const narrowedBy = pin.narrowedBy ?? {};
			// value -> the as-built configs (file stems) that resolve to it
			const used = new Map<string, Set<string>>();
			for (const config of models.asBuilt) {
				const value = resolveValue(config, constant);
				if (value === undefined) {
					// A config of another module of the family (SiblingRestore.tla
					// beside DispatchPipeline.tla): a module whose code never names
					// the constant has no value for it, and nothing to compare.
					if (
						config.moduleText !== undefined &&
						!new RegExp(`\\b${constant}\\b`).test(config.moduleText)
					)
						continue;
					errors.push(
						`${label}: ${config.file} gives no literal value to compare`,
					);
					continue;
				}
				const stem = path.basename(config.file, ".cfg");
				used.set(value, (used.get(value) ?? new Set<string>()).add(stem));
				// Per config, not per value: a value admitted for one config must
				// not hide the same value in another (#4393: RestoreGatesHold = TRUE
				// stayed admitted for the headline config by a sibling's narrowing).
				if (value !== pin.value && !narrowedBy[value]?.configs?.includes(stem))
					errors.push(
						`${label}: pinned ${pin.value}, but ${config.file} (expect: pass) has ${value}`,
					);
			}
			if (!used.has(pin.value))
				errors.push(
					`${label}: no as-built config has the pinned value ${pin.value}`,
				);
			for (const [value, entry] of Object.entries(narrowedBy)) {
				if (!entry.reason?.trim())
					errors.push(`${label}: narrowedBy ${value} has no reason`);
				if (value === pin.value)
					errors.push(`${label}: narrowedBy ${value} is the pinned value`);
				if (!entry.configs?.length)
					errors.push(`${label}: narrowedBy ${value} names no config`);
				for (const stem of entry.configs ?? [])
					if (!used.get(value)?.has(stem))
						errors.push(
							`${label}: stale narrowedBy ${value}; ${stem} is no as-built config with that value`,
						);
			}
			for (const { test, title } of [pin, ...(pin.also ?? [])]) {
				if (!vitestCollects(test)) {
					errors.push(
						`${label}: pin test ${test} is not a test file vitest collects`,
					);
					continue;
				}
				if (!titleCache.has(test)) {
					const file = path.join(root, test);
					titleCache.set(
						test,
						fs.existsSync(file)
							? declaredTestTitles(fs.readFileSync(file, "utf8"))
							: undefined,
					);
				}
				const titles = titleCache.get(test);
				if (!titles) errors.push(`${label}: pin test ${test} does not exist`);
				else if (!titles.has(title))
					errors.push(`${label}: ${test} declares no test titled "${title}"`);
			}
		}
	}
	return errors;
}

function loadRegistry(root: string): Registry {
	return JSON.parse(fs.readFileSync(path.join(root, REGISTRY_PATH), "utf8"));
}

describe("TLA+ switch pins (#4393, recurrence #4387)", () => {
	it("pins or classifies every constant of every family, and each pin agrees with its as-built configs", () => {
		const registry = loadRegistry(REPO_ROOT);
		// Floors: a parser that read nothing would report a clean registry.
		const readGuard = readFamily(REPO_ROOT, "read-guard");
		assertNonEmptyScan("read-guard as-built configs", readGuard.asBuilt.length);
		expect(readGuard.population).toContain("ZeroReadInjects");
		expect(readGuard.population).toContain("AuthorIdentity");
		// The value itself is the audit's to judge; the floor only proves the
		// resolver reached a module definition.
		expect(resolveValue(readGuard.asBuilt[0], "ZeroReadInjects")).toMatch(
			/^(TRUE|FALSE)$/,
		);
		assertNonEmptyScan(
			"read-guard pins",
			Object.keys(registry.families["read-guard"]?.pins ?? {}).length,
		);
		expect(auditSwitchPins(REPO_ROOT, registry)).toEqual([]);
		const members = (kind: "deferred" | "notCodeChoice") =>
			Object.values(registry.families).flatMap((entry) =>
				(entry[kind] ?? []).flatMap((group) => group.constants),
			).length;
		expect(members("deferred")).toBe(DEFERRED_COUNT);
		expect(members("notCodeChoice")).toBe(NOT_CODE_CHOICE_COUNT);
	});

	describe("on a fixture tree", () => {
		let root: string | undefined;
		afterEach(() => {
			if (root) fs.rmSync(root, { recursive: true, force: true });
			root = undefined;
		});

		const MODULE = [
			"---- MODULE M ----",
			"CONSTANTS Mode, Size",
			"\\* Inject == FALSE   (a comment quoting the old value)",
			"Inject == TRUE",
			"InjectPre == FALSE",
			"====",
		].join("\n");
		const cfg = (expect: string, body: string) =>
			[
				`\\* expect: ${expect}`,
				"\\* module: M",
				"CONSTANTS",
				body,
				"SPECIFICATION Spec",
				"CHECK_DEADLOCK FALSE",
			].join("\n");
		const TEST = [
			'it("pins the injection", () => {});',
			'it.each([1, 2])("pins mode %s", () => {});',
			'// it("a fake pin", () => {});',
			'const t = "a string pin";',
			'it.skip("a skipped pin", () => {});',
			'describe("a live suite", () => {',
			"\tfor (const n of [1, 2]) {",
			'\t\tit("a loop pin", () => {});',
			"\t}",
			"});",
			'describe.skip("a skipped suite", () => {',
			'\tit("a pin in a skipped suite", () => {});',
			"});",
			'describe.skipIf(true)("a conditional suite", () => {',
			'\tit("a pin in a conditional suite", () => {});',
			"});",
			'if (process.pid < 0) it("a pin in a dead branch", () => {});',
			'const never = () => it("a pin in an uncalled function", () => {});',
			'it.todo("a todo pin");',
			'test.skip("a skipped test pin", () => {});',
			'it("an options-skipped pin", { skip: true }, () => {});',
			'it("an options-todo pin", { todo: true }, () => {});',
			'it("an options-fails pin", { fails: true }, () => {});',
			"const opts = { skip: true };",
			'it("a pin with unread options", opts, () => {});',
			'it("a pin with a timeout option", { timeout: 5, skip: false }, () => {});',
			'it("a pin with a timeout", () => {}, 30_000);',
			'describe("an options-skipped suite", { skip: true }, () => {',
			'\tit("a pin in an options-skipped suite", () => {});',
			"});",
			'it("a pin that skips itself", (ctx) => {',
			"\tctx.skip();",
			"});",
			'it("a pin that skips by its parameter", ({ skip }) => {',
			"\tskip();",
			"});",
		].join("\n");
		/** A file with an `.only`: its siblings never run. */
		const ONLY = [
			'it.only("the only test", () => {});',
			'it("a sibling of an only", () => {});',
		].join("\n");
		/** The same through an options object. */
		const OPTIONS_ONLY = [
			'it("the options-only test", { only: true }, () => {});',
			'it("a sibling of an options only", () => {});',
		].join("\n");
		/** A support module: vitest never collects it, whatever it declares. */
		const SUPPORT = 'it("a support pin", () => {});';

		function tree(cfgs: Record<string, string>) {
			root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-switch-pins-"));
			fs.mkdirSync(path.join(root, "formal", "fam"), { recursive: true });
			fs.mkdirSync(path.join(root, "tests"));
			fs.writeFileSync(path.join(root, "formal", "fam", "M.tla"), MODULE);
			for (const [name, text] of Object.entries({
				"Mutant.cfg": MUTANT,
				...cfgs,
			}))
				fs.writeFileSync(path.join(root, "formal", "fam", name), text);
			fs.writeFileSync(path.join(root, "tests", "p.test.ts"), TEST);
			fs.writeFileSync(path.join(root, "tests", "only.test.ts"), ONLY);
			fs.writeFileSync(path.join(root, "tests", "support.ts"), SUPPORT);
			fs.writeFileSync(
				path.join(root, "tests", "options-only.test.ts"),
				OPTIONS_ONLY,
			);
			// vitest.config.ts excludes tests/fixtures/**, so this never runs.
			fs.mkdirSync(path.join(root, "tests", "fixtures"));
			fs.writeFileSync(
				path.join(root, "tests", "fixtures", "f.test.ts"),
				SUPPORT,
			);
			return root;
		}
		const PASS = cfg("pass", '    Mode = "on"\n    Size = 2');
		const MUTANT = cfg(
			"violated Inv",
			'    Mode = "off"\n    Size = 2\n    Inject <- InjectPre',
		);
		const registry = (pins: Record<string, Pin>, extra: FamilyEntry = {}) => ({
			families: {
				fam: {
					pins,
					notCodeChoice: [{ reason: "a scenario bound", constants: ["Size"] }],
					...extra,
				},
			},
		});
		const GOOD: Record<string, Pin> = {
			Inject: {
				value: "TRUE",
				test: "tests/p.test.ts",
				title: "pins the injection",
			},
			Mode: { value: '"on"', test: "tests/p.test.ts", title: "pins mode %s" },
		};

		it("accepts pins that agree with every as-built config", () => {
			const fixture = tree({ "Pass.cfg": PASS, "Mutant.cfg": MUTANT });
			expect(auditSwitchPins(fixture, registry(GOOD))).toEqual([]);
		});

		it("reds a pin whose value an as-built config contradicts", () => {
			const fixture = tree({
				"Pass.cfg": PASS,
				"Old.cfg": cfg(
					"pass",
					'    Mode = "on"\n    Size = 2\n    Inject <- InjectPre',
				),
			});
			expect(auditSwitchPins(fixture, registry(GOOD))).toEqual([
				"fam.Inject: pinned TRUE, but formal/fam/Old.cfg (expect: pass) has FALSE",
			]);
		});

		it("reds a model flip the registry did not follow", () => {
			const fixture = tree({ "Pass.cfg": PASS });
			fs.writeFileSync(
				path.join(fixture, "formal", "fam", "M.tla"),
				MODULE.replace("Inject == TRUE", "Inject == FALSE"),
			);
			expect(auditSwitchPins(fixture, registry(GOOD))).toEqual([
				"fam.Inject: pinned TRUE, but formal/fam/Pass.cfg (expect: pass) has FALSE",
				"fam.Inject: no as-built config has the pinned value TRUE",
			]);
		});

		it("does not let a comment decide a config value", () => {
			const fixture = tree({
				"Pass.cfg": cfg(
					"pass",
					'    Mode = "off" \\* Mode = "on"\n    (* Mode = "on" *)\n    Size = 2',
				),
			});
			expect(auditSwitchPins(fixture, registry(GOOD))).toEqual([
				'fam.Mode: pinned "on", but formal/fam/Pass.cfg (expect: pass) has "off"',
				'fam.Mode: no as-built config has the pinned value "on"',
			]);
		});

		it("reds a module switch no config assigns, but not a mutant's target", () => {
			// Recurrence: #4399 review F4. A `.tla`-only `Name == TRUE` was
			// outside the population, so a new switch needed no pin.
			const fixture = tree({ "Pass.cfg": PASS });
			fs.writeFileSync(
				path.join(fixture, "formal", "fam", "M.tla"),
				MODULE.replace("====", "NewSwitch == TRUE\n===="),
			);
			expect(auditSwitchPins(fixture, registry(GOOD))).toEqual([
				"fam.NewSwitch: unclassified; pin it, or give a notCodeChoice or deferred reason",
			]);
		});

		it("reds a constant with no classification, and a stale one", () => {
			const fixture = tree({ "Pass.cfg": PASS });
			const { Mode: _mode, ...withoutMode } = GOOD;
			expect(
				auditSwitchPins(
					fixture,
					registry(withoutMode, {
						deferred: [{ reason: "later", constants: ["Gone"] }],
					}),
				),
			).toEqual([
				"fam.Mode: unclassified; pin it, or give a notCodeChoice or deferred reason",
				"fam.Gone: stale; no config of the family assigns it",
			]);
		});

		it("does not let a comment, a stray string or a skipped test name a pin (self-excuse)", () => {
			const fixture = tree({ "Pass.cfg": PASS });
			const pins = (title: string) => ({
				...GOOD,
				Inject: { ...GOOD.Inject, title },
			});
			for (const title of ["a fake pin", "a string pin", "a skipped pin"])
				expect(auditSwitchPins(fixture, registry(pins(title)))).toEqual([
					`fam.Inject: tests/p.test.ts declares no test titled "${title}"`,
				]);
		});

		it("does not let a skipped or conditional suite, a dead branch, an uncalled function, a todo, an only's sibling or a support file name a pin", () => {
			// Recurrence: #4399 review F1. Each form left the gate green on the
			// real tree while vitest never ran the pin (a skipped pin is a
			// deleted pin).
			const fixture = tree({ "Pass.cfg": PASS });
			const pinAt = (test: string, title: string) =>
				registry({ ...GOOD, Inject: { ...GOOD.Inject, test, title } });
			expect(
				auditSwitchPins(fixture, pinAt("tests/p.test.ts", "a loop pin")),
			).toEqual([]);
			for (const title of [
				"a pin in a skipped suite",
				"a pin in a conditional suite",
				"a pin in a dead branch",
				"a pin in an uncalled function",
				"a todo pin",
				"a skipped test pin",
			])
				expect(
					auditSwitchPins(fixture, pinAt("tests/p.test.ts", title)),
				).toEqual([
					`fam.Inject: tests/p.test.ts declares no test titled "${title}"`,
				]);
			expect(
				auditSwitchPins(
					fixture,
					pinAt("tests/only.test.ts", "a sibling of an only"),
				),
			).toEqual([
				'fam.Inject: tests/only.test.ts declares no test titled "a sibling of an only"',
			]);
			expect(
				auditSwitchPins(fixture, pinAt("tests/support.ts", "a support pin")),
			).toEqual([
				"fam.Inject: pin test tests/support.ts is not a test file vitest collects",
			]);
		});

		it("does not let an options-object skip, unread options, a body skip, an options .only's sibling or an excluded file name a pin", () => {
			// Recurrence: #4399 verify r2 F2, F3 and Q5. Each form left both
			// gates green while vitest skipped the test or never collected the
			// file (state-space rows 7 to 10, 12 and 14).
			const fixture = tree({ "Pass.cfg": PASS });
			const pinAt = (test: string, title: string) =>
				registry({ ...GOOD, Inject: { ...GOOD.Inject, test, title } });
			for (const title of [
				"a pin with a timeout option",
				"a pin with a timeout",
			])
				expect(
					auditSwitchPins(fixture, pinAt("tests/p.test.ts", title)),
				).toEqual([]);
			for (const title of [
				"an options-skipped pin",
				"an options-todo pin",
				"an options-fails pin",
				"a pin with unread options",
				"a pin in an options-skipped suite",
				"a pin that skips itself",
				"a pin that skips by its parameter",
			])
				expect(
					auditSwitchPins(fixture, pinAt("tests/p.test.ts", title)),
				).toEqual([
					`fam.Inject: tests/p.test.ts declares no test titled "${title}"`,
				]);
			expect(
				auditSwitchPins(
					fixture,
					pinAt("tests/options-only.test.ts", "a sibling of an options only"),
				),
			).toEqual([
				'fam.Inject: tests/options-only.test.ts declares no test titled "a sibling of an options only"',
			]);
			expect(
				auditSwitchPins(
					fixture,
					pinAt("tests/fixtures/f.test.ts", "a support pin"),
				),
			).toEqual([
				"fam.Inject: pin test tests/fixtures/f.test.ts is not a test file vitest collects",
			]);
		});

		it("checks every further test a pin names in also", () => {
			// Recurrence: #4399 review F2. One value encoded two behaviours
			// (SpendLicense == BridgeNoAdvance) and only one had a test.
			const fixture = tree({ "Pass.cfg": PASS });
			const also = [{ test: "tests/p.test.ts", title: "a gone pin" }];
			expect(
				auditSwitchPins(
					fixture,
					registry({ ...GOOD, Inject: { ...GOOD.Inject, also } }),
				),
			).toEqual([
				'fam.Inject: tests/p.test.ts declares no test titled "a gone pin"',
			]);
		});

		it("admits a narrowing value only with its reason", () => {
			const fixture = tree({
				"Pass.cfg": PASS,
				"Narrow.cfg": cfg("pass", '    Mode = "atomic"\n    Size = 2'),
			});
			expect(auditSwitchPins(fixture, registry(GOOD))).toEqual([
				'fam.Mode: pinned "on", but formal/fam/Narrow.cfg (expect: pass) has "atomic"',
			]);
			const narrowed = {
				...GOOD,
				Mode: {
					...GOOD.Mode,
					narrowedBy: {
						'"atomic"': { configs: ["Narrow"], reason: "a schedule on admits" },
					},
				},
			};
			expect(auditSwitchPins(fixture, registry(narrowed))).toEqual([]);
		});

		it("admits a narrowing value for the configs it names, not for every config that has it", () => {
			// Recurrence: narrowedBy was value-wide, so flipping the headline config
			// of dispatch-pipeline (SiblingRestoreQueued RestoreGatesHold FALSE to
			// TRUE) stayed green: a sibling config already had TRUE admitted (#4393).
			const fixture = tree({
				"Pass.cfg": PASS,
				"Narrow.cfg": cfg("pass", '    Mode = "atomic"\n    Size = 2'),
				"Flipped.cfg": cfg("pass", '    Mode = "atomic"\n    Size = 2'),
			});
			const narrowed = {
				...GOOD,
				Mode: {
					...GOOD.Mode,
					narrowedBy: {
						'"atomic"': { configs: ["Narrow"], reason: "a schedule on admits" },
					},
				},
			};
			expect(auditSwitchPins(fixture, registry(narrowed))).toEqual([
				'fam.Mode: pinned "on", but formal/fam/Flipped.cfg (expect: pass) has "atomic"',
			]);
			// A listed config that no longer has the value, or is unknown, is stale.
			const stale = {
				...GOOD,
				Mode: {
					...GOOD.Mode,
					narrowedBy: {
						'"atomic"': {
							configs: ["Narrow", "Flipped", "Pass"],
							reason: "a schedule on admits",
						},
					},
				},
			};
			expect(auditSwitchPins(fixture, registry(stale))).toEqual([
				'fam.Mode: stale narrowedBy "atomic"; Pass is no as-built config with that value',
			]);
		});

		it("compares a constant only against the as-built configs of modules that name it", () => {
			// Recurrence: formal/dispatch-pipeline holds two modules
			// (DispatchPipeline.tla and SiblingRestore.tla). The pass configs of one
			// assign none of the other's constants, and the gate read that absence
			// as a config with no value, so neither module's constants could be
			// pinned (#4393).
			const fixture = tree({ "Pass.cfg": PASS });
			fs.writeFileSync(
				path.join(fixture, "formal", "fam", "N.tla"),
				["---- MODULE N ----", "CONSTANTS Other", "===="].join("\n"),
			);
			fs.writeFileSync(
				path.join(fixture, "formal", "fam", "Other.cfg"),
				[
					"\\* expect: pass",
					"\\* module: N",
					"CONSTANTS",
					"    Other = 1",
					"SPECIFICATION Spec",
				].join("\n"),
			);
			const both = {
				notCodeChoice: [{ reason: "bounds", constants: ["Size", "Other"] }],
			};
			expect(auditSwitchPins(fixture, registry(GOOD, both))).toEqual([]);
			// A config of the module that does name the constant still needs a value.
			fs.writeFileSync(
				path.join(fixture, "formal", "fam", "NoMode.cfg"),
				cfg("pass", "    Size = 2"),
			);
			expect(auditSwitchPins(fixture, registry(GOOD, both))).toEqual([
				"fam.Mode: formal/fam/NoMode.cfg gives no literal value to compare",
			]);
		});
	});
});
