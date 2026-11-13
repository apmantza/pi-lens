/**
 * oxlint runs where its config lives (#5541).
 *
 * oxlint picks its config per file and the cwd does not change that choice,
 * but a path that a config or a JS plugin resolves from the process cwd (a
 * plugin's `settings` entry, such as `better-tailwindcss`'s `entryPoint`)
 * does depend on it. The runner used to spawn in the nearest `package.json`
 * directory, so a repo-root config resolved those paths from the wrong
 * place for every file under a nested workspace package.
 *
 * Every cell runs the real runner, the real binary ladder and the shipped
 * oxlint on a real filesystem fixture. Only the child-process boundary is
 * doubled, and only to run the shipped entry under Node. A local JS plugin
 * reads one cwd-relative `settings` path, so the observed effect is oxlint's
 * own diagnostic, not the argument the runner passed to the spawn.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDispatchAvailabilityState } from "../../../../clients/dispatch/runners/utils/runner-helpers.js";
import { resetProjectLensConfigCache } from "../../../../clients/project-lens-config.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../../clients/project-trust.js";
import { resetWorkspaceTopology } from "../../../../clients/workspace-topology.js";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { createTempFile, setupTestEnvironment } from "../../test-utils.js";

const require = createRequire(import.meta.url);
// Node module resolution, not a hard-coded path: a hoisted install still resolves.
const OXLINT_ENTRY = path.join(
	path.dirname(require.resolve("oxlint/package.json")),
	"bin",
	"oxlint",
);

// Hoisted so the factory below can read it while the imports above still load.
const shippedOxlint = vi.hoisted(() => ({ entry: "" }));
shippedOxlint.entry = OXLINT_ENTRY;

// The availability ladder proves a binary with `--version`, and the lint run
// goes to the shipped entry under Node, so the cell needs no installed shim
// content and behaves the same on Windows.
vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../../clients/safe-spawn.js")>();
	return {
		...actual,
		safeSpawnAsync: (
			_command: string,
			args: string[] = [],
			options?: Parameters<typeof actual.safeSpawnAsync>[2],
		) =>
			args.includes("--version")
				? Promise.resolve({
						error: null,
						status: 0,
						stdout: "1.91.0\n",
						stderr: "",
					})
				: actual.safeSpawnAsync(
						process.execPath,
						[shippedOxlint.entry, ...args],
						options,
					),
	};
});

const CWD_PROBE_PLUGIN = `import { existsSync } from "node:fs";
import { resolve } from "node:path";

export default {
	meta: { name: "cwd-probe" },
	rules: {
		"entry-exists": {
			create(context) {
				const entry = context.settings?.["cwd-probe"]?.entryPoint;
				const found = existsSync(resolve(process.cwd(), entry));
				return {
					Program(node) {
						if (!found) context.report({ node, message: \`entry point \${entry} not found from the cwd\` });
					},
				};
			},
		},
	},
};
`;

function probeConfig(pluginSpecifier: string, entryPoint: string): string {
	return JSON.stringify({
		jsPlugins: [pluginSpecifier],
		rules: { "cwd-probe/entry-exists": "error" },
		settings: { "cwd-probe": { entryPoint } },
	});
}

/**
 * A project-local `node_modules/.bin/oxlint` at exactly `dir`, the rung the
 * ladder reads first. Planted at the root and the package so the cell does not
 * depend on which of them the runner asks.
 */
function plantOxlint(dir: string): void {
	const bin = path.join(dir, "node_modules", ".bin");
	fs.mkdirSync(bin, { recursive: true });
	const file = path.join(
		bin,
		process.platform === "win32" ? "oxlint.cmd" : "oxlint",
	);
	fs.writeFileSync(file, "#!/bin/sh\n");
	fs.chmodSync(file, 0o755);
}

async function runOxlint(filePath: string, dispatchRoot: string) {
	const runner = (
		await import("../../../../clients/dispatch/runners/oxlint.js")
	).default;
	const result = await runner.run(
		makeRunnerCtx(filePath, dispatchRoot) as never,
	);
	return result.diagnostics.map((diagnostic) => diagnostic.rule);
}

describe("oxlint runner cwd follows the config (#5541)", () => {
	beforeEach(() => {
		setProjectTrustState("trusted");
		resetDispatchAvailabilityState();
		resetProjectLensConfigCache();
		resetWorkspaceTopology();
	});
	afterEach(() => {
		resetProjectTrust();
		resetProjectLensConfigCache();
		resetWorkspaceTopology();
		resetDispatchAvailabilityState();
	});

	it("resolves a root config's cwd-relative setting for a file under a nested package", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-config-cwd-");
		try {
			createTempFile(env.tmpDir, "package.json", '{"name":"root"}');
			createTempFile(env.tmpDir, "apps/web/package.json", '{"name":"web"}');
			createTempFile(env.tmpDir, "shared/theme.css", "/* theme */\n");
			createTempFile(env.tmpDir, "cwd-plugin.mjs", CWD_PROBE_PLUGIN);
			createTempFile(
				env.tmpDir,
				".oxlintrc.json",
				probeConfig("./cwd-plugin.mjs", "shared/theme.css"),
			);
			const filePath = createTempFile(
				env.tmpDir,
				"apps/web/src/x.js",
				"const a = 1;\nconsole.log(a);\n",
			);
			plantOxlint(env.tmpDir);
			plantOxlint(path.join(env.tmpDir, "apps", "web"));

			expect(await runOxlint(filePath, env.tmpDir)).not.toContain(
				"entry-exists",
			);
		} finally {
			env.cleanup();
		}
	}, 60_000);

	it("still runs a nested package's own config from that package", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-nested-config-cwd-");
		try {
			createTempFile(env.tmpDir, "package.json", '{"name":"root"}');
			createTempFile(env.tmpDir, "apps/web/package.json", '{"name":"web"}');
			createTempFile(env.tmpDir, "apps/web/theme.css", "/* theme */\n");
			createTempFile(env.tmpDir, "cwd-plugin.mjs", CWD_PROBE_PLUGIN);
			createTempFile(
				env.tmpDir,
				".oxlintrc.json",
				probeConfig("./cwd-plugin.mjs", "does/not/exist.css"),
			);
			createTempFile(
				env.tmpDir,
				"apps/web/.oxlintrc.json",
				probeConfig("../../cwd-plugin.mjs", "theme.css"),
			);
			const filePath = createTempFile(
				env.tmpDir,
				"apps/web/src/x.js",
				"const a = 1;\nconsole.log(a);\n",
			);
			plantOxlint(env.tmpDir);
			plantOxlint(path.join(env.tmpDir, "apps", "web"));

			expect(await runOxlint(filePath, env.tmpDir)).not.toContain(
				"entry-exists",
			);
		} finally {
			env.cleanup();
		}
	}, 60_000);
});
