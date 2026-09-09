import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const COMPLEXITY_FUNCTION_THRESHOLD = 15;
export const COMPLEXITY_FILE_SIZE_THRESHOLD = 1000;

export function requireAnalyzedFiles(results) {
	if (results.length === 0)
		throw new Error("complexity analysis produced zero analyzed files");
}

export function shapeComplexityReport(results, options = {}) {
	const topN = options.topN ?? 20;
	const files = results
		.filter(Boolean)
		.toSorted(
			(a, b) =>
				b.maxCyclomaticComplexity - a.maxCyclomaticComplexity ||
				(b.lineCount ?? b.linesOfCode) - (a.lineCount ?? a.linesOfCode) ||
				a.filePath.localeCompare(b.filePath),
		);
	const functions = results
		.flatMap((file) =>
			(file.functions ?? []).map((fn) => ({ ...fn, filePath: file.filePath })),
		)
		.toSorted(
			(a, b) =>
				b.cyclomatic - a.cyclomatic ||
				b.cognitive - a.cognitive ||
				b.length - a.length ||
				a.filePath.localeCompare(b.filePath) ||
				a.line - b.line,
		);
	const splitFiles = files.filter(
		(file) =>
			(file.lineCount ?? file.linesOfCode) >
			(options.fileSizeThreshold ?? COMPLEXITY_FILE_SIZE_THRESHOLD),
	);
	const splitFunctions = functions.filter(
		(fn) =>
			fn.cyclomatic >=
			(options.functionThreshold ?? COMPLEXITY_FUNCTION_THRESHOLD),
	);
	const lines = [
		"# Complexity report",
		"",
		`Advisory thresholds: files over ${options.fileSizeThreshold ?? COMPLEXITY_FILE_SIZE_THRESHOLD} lines; functions at or above cyclomatic complexity ${options.functionThreshold ?? COMPLEXITY_FUNCTION_THRESHOLD}. Metrics come from pi-lens's ComplexityClient.`,
		"",
		"## Top functions",
		"",
		"| Function | File:line | Cyclomatic | Cognitive | Length | Nesting |",
		"|---|---:|---:|---:|---:|---:|",
		...functions
			.slice(0, topN)
			.map(
				(fn) =>
					`| ${fn.name} | ${fn.filePath}:${fn.line} | ${fn.cyclomatic} | ${fn.cognitive} | ${fn.length} | ${fn.nestingDepth} |`,
			),
		"",
		"## Top files",
		"",
		"| File | Lines | Max cyclomatic | Cognitive | Functions |",
		"|---|---:|---:|---:|---:|",
		...files
			.slice(0, topN)
			.map(
				(file) =>
					`| ${file.filePath} | ${file.lineCount ?? file.linesOfCode} | ${file.maxCyclomaticComplexity} | ${file.cognitiveComplexity} | ${file.functionCount} |`,
			),
		"",
		"## Split candidates",
		"",
		...splitFiles.map(
			(file) =>
				`- **File:** \`${file.filePath}\` (${file.lineCount ?? file.linesOfCode} lines)`,
		),
		...splitFunctions.map(
			(fn) =>
				`- **Function:** \`${fn.name}\` at \`${fn.filePath}:${fn.line}\` (cyclomatic ${fn.cyclomatic})`,
		),
		...(splitFiles.length === 0 && splitFunctions.length === 0
			? ["- None identified."]
			: []),
		"",
	];
	return lines.join("\n");
}

async function sourceFiles(root) {
	const found = [];
	async function visit(dir) {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = resolve(dir, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
				found.push(path);
		}
	}
	for (const dir of ["clients", "tools", "mcp"])
		await visit(resolve(root, dir));
	return found;
}

async function main() {
	const root = resolve(import.meta.dirname, "..");
	const { ComplexityClient } = await import("../clients/complexity-client.js");
	const client = new ComplexityClient();
	const results = [];
	for (const file of await sourceFiles(root)) {
		const result = await client.analyzeFile(file);
		if (result)
			results.push({
				...result,
				lineCount: (await readFile(file, "utf8")).split(/\r?\n/).length - 1,
			});
	}
	requireAnalyzedFiles(results);
	const report = shapeComplexityReport(results, {
		topN: Number(process.env.COMPLEXITY_TOP_N) || 20,
	});
	const output = resolve(root, "reports/complexity/complexity.md");
	await mkdir(resolve(root, "reports/complexity"), { recursive: true });
	await writeFile(output, report);
	process.stdout.write(report);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(`complexity advisory unavailable: ${error.message}`);
		const output = resolve(
			import.meta.dirname,
			"../reports/complexity/complexity.md",
		);
		mkdir(resolve(import.meta.dirname, "../reports/complexity"), {
			recursive: true,
		})
			.then(() =>
				writeFile(
					output,
					"# Complexity report\n\nAnalysis unavailable in this run.\n",
				),
			)
			.catch(() => {});
		process.exitCode = 1;
	});
}
