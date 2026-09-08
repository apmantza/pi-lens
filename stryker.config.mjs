/**
 * Incremental mutation spike for changed production files (#1844 item 1).
 * TypeScript is mutated because this repository's build emits the runtime JS.
 */
export default {
	buildCommand: "npm run build",
	testRunner: "@stryker-mutator/vitest-runner",
	vitest: { related: true, configFile: "vitest.config.ts" },
	mutate: [
		"clients/**/*.ts",
		"scripts/**/*.mjs",
		"!**/tests/**",
		"!**/fixtures/**",
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
