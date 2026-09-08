/**
 * Incremental mutation spike for changed script files (#1844 item 1).
 *
 * The command runner receives the related-test list from scripts/stryker-diff.mjs
 * through a generated config override. Command runner has no per-test coverage
 * analysis, so every related test file runs for every mutant.
 */
export default {
	// inPlace: Stryker's sandbox copy runs a tsconfig preprocessor that calls
	// ts.parseConfigFileTextToJson, which the TypeScript 7 native API this
	// repo pins does not export (spike 2026-09-08/09); mutating in place
	// skips that preprocessor. The command runner restores files after each
	// mutant.
	inPlace: true,
	// buildCommand runs once after instrumentation, before the dry run: the
	// in-place sandbox reset drops the compiled .js siblings the
	// tests execute, and vitest then reports "No test files found" (spike
	// 2026-09-09). The mutated .mjs scripts run directly, so no per-mutant
	// rebuild is needed.
	buildCommand: "npm run build",
	testRunner: "command",
	commandRunner: {
		command: "node_modules/.bin/vitest run --configLoader runner",
	},
	mutate: ["scripts/**/*.mjs", "!scripts/**/*.test.mjs"],
	incremental: true,
	incrementalFile: ".stryker/incremental.json",
	coverageAnalysis: "off",
	concurrency: 2,
	// A cold Vitest process is allowed one minute. Stryker gives mutants 1.5x
	// the measured baseline before treating the command as hung.
	timeoutMS: 60000,
	timeoutFactor: 1.5,
	reporters: ["clear-text", "json", "html"],
	jsonReporter: { fileName: "reports/mutation/mutation.json" },
	htmlReporter: { fileName: "reports/mutation/mutation.html" },
	thresholds: { high: 60, low: 20, break: 0 },
};
