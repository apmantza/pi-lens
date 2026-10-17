import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { KnipClient } from "../../clients/knip-client.js";
import { resetProjectTrust } from "../../clients/project-trust.js";
import { setupTestEnvironment } from "./test-utils.js";

// End-to-end proof for #1630 against the real knip binary. knip's glob cache
// only revalidates directories that contributed a matched path, so a consumer
// added to a directory that matched nothing stays invisible and the export it
// imports keeps being reported as unused. Fixed upstream in knip 6.28.0; this
// test still guards the pi-lens side, which must stay correct on the older
// versions the managed install can resolve to.
//
// Skipped where knip is not installed. The version-independent regression is
// the glob-cache prune assertion in knip-client.test.ts, which always runs.
const probeKnip = (env?: NodeJS.ProcessEnv): boolean => {
	try {
		return (
			spawnSync("knip", ["--version"], {
				shell: process.platform === "win32",
				encoding: "utf8",
				env: env ?? process.env,
			}).status === 0
		);
	} catch {
		return false;
	}
};

// The suite redirects PI_LENS_HOME to a per-worker temp dir, so the client's
// managed-tool lookup cannot see a real knip install. Find that install through
// the real home dir and put its bin dir on PATH for the duration of the test.
const managedKnipBinDir = (() => {
	const dir = path.join(
		os.homedir(),
		".pi-lens",
		"tools",
		"node_modules",
		".bin",
	);
	return fs.existsSync(dir) ? dir : null;
})();

// A dev box answers knip through that managed install. CI and the pre-push hook
// have none, and their only knip is this checkout's own devDependency, which a
// bare `knip` reaches only when `node_modules/.bin` is on PATH — `npm test`
// arranges that, a direct vitest run does not. Name it here so both
// environments drive the same binary (#4566 CI red).
const checkoutKnipBinDir = (() => {
	const dir = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"node_modules",
		".bin",
	);
	return fs.existsSync(path.join(dir, "knip")) ? dir : null;
})();

const knipBinDir = managedKnipBinDir ?? checkoutKnipBinDir;

const knipAvailable = probeKnip(
	knipBinDir
		? {
				...process.env,
				PATH: `${knipBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
			}
		: undefined,
);

describe("knip cache consumer-import staleness (#1630)", () => {
	it.skipIf(!knipAvailable)(
		"reports no unused export after a new test imports it",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-1630-");
			const originalPath = process.env.PATH;
			// #4566 F6: the analyzed fixture is untrusted; the checkout's
			// devDependency is outside that fixture and remains usable.
			const originalCwd = process.cwd();
			process.chdir(tmpDir);
			try {
				if (knipBinDir) {
					process.env.PATH = `${knipBinDir}${path.delimiter}${originalPath ?? ""}`;
				}

				fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
				// `tests/` exists but matches nothing at cache time — the exact
				// shape knip's glob cache fails to revalidate.
				fs.mkdirSync(path.join(tmpDir, "tests"), { recursive: true });
				fs.writeFileSync(
					path.join(tmpDir, "package.json"),
					JSON.stringify({
						name: "knip-1630",
						version: "1.0.0",
						private: true,
						type: "module",
					}),
				);
				fs.writeFileSync(
					path.join(tmpDir, "knip.json"),
					JSON.stringify({
						entry: ["src/index.ts", "tests/**/*.test.ts"],
						project: ["src/**/*.ts", "tests/**/*.ts"],
					}),
				);
				fs.writeFileSync(
					path.join(tmpDir, "src", "util.ts"),
					"export function assertSafeForCmdShell(s: string): string { return s; }\n" +
						'export function used(): string { return "x"; }\n',
				);
				fs.writeFileSync(
					path.join(tmpDir, "src", "index.ts"),
					'import { used } from "./util.js";\nconsole.log(used());\n',
				);

				const cacheLocation = path.join(
					getProjectDataDir(tmpDir),
					"cache",
					"knip",
				);
				fs.rmSync(cacheLocation, { recursive: true, force: true });

				const client = new KnipClient(false);

				const first = await client.analyze(tmpDir);
				expect(first.success).toBe(true);
				// Baseline: with no consumer, knip flags the export.
				expect(first.unusedExports.map((e) => e.name)).toContain(
					"assertSafeForCmdShell",
				);
				expect(fs.existsSync(cacheLocation)).toBe(true);

				fs.writeFileSync(
					path.join(tmpDir, "tests", "consumer.test.ts"),
					'import { assertSafeForCmdShell } from "../src/util.js";\n' +
						'export const t = assertSafeForCmdShell("a");\n',
				);

				const second = await client.analyze(tmpDir);
				expect(second.success).toBe(true);
				expect(second.unusedExports.map((e) => e.name)).not.toContain(
					"assertSafeForCmdShell",
				);
			} finally {
				process.env.PATH = originalPath;
				process.chdir(originalCwd);
				resetProjectTrust();
				cleanup();
			}
		},
		120_000,
	);
});
