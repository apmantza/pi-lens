import { spawnSync } from "node:child_process";
import { resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const REPORT_ROOTS = ["clients", "tools", "mcp", "scripts", "tests"];

function reportDirectory(file) {
	const normalized = file.split(sep).join("/");
	const root = REPORT_ROOTS.find(
		(candidate) =>
			normalized === candidate || normalized.startsWith(`${candidate}/`),
	);
	if (!root) return "other";
	const parts = normalized.split("/");
	const rootIndex = parts.indexOf(root);
	const directoryParts = parts.slice(0, -1);
	// Keep two directory levels below each configured root. This preserves
	// useful runner/LSP buckets such as tests/clients/dispatch/runners.
	return directoryParts.slice(rootIndex, rootIndex + 4).join("/") || root;
}

export function parseDiagnostics(output, repoRoot) {
	const counts = new Map();
	const diagnosticPattern = /^(.*)\((\d+),(\d+)\): error TS\d+/;
	for (const line of String(output).split(/\r?\n/)) {
		const match = diagnosticPattern.exec(line);
		if (!match) continue;
		const file = relative(repoRoot, resolve(repoRoot, match[1]));
		const directory = reportDirectory(file);
		counts.set(directory, (counts.get(directory) ?? 0) + 1);
	}
	return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

export function runCheck(
	config,
	repoRoot = resolve(import.meta.dirname, ".."),
) {
	const tsc = resolve(repoRoot, "node_modules/typescript/bin/tsc");
	const result = spawnSync(
		process.execPath,
		[tsc, "-p", config, "--noEmit", "--pretty", "false"],
		{
			cwd: repoRoot,
			encoding: "utf8",
		},
	);
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	return {
		config,
		exitCode: result.status ?? 1,
		total: (output.match(/^.*\(\d+,\d+\): error TS\d+/gm) ?? []).length,
		counts: parseDiagnostics(output, repoRoot),
	};
}

function table(summary) {
	const directories = new Set(
		summary.flatMap(({ counts }) => Object.keys(counts)),
	);
	const rows = [...directories]
		.sort()
		.map(
			(directory) =>
				`| ${directory} | ${summary[0].counts[directory] ?? 0} | ${summary[1].counts[directory] ?? 0} |`,
		);
	return [
		"| Directory | noUncheckedIndexedAccess | exactOptionalPropertyTypes |",
		"|---|---:|---:|",
		...rows,
	].join("\n");
}

export function formatReport(summary) {
	return [
		"# TypeScript strictness spike",
		"",
		table(summary),
		"",
		"## JSON summary",
		"",
		"```json",
		JSON.stringify(summary, null, 2),
		"```",
		"",
	].join("\n");
}

export function main(argv = process.argv.slice(2)) {
	const repoRoot = resolve(import.meta.dirname, "..");
	const configs =
		argv.length > 0
			? argv
			: ["tsconfig.strict-indexed.json", "tsconfig.strict-optional.json"];
	const summary = configs.map((config) => runCheck(config, repoRoot));
	process.stdout.write(formatReport(summary));
	process.stdout.write(`\n${JSON.stringify(summary)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(`strictness report unavailable: ${error.message}`);
	}
	process.exitCode = 0;
}
