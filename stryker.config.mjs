/**
 * Incremental mutation spike for changed production files (#1844 item 1).
 * TypeScript is mutated because this repository's build emits the runtime JS.
 */
export default {
	buildCommand: "npm run build",
	testRunner: "vitest",
	// inPlace: the sandbox copy runs Stryker's tsconfig preprocessor, which
	// calls ts.parseConfigFileTextToJson — absent from the TypeScript 7
	// native API this repo pins (2026-09-08 spike). In-place mutation with
	// the buildCommand keeps the compiled runtime in sync per mutant.
	inPlace: true,
	// Explicit plugin list: the default `@stryker-mutator/*` glob does not
	// follow a symlinked node_modules (plegma worktrees link the main
	// checkout's tree), so the runner was "not found" (2026-09-08 spike).
	plugins: ["@stryker-mutator/vitest-runner"],
	vitest: { related: true, configFile: "vitest.config.ts" },
	mutate: [
		"clients/**/*.ts",
		"scripts/**/*.mjs",
		"!**/tests/**",
		"!**/fixtures/**",
		"!**/*.d.ts",
		"!**/*.d.mts",
		"!**/*.js",
	],
	coverageAnalysis: "perTest",
	incremental: true,
	incrementalFile: ".stryker/incremental.json",
	concurrency: 2,
	timeoutMS: 10000,
	timeoutFactor: 2,
	ignoreStatic: true,
	disableTypeChecks: "{clients,scripts}/**/*.{ts,mjs}",
	reporters: ["clear-text", "json", "html"],
	jsonReporter: { fileName: "reports/mutation/mutation.json" },
	htmlReporter: { fileName: "reports/mutation/mutation.html" },
	thresholds: { high: 60, low: 20, break: 0 },
};
