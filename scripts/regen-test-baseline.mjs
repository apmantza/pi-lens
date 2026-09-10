import { spawnSync } from "node:child_process";

if (process.argv[2] !== "vi-mock") {
	console.error("Usage: npm run test:regen -- vi-mock");
	process.exit(2);
}
const result = spawnSync(
	process.execPath,
	[
		"scripts/with-test-lock.mjs",
		"--shared",
		"--",
		"node_modules/.bin/vitest",
		"run",
		"tests/config/vi-mock-export-sweep.test.ts",
		"--configLoader",
		"runner",
	],
	{ env: { ...process.env, VI_MOCK_EXPORT_REGEN: "1" }, stdio: "inherit" },
);
process.exit(result.status ?? 1);
