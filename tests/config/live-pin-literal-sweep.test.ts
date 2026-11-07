import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { workflowDocument } from "../../scripts/dispatch-safety.mjs";
import {
	assertNonEmptyScan,
	lineOf,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

// Recurrence #4418 and #4421: a test in tests/config hard-coded the SHA a
// workflow pins an action to (setup-node 6.5.0 in the Windows and targeted
// lanes; checkout in the early-start checkout census and writer-governance tests). Every
// Dependabot bump of that action moved the workflows and left the literal
// behind, so the bump PR went red on a test unrelated to it. A test that must
// agree with a workflow derives the pin from the workflow
// (`tests/support/sibling-pin.ts`, `siblingPin`).
//
// This sweep reds when a string or template literal under tests/config holds a
// 40-hex SHA that a workflow or composite action under .github pins today. It
// catches hard-coding, not fixture text: a fixture that spells an old or fake
// SHA is not a live pin and passes. Comments are blanked before the scan, so a
// comment quoting a pin neither trips nor excuses it; the literal is the
// evidence, so string contents are kept.
const ROOT = resolve(import.meta.dirname, "../..");
const GITHUB = resolve(ROOT, ".github");
const TESTS_CONFIG = resolve(ROOT, "tests/config");

// `uses: owner/repo[/path]@<40 hex>`; a tag or branch ref is not a pin.
const PINNED_USES = /@([0-9a-f]{40})$/;

function collectUses(node: unknown, out: Set<string>): void {
	if (Array.isArray(node)) {
		for (const item of node) collectUses(item, out);
	} else if (node && typeof node === "object") {
		for (const [key, value] of Object.entries(node)) {
			if (key === "uses" && typeof value === "string") {
				const pin = PINNED_USES.exec(value);
				if (pin) out.add(pin[1]);
			} else collectUses(value, out);
		}
	}
}

/** Every SHA a workflow or composite action under `.github` pins today. */
export function livePins(githubDir: string): Set<string> {
	const pins = new Set<string>();
	const files = listSourceFiles(githubDir, {
		extensions: [".yml", ".yaml"],
		exclude: (relative) =>
			!/^(workflows\/[^/]+|actions\/.+\/action)\.ya?ml$/.test(relative),
	});
	assertNonEmptyScan("workflow files under .github", files.length, 10);
	for (const file of files) {
		collectUses(workflowDocument(readFileSync(file, "utf8")), pins);
	}
	return pins;
}

/** `line:pin` for every live pin spelled in a literal of `source`. */
export function livePinLiterals(
	source: string,
	pins: ReadonlySet<string>,
): string[] {
	const code = stripSource(source, { strings: "keep" });
	const hits: string[] = [];
	for (const match of code.matchAll(/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/g)) {
		if (pins.has(match[0])) {
			hits.push(`${lineOf(code, match.index)}:${match[0]}`);
		}
	}
	return hits;
}

describe("tests/config derives live action pins instead of spelling them (#4418, #4421)", () => {
	const pins = livePins(GITHUB);

	it(
		"spells no live workflow pin in a literal",
		() => {
			const files = listSourceFiles(TESTS_CONFIG, { extensions: [".ts"] });
			assertNonEmptyScan("tests/config sources", files.length, 100);
			const findings = files.flatMap((file) =>
				livePinLiterals(readFileSync(file, "utf8"), pins).map(
					(hit) =>
						`${relativePosix(ROOT, file)}:${hit}: derive it with siblingPin (tests/support/sibling-pin.ts), or use a fake SHA in fixture text`,
				),
			);
			expect(findings).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	describe("the sweep reads literals, not prose", () => {
		const [pin] = [...pins];
		it(
			"has live pins to compare against",
			() => {
				assertNonEmptyScan("live pins under .github", pins.size, 10);
				expect(pin).toMatch(/^[0-9a-f]{40}$/);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it.each([
			["a double-quoted literal", `const a = "actions/checkout@${pin}";\n`, 1],
			["a template literal", `const a = \`uses: x@${pin}\`;\n`, 1],
			[
				"a line inside a multi-line literal",
				`const a = [\n"@${pin}",\n];\n`,
				2,
			],
		])(
			"reds on %s",
			(_name, source, line) => {
				expect(livePinLiterals(source, pins)).toEqual([`${line}:${pin}`]);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it.each([
			["a line comment", `// pinned at ${pin}\n`],
			["a block comment", `/* x@${pin} */\n`],
			["a fake SHA fixture", `const a = "x@${"4".repeat(40)}";\n`],
			[
				"a longer hex digest holding the pin",
				`const d = "${pin}${"0".repeat(24)}";\n`,
			],
			["a tag ref", 'const a = "actions/checkout@v7";\n'],
		])(
			"stays clean on %s",
			(_name, source) => {
				expect(livePinLiterals(source, pins)).toEqual([]);
			},
			TREE_WALK_TIMEOUT_MS,
		);

		it("reads only SHA pins out of a workflow, not tags", () => {
			const doc = workflowDocument(
				[
					"jobs:",
					"  j:",
					"    steps:",
					`      - uses: a/b@${"1".repeat(40)}`,
					"      - uses: c/d@v4",
					`      - run: echo e/f@${"2".repeat(40)}`,
				].join("\n"),
			);
			const found = new Set<string>();
			collectUses(doc, found);
			expect([...found]).toEqual(["1".repeat(40)]);
		});
	});
});
