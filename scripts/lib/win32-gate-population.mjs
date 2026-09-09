import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const TESTS_ROOT = "tests";
const TEST_FILE = /\.test\.ts$/;
const GATE_PATTERN =
	/(?:it|describe)\.(?:skipIf|runIf)\(\s*process\.platform\s*(?:!==|===)\s*["']\s*["']\s*\)/g;

function blankSource(source) {
	const output = source.split("");
	let quote;
	let lineComment = false;
	let blockComment = false;
	for (let index = 0; index < output.length; index++) {
		const current = output[index];
		const next = output[index + 1];
		if (lineComment) {
			if (current === "\n") lineComment = false;
			else output[index] = " ";
			continue;
		}
		if (blockComment) {
			if (current === "*" && next === "/") {
				output[index] = " ";
				output[++index] = " ";
				blockComment = false;
			} else if (current !== "\n") output[index] = " ";
			continue;
		}
		if (quote) {
			if (current === "\\") {
				output[index] = " ";
				if (index + 1 < output.length && output[index + 1] !== "\n")
					output[++index] = " ";
			} else if (current === quote) quote = undefined;
			else if (current !== "\n") output[index] = " ";
			continue;
		}
		if (current === "/" && next === "/") {
			output[index++] = " ";
			output[index] = " ";
			lineComment = true;
		} else if (current === "/" && next === "*") {
			output[index++] = " ";
			output[index] = " ";
			blockComment = true;
		} else if (["'", '"', "`"].includes(current)) quote = current;
	}
	return output.join("");
}

function sourceFiles(root) {
	const files = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.isFile() && TEST_FILE.test(entry.name))
				files.push(absolute);
		}
	};
	visit(join(root, TESTS_ROOT));
	return files.sort();
}

function isWindowsOnlyGate(match, rawSpan) {
	if (!/["']win32["']/.test(rawSpan)) return false;
	return (
		(match.includes("skipIf") && match.includes("!==")) ||
		(match.includes("runIf") && match.includes("==="))
	);
}

export function findWin32Gates(cwd = process.cwd()) {
	const root = resolve(cwd);
	const gates = [];
	for (const absolute of sourceFiles(root)) {
		if (absolute.includes(`${join(root, TESTS_ROOT, "fixtures")}/`)) continue;
		const raw = readFileSync(absolute, "utf8");
		for (const match of blankSource(raw).matchAll(GATE_PATTERN)) {
			const offset = match.index ?? 0;
			if (
				!isWindowsOnlyGate(
					match[0],
					raw.slice(offset, offset + match[0].length),
				)
			)
				continue;
			gates.push({
				file: relative(root, absolute).replaceAll("\\", "/"),
				line: raw.slice(0, offset).split("\n").length,
			});
		}
	}
	return gates;
}

export function getWin32GateFiles(cwd = process.cwd()) {
	return [...new Set(findWin32Gates(cwd).map((gate) => gate.file))].sort();
}

export function getWin32LaneFiles(cwd = process.cwd()) {
	const root = resolve(cwd);
	const files = new Set(getWin32GateFiles(root));
	for (const absolute of sourceFiles(root)) {
		const file = relative(root, absolute).replaceAll("\\", "/");
		if (file.startsWith("tests/config/")) files.add(file);
	}
	if (existsSync(join(root, "tests/clients/tool-cwd.test.ts")))
		files.add("tests/clients/tool-cwd.test.ts");
	return [...files].sort();
}

function main() {
	const args = process.argv.slice(2);
	const root = process.cwd();
	const files = getWin32LaneFiles(root);
	if (files.length === 0) throw new Error("win32-gate population is empty");
	if (args.includes("--summary")) {
		const listIndex = args.indexOf("--executed-file-list");
		const listPath = listIndex >= 0 ? args[listIndex + 1] : undefined;
		const executedFiles = listPath
			? readFileSync(resolve(root, listPath), "utf8")
					.split(/\r?\n/)
					.filter(Boolean)
			: files;
		const executed = new Set(executedFiles);
		const testsExecuted = findWin32Gates(root).filter((gate) =>
			executed.has(gate.file),
		).length;
		console.log(
			`win32-gate population: ${executed.size} files, ${testsExecuted} tests executed`,
		);
	} else if (args.includes("--files")) console.log(files.join("\n"));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
