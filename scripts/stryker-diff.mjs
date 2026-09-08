import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isProductionMutationFile } from "./lib/stryker-diff.mjs";

const baseIndex = process.argv.indexOf("--base");
const base = baseIndex >= 0 ? process.argv[baseIndex + 1] : "origin/master";
let files;
try {
	files = execFileSync(
		"git",
		["diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`],
		{ encoding: "utf8" },
	)
		.split("\n")
		.map((file) => file.trim())
		.filter(Boolean)
		.filter(isProductionMutationFile);
} catch (error) {
	console.error(
		`mutation diff: could not read ${base}...HEAD: ${error.message}`,
	);
	process.exit(1);
}

if (files.length === 0) {
	console.log("mutation diff: no changed production files");
	process.exit(0);
}

console.log(`mutation diff: ${files.join(", ")}`);
const result = spawnSync(
	"node_modules/.bin/stryker",
	["run", "--mutate", files.join(",")],
	{ stdio: "inherit", encoding: "utf8" },
);

if (result.error || result.status !== 0) {
	console.error(
		`mutation diff: Stryker exited with status ${result.status ?? "unknown"}${result.error ? `: ${result.error.message}` : ""}`,
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
	const mutants = Object.values(report.files ?? {}).flatMap(
		(file) => file.mutants ?? [],
	);
	const counts = mutants.reduce((out, mutant) => {
		out[mutant.status] = (out[mutant.status] ?? 0) + 1;
		return out;
	}, {});
	console.log(
		`mutation diff score: ${report.schemaVersion ? (report.mutationTestResults?.score ?? "n/a") : "n/a"}`,
	);
	console.log(`mutation diff counts: ${JSON.stringify(counts)}`);
	for (const mutant of mutants.filter(
		(entry) => entry.status === "Survived",
	)) {
		console.log(
			`survived: ${mutant.fileName}:${mutant.location?.start?.line ?? "?"} ${mutant.mutatorName}`,
		);
	}
} catch (error) {
	console.error(`mutation diff: report unreadable: ${error.message}`);
	process.exit(1);
}

console.log("mutation diff: completed");
process.exit(0);
