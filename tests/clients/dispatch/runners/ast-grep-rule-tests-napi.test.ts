// #4496: every shipped `rule-tests/*-test.yml` `invalid:` snippet must still
// fire its rule through the napi evaluator. `ast-grep-rule-tests.test.ts`
// runs the same fixtures through the ast-grep CLI, which never reaches
// `evaluateAstGrepRules` or its literal prefilter.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import yaml from "../../../../clients/deps/js-yaml.js";
import type { AstGrepNapi } from "../../../../clients/deps/ast-grep-napi.js";
import { buildEffectiveAstGrepCatalog } from "../../../../clients/dispatch/ast-grep-catalog.js";
import {
	evaluateAstGrepRules,
	getLang,
	loadSg,
} from "../../../../clients/dispatch/runners/ast-grep-napi.js";
import { detectFileKind } from "../../../../clients/file-kinds.js";
import { assertNonEmptyScan } from "../../../support/sweep-kit.js";
import { removeTempDirSync } from "../../test-utils.js";

const TEST_DIR = path.join(
	process.cwd(),
	"rules",
	"ast-grep-rules",
	"rule-tests",
);
// Languages the napi evaluator parses; the other fixtures belong to the CLI.
const NAPI_EXTENSION: Readonly<Record<string, string>> = {
	typescript: "ts",
	tsx: "tsx",
	javascript: "js",
	css: "css",
	html: "html",
};

let sgModule: AstGrepNapi;
let cwd: string;

beforeAll(async () => {
	const loaded = await loadSg();
	if (!loaded) throw new Error("@ast-grep/napi failed to load");
	sgModule = loaded;
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rule-tests-napi-"));
});

afterAll(() => {
	removeTempDirSync(cwd);
});

describe("shipped rule-test fixtures through the napi evaluator", () => {
	it("every invalid snippet fires its rule", () => {
		const catalog = buildEffectiveAstGrepCatalog(cwd);
		const missed: string[] = [];
		let checked = 0;
		for (const name of fs
			.readdirSync(TEST_DIR)
			.filter((f) => f.endsWith("-test.yml"))) {
			const fixture = yaml.load(
				fs.readFileSync(path.join(TEST_DIR, name), "utf8"),
			) as {
				id: string;
				invalid?: string[];
			};
			const language = catalog.effectiveRules.get(fixture.id)?.rule.language;
			const extension =
				NAPI_EXTENSION[(language ?? "typescript").toLowerCase()];
			if (!extension) continue;
			const filePath = path.join(cwd, `snippet.${extension}`);
			for (const content of fixture.invalid ?? []) {
				checked++;
				const root = getLang(filePath, sgModule)?.parse(content).root();
				const fired =
					root !== undefined &&
					evaluateAstGrepRules(filePath, root, cwd, detectFileKind(filePath), {
						content,
						sgModule,
					}).some((d) => d.rule === fixture.id);
				if (!fired) missed.push(`${fixture.id}: ${content}`);
			}
		}
		// 706 napi-language invalid snippets on 2026-10-15.
		assertNonEmptyScan("napi rule-test invalid snippets", checked, 600);
		expect(missed).toEqual([]);
		// About 2.8 s here; 706 whole-catalog evaluations need headroom under load.
	}, 30_000);

	// #5466: the issue demotes both unchecked-throwing-call twins below
	// `error` (only `error` maps to blocking) because the lexical-try check is
	// intra-function — a caller's try/catch or a safe(() => …) wrapper is
	// invisible to it. Red-first: pre-fix these diagnostics report `error`.
	it("ships unchecked-throwing-call below the blocking tier", () => {
		const cases: Array<[string, string]> = [
			["unchecked-throwing-call", "snippet.ts"],
			["unchecked-throwing-call-js", "snippet.js"],
		];
		for (const [rule, name] of cases) {
			const content = "const data = JSON.parse(raw);";
			const filePath = path.join(cwd, name);
			const root = getLang(filePath, sgModule)?.parse(content).root();
			if (!root) throw new Error(`parse failed for ${name}`);
			const hit = evaluateAstGrepRules(
				filePath,
				root,
				cwd,
				detectFileKind(filePath),
				{
					content,
					sgModule,
				},
			).find((d) => d.rule === rule);
			expect(hit?.severity, rule).toBe("warning");
			expect(hit?.semantic, rule).not.toBe("blocking");
		}
	});

	// #5466: the CLI and napi engines can differ (a rejected rule silently
	// matches nothing), so the exemptions get their own napi witnesses — with
	// a live-rule control per family, so a dead rule cannot pass them
	// vacuously.
	it("napi honors the async and double-negation exemptions", () => {
		// [rule, file, content, mustFire] — mustFire rows are the controls.
		const cases: Array<[string, string, string, boolean]> = [
			["array-callback-return", "snippet.ts", "arr.map(x => { g(x) });", true],
			[
				"array-callback-return",
				"snippet.ts",
				"arr.map(async x => { await f(x) });",
				false,
			],
			[
				"array-callback-return",
				"snippet.ts",
				"arr.map(async()=>{ await f(1) });",
				false,
			],
			[
				"array-callback-return",
				"snippet.ts",
				"arr.map(async function (x) { await g(x) });",
				false,
			],
			[
				"array-callback-return",
				"snippet.ts",
				"arr.map(async function callback(x) { await g(x) });",
				false,
			],
			[
				"array-callback-return-js",
				"snippet.js",
				"arr.map(x => { g(x) });",
				true,
			],
			[
				"array-callback-return-js",
				"snippet.js",
				"arr.map(async x => { await f(x) });",
				false,
			],
			[
				"array-callback-return-js",
				"snippet.js",
				"arr.map(async function (x) { await g(x) });",
				false,
			],
			[
				"array-callback-return-js",
				"snippet.js",
				"arr.map(async function callback(x) { await g(x) });",
				false,
			],
			["no-negation-in-equality-check", "snippet.ts", "!a === b;", true],
			["no-negation-in-equality-check", "snippet.ts", "!a === !b;", false],
			["no-negation-in-equality-check", "snippet.ts", "!a !== !b;", false],
			["no-negation-in-equality-check", "snippet.ts", "!a == !b;", false],
			["no-negation-in-equality-check", "snippet.ts", "!a != !b;", false],
			["no-negation-in-equality-check-js", "snippet.js", "!a !== b;", true],
			["no-negation-in-equality-check-js", "snippet.js", "!a !== !b;", false],
			["no-negation-in-equality-check-js", "snippet.js", "!a === !b;", false],
			["no-negation-in-equality-check-js", "snippet.js", "!a == !b;", false],
			["no-negation-in-equality-check-js", "snippet.js", "!a != !b;", false],
		];
		for (const [rule, name, content, mustFire] of cases) {
			const filePath = path.join(cwd, name);
			const root = getLang(filePath, sgModule)?.parse(content).root();
			if (!root) throw new Error(`parse failed for ${content}`);
			const fired = evaluateAstGrepRules(
				filePath,
				root,
				cwd,
				detectFileKind(filePath),
				{ content, sgModule },
			).some((d) => d.rule === rule);
			expect(fired, `${rule}: ${content}`).toBe(mustFire);
		}
	});

	it("skips the native call for a rule whose required literal is absent", () => {
		const target = buildEffectiveAstGrepCatalog(cwd).effectiveRules.get(
			"no-insecure-randomness",
		)?.rule.rule;
		expect(target).toBeDefined();
		const filePath = path.join(cwd, "snippet.ts");
		const targetCalls = (content: string): number => {
			const root = getLang(filePath, sgModule)?.parse(content).root();
			let calls = 0;
			const counting = {
				findAll(config: { rule?: unknown }) {
					if (config.rule === target) calls++;
					return root?.findAll(config as never) ?? [];
				},
			};
			evaluateAstGrepRules(filePath, counting, cwd, detectFileKind(filePath), {
				content,
				sgModule,
			});
			return calls;
		};
		expect(targetCalls("const token = crypto.randomUUID();")).toBe(0);
		expect(targetCalls("const token = Math.random();")).toBe(1);
	});
});
