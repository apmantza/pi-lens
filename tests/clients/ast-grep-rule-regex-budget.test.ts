// flake-shape: elapsed-time-assertion — the defect under test IS wall-clock.
// The rule-language scan runs synchronously before ast-grep starts, so a
// quadratic match blocks the host event loop and a fake clock measures nothing.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AstGrepClient,
	extractRuleLanguage,
} from "../../clients/ast-grep-client.js";

const BUDGET_MS = 1000;
const ADVERSARIAL_BLANK_LINES = 199_000;
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function oldRuleLanguage(ruleYaml: string): string | undefined {
	return /^\s*language:\s*([^\s#]+)/im.exec(ruleYaml)?.[1];
}

function yamlFiles(root: string): string[] {
	const files: string[] = [];
	const visit = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(file);
			else if (/\.ya?ml$/i.test(entry.name)) files.push(file);
		}
	};
	visit(root);
	return files.sort();
}

function randomizedYamlInputs(): string[] {
	let state = 0x4148;
	const next = (): number => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state;
	};
	const alphabet = " language:#\n\r\t\u00a0_0123XYZ";
	const inputs: string[] = [];
	for (let sample = 0; sample < 3000; sample++) {
		let value = "";
		for (let index = 0; index < next() % 180; index++) {
			value += alphabet[next() % alphabet.length];
		}
		if (sample % 3 === 0) {
			const indent = ["", " ", "\t", "\u00a0"][sample % 4];
			const key = sample % 2 ? "language" : "Language";
			value += `${sample % 5 === 0 ? "\r" : "\n"}${indent}${key}: ${sample % 2 ? "python" : "TypeScript"}`;
		}
		inputs.push(value);
	}
	return inputs;
}

function clientWithSuccessfulScan(): AstGrepClient {
	const client = new AstGrepClient();
	(
		client as unknown as {
			runner: {
				tempScanDetailedAsync: (...args: unknown[]) => Promise<unknown>;
			};
		}
	).runner = {
		tempScanDetailedAsync: async () => ({ matches: [], status: 0 }),
	};
	return client;
}

describe("ast-grep rule language regex (#4148)", () => {
	it("keeps repository rules and randomized YAML verdicts unchanged", () => {
		const corpus = [
			...yamlFiles(path.join(REPO_ROOT, "rules")),
			...yamlFiles(path.join(REPO_ROOT, "tests")),
		].map((file) => fs.readFileSync(file, "utf8"));
		const differences = [...corpus, ...randomizedYamlInputs()].flatMap(
			(source) => {
				const oldValue = oldRuleLanguage(source);
				const newValue = extractRuleLanguage(source);
				return oldValue === newValue ? [] : [{ source, oldValue, newValue }];
			},
		);
		expect(differences).toEqual([]);
	});

	it("keeps language verdicts for YAML line and value spellings", () => {
		const cases = [
			"Language: python\n",
			"LANGUAGE: TypeScript\n",
			"\tlanguage: python\n",
			"\u00a0language: python\n",
			"language: python\r\n",
			"language: python\r",
			`language: python${String.fromCharCode(0x2028)}`,
			`language: python${String.fromCharCode(0x2029)}`,
			"\ufefflanguage: python\n",
			"language: python # comment\n",
			'language: "python"\n',
			"name: first\nlanguage: python\nlanguage: ruby\n",
		];
		const differences = cases.flatMap((source) => {
			const oldValue = oldRuleLanguage(source);
			const newValue = extractRuleLanguage(source);
			return oldValue === newValue ? [] : [{ source, oldValue, newValue }];
		});
		expect(differences).toEqual([]);
	});

	it("keeps a 199K-blank-line rule language scan linear", async () => {
		const client = clientWithSuccessfulScan();
		const rule = `${"\n".repeat(ADVERSARIAL_BLANK_LINES)}id: blank-heavy\n`;
		const started = performance.now();
		const result = await client.validateRule(rule);
		const elapsed = performance.now() - started;

		expect(result).toEqual({ valid: true });
		expect(elapsed).toBeLessThan(BUDGET_MS);
	});

	it.each([
		["LF", "\n"],
		["CR", "\r"],
		["U+2028", String.fromCharCode(0x2028)],
		["U+2029", String.fromCharCode(0x2029)],
	])("scales linearly across a 10x %s blank-run growth", (_name, lineEnd) => {
		const measure = (blankLines: number): number => {
			const started = performance.now();
			expect(
				extractRuleLanguage(`${lineEnd.repeat(blankLines)}id: no-language`),
			).toBe(undefined);
			return performance.now() - started;
		};
		const smaller = measure(19_900);
		const larger = measure(199_000);

		// The additive margin covers timer resolution; the multiplicative bound
		// catches the old quadratic scan while allowing normal scheduler noise.
		expect(larger).toBeLessThan(smaller * 20 + 100);
	});
});
