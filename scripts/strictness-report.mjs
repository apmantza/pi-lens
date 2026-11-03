import { spawnSync } from "node:child_process";
import { resolve, relative, sep } from "node:path";
import { isMainModule } from "./lib/is-main-module.mjs";

export const REPORT_ROOTS = ["clients", "tools", "mcp", "scripts", "tests"];

/**
 * The ratchet bucket for one repo-relative file: two directory levels below a
 * report root, or the file's own name at the repo root (`index.ts`, the host
 * adapter). Any other location returns undefined: the caller reports it as
 * unclassified rather than dropping it into a bucket nobody ratchets (#4429).
 */
function reportDirectory(file) {
	const normalized = file.split(sep).join("/");
	if (!normalized.includes("/")) return normalized;
	const root = REPORT_ROOTS.find((candidate) =>
		normalized.startsWith(`${candidate}/`),
	);
	if (!root) return undefined;
	const parts = normalized.split("/");
	const rootIndex = parts.indexOf(root);
	const directoryParts = parts.slice(0, -1);
	// Keep two directory levels below each configured root. This preserves
	// useful runner/LSP buckets such as tests/clients/dispatch/runners.
	return directoryParts.slice(rootIndex, rootIndex + 4).join("/") || root;
}

/**
 * Count tsc diagnostics per bucket. Every line carrying `error TSnnnn` is a
 * needle hit and must be the located form `file(line,col): error TSnnnn` in a
 * known bucket; anything else (a global diagnostic such as `error TS2688`
 * with no location, or a file outside every root) is returned in
 * `unclassified`, never skipped (#4429).
 */
export function parseDiagnostics(output, repoRoot) {
	const counts = new Map();
	const unclassified = [];
	const diagnosticPattern = /^(.*)\((\d+),(\d+)\): error TS\d+/;
	for (const line of String(output).split(/\r?\n/)) {
		if (!/\berror TS\d+/.test(line)) continue;
		const match = diagnosticPattern.exec(line);
		const directory = match
			? reportDirectory(relative(repoRoot, resolve(repoRoot, match[1])))
			: undefined;
		if (directory === undefined) {
			unclassified.push(line);
			continue;
		}
		counts.set(directory, (counts.get(directory) ?? 0) + 1);
	}
	return {
		counts: Object.fromEntries(
			[...counts].sort(([a], [b]) => a.localeCompare(b)),
		),
		unclassified,
	};
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
		...parseDiagnostics(output, repoRoot),
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

if (isMainModule(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(`strictness report unavailable: ${error.message}`);
	}
	process.exitCode = 0;
}
