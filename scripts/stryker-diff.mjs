import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import {
	capMutationFiles,
	DEFAULT_MAX_FILES,
	formatCapNotice,
	isScriptMutationFile,
	mapRelatedTests,
} from "./lib/stryker-diff.mjs";

function argumentValue(name, fallback) {
	let value = fallback;
	for (let index = 0; index < process.argv.length - 1; index += 1) {
		if (process.argv[index] === name) value = process.argv[index + 1];
	}
	return value;
}

const base = argumentValue("--base", "origin/master");
const maxFiles = Number(argumentValue("--max-files", DEFAULT_MAX_FILES));

function changedScriptFiles() {
	try {
		return execFileSync(
			"git",
			["diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`],
			{ encoding: "utf8" },
		)
			.split("\n")
			.map((file) => file.trim())
			.filter(Boolean)
			.filter(isScriptMutationFile);
	} catch (error) {
		console.error(
			`mutation diff: could not read ${base}...HEAD: ${error.message}`,
		);
		process.exit(1);
	}
}

function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeRunConfig(testFiles) {
	mkdirSync(".stryker", { recursive: true });
	const command = [
		"node_modules/.bin/vitest",
		"run",
		"--configLoader",
		"runner",
		...testFiles.map(shellQuote),
	].join(" ");
	const config = `import base from "../stryker.config.mjs";\nexport default { ...base, commandRunner: { ...base.commandRunner, command: ${JSON.stringify(command)} } };\n`;
	const file = ".stryker/diff.config.mjs";
	writeFileSync(file, config);
	return file;
}

const allFiles = changedScriptFiles();
const { selected: files, skipped } = capMutationFiles(allFiles, maxFiles);
if (skipped.length > 0) {
	console.log(formatCapNotice(files.length, allFiles.length, skipped));
}
if (files.length === 0) {
	console.log("mutation diff: no changed scripts/**/*.mjs files");
	process.exit(0);
}

const { covered, uncovered, tests } = mapRelatedTests(files);
for (const file of uncovered) {
	console.log(`mutation diff: no covering test for ${file}`);
}
if (covered.length === 0) {
	console.log("mutation diff: no covered changed scripts; no mutants run");
	process.exit(0);
}

const configFile = writeRunConfig(tests);
console.log(`mutation diff: mutating ${covered.join(", ")}`);
console.log(`mutation diff: running related tests ${tests.join(", ")}`);
const result = spawnSync(
	"node_modules/.bin/stryker",
	["run", "--mutate", covered.join(","), configFile],
	{ stdio: "inherit", encoding: "utf8" },
);

if (result.error || result.status !== 0) {
	const exitMsg = result.error ? `: ${result.error.message}` : "";
	console.error(
		`mutation diff: Stryker status ${result.status ?? "unknown"}${exitMsg}`,
	);
	process.exit(1);
}

const reportPath = "reports/mutation/mutation.json";
if (!existsSync(reportPath)) {
	console.error("mutation diff: report not found after Stryker run");
	process.exit(1);
}

try {
	const report = JSON.parse(readFileSync(reportPath, "utf8"));
	// The mutation-report schema keys mutants by file; the entries themselves
	// carry no file name (spike 2026-09-09 printed `survived: undefined:59`).
	const mutants = Object.entries(report.files ?? {}).flatMap(
		([fileName, file]) =>
			(file.mutants ?? []).map((mutant) => ({ ...mutant, fileName })),
	);
	const counts = mutants.reduce((out, mutant) => {
		out[mutant.status] = (out[mutant.status] ?? 0) + 1;
		return out;
	}, {});
	const score = report.mutationTestResults?.score ?? "n/a";
	console.log(`mutation diff score: ${score}`);
	console.log(`mutation diff counts: ${JSON.stringify(counts)}`);
	for (const mutant of mutants.filter((entry) => entry.status === "Survived")) {
		const line = mutant.location?.start?.line ?? "?";
		console.log(`survived: ${mutant.fileName}:${line} ${mutant.mutatorName}`);
	}
} catch (error) {
	console.error(`mutation diff: report unreadable: ${error.message}`);
	process.exit(1);
}

console.log("mutation diff: completed");
