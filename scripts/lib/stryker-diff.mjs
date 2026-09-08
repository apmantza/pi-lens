import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const IMPORT_SPECIFIER_RE =
	/(?:from\s+|import\s*(?:\(\s*)?|require\(\s*)["']([^"']+)["']/g;

export const isScriptMutationFile = (file) =>
	/^scripts\/.*\.mjs$/.test(file) && !file.endsWith(".test.mjs");

function collectTestFiles(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) collectTestFiles(full, out);
		else if (entry.name.endsWith(".test.ts")) out.push(full);
	}
	return out;
}

function extractRelativeSpecifiers(content) {
	const specifiers = [];
	IMPORT_SPECIFIER_RE.lastIndex = 0;
	let match = IMPORT_SPECIFIER_RE.exec(content);
	while (match) {
		if (match[1].startsWith(".")) specifiers.push(match[1]);
		match = IMPORT_SPECIFIER_RE.exec(content);
	}
	return specifiers;
}

function normalized(file) {
	return path.resolve(file).replace(/\\/g, "/");
}

/**
 * Select tests that cover changed scripts through one-hop relative imports or
 * the conventional tests/scripts/<name>.test.ts sibling.
 *
 * @param {string[]} changedFiles
 * @param {{ testFiles?: string[], readFile?: (file: string) => string }} [options]
 */
export function mapRelatedTests(
	changedFiles,
	{
		testFiles = collectTestFiles("tests"),
		readFile = (file) => readFileSync(file, "utf8"),
	} = {},
) {
	const scripts = changedFiles.filter(isScriptMutationFile);
	const related = new Map(scripts.map((file) => [file, new Set()]));
	const testContents = testFiles.map((test) => {
		try {
			return [test, readFile(test)];
		} catch {
			return [test, null];
		}
	});

	for (const file of scripts) {
		const sibling = `tests/scripts/${path.basename(file, ".mjs")}.test.ts`;
		if (testFiles.some((test) => normalized(test) === normalized(sibling))) {
			related.get(file).add(sibling);
		}
		const target = normalized(file);
		for (const [test, content] of testContents) {
			if (content === null) continue;
			for (const specifier of extractRelativeSpecifiers(content)) {
				const imported = normalized(
					path.resolve(path.dirname(test), specifier),
				);
				if (imported === target) related.get(file).add(test);
			}
		}
	}

	return {
		related,
		covered: scripts.filter((file) => related.get(file).size > 0),
		uncovered: scripts.filter((file) => related.get(file).size === 0),
		tests: [...new Set([...related.values()].flatMap((files) => [...files]))],
	};
}
