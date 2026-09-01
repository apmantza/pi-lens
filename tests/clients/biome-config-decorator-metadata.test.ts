import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { BiomeClient } from "../../clients/biome-client.js";
import { safeSpawnAsync } from "../../clients/safe-spawn.js";
import { biomeConfigArgs } from "../../clients/tool-policy.js";

/**
 * Real-binary decorator-metadata guard for the bundled Biome fallback config
 * (refs #2385).
 *
 * Biome's `useImportType` (style group, recommended, fix marked "safe")
 * rewrites a value import that is used only in type positions into
 * `import type`. Under `experimentalDecorators` + `emitDecoratorMetadata` the
 * import still has a runtime footprint: the emitted `design:type` metadata
 * needs the imported class value, and after the rewrite it collapses to
 * `Function`, breaking decorator-based dependency injection at runtime. The
 * bundled fallback `config/biome/core.jsonc` therefore disables the rule
 * while every other recommended rule stays on.
 *
 * This suite drives the real pinned binary through the production entry point
 * (`BiomeClient.fixFileAsync`) and asserts an independent observable: the
 * metadata the compiled JS actually emits and reports at runtime.
 *
 * Both binaries are devDependencies, so this runs wherever a development
 * checkout is installed (dev box and CI test job). When a binary is absent the
 * suite reports as skipped and its title names the dependency; the guard test
 * below fails loud in CI so a missing devDependency can never silently
 * vanish the real-binary proof (#448 convention).
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BIOME_BIN = path.join(
	REPO_ROOT,
	"node_modules",
	"@biomejs",
	"biome",
	"bin",
	"biome",
);
const TSC_BIN = path.join(
	REPO_ROOT,
	"node_modules",
	"typescript",
	"bin",
	"tsc",
);
const BINARIES_PRESENT = fs.existsSync(BIOME_BIN) && fs.existsSync(TSC_BIN);

const TSCONFIG_JSON = JSON.stringify({
	compilerOptions: {
		target: "ES2020",
		module: "commonjs",
		experimentalDecorators: true,
		emitDecoratorMetadata: true,
		strict: false,
		outDir: "dist",
		rootDir: "src",
		sourceMap: false,
	},
});

const MODEL_TS = "export class CounterModel {\n  count = 0;\n}\n";

const WIDGET_TS = `declare var process: { stdout: { write(s: string): void } };
import { CounterModel } from "./model";

class WidgetService {
	@inject()
	counter: CounterModel;
}

function inject(): PropertyDecorator {
	return (target, propertyKey) => {
		const getMeta = (Reflect as {
			getMetadata?: (k: string, t: object, p: string | symbol) => unknown;
		}).getMetadata;
		const designType = getMeta?.("design:type", target, propertyKey);
		process.stdout.write(
			\`design:type=\${designType ? (designType as { name: string }).name : "undefined"}\\n\`,
		);
	};
}
`;

const METADATA_SHIM = `const store = new WeakMap();
function mapFor(target, create) {
	let m = store.get(target);
	if (!m && create) { m = new Map(); store.set(target, m); }
	return m;
}
Reflect.defineMetadata = (k, v, target, prop) => {
	const m = mapFor(target, true);
	let p = m.get(prop);
	if (!p) { p = new Map(); m.set(prop, p); }
	p.set(k, v);
};
Reflect.getMetadata = (k, target, prop) => {
	const p = mapFor(target, false)?.get(prop);
	return p?.get(k);
};
Reflect.metadata = (k, v) => (target, prop) => Reflect.defineMetadata(k, v, target, prop);
`;

const USER_BIOME_JSON = JSON.stringify({
	linter: {
		rules: {
			recommended: true,
			style: { useImportType: "error" },
		},
	},
});

const createdDirs: string[] = [];

async function makeFixture(withUserBiomeConfig: boolean): Promise<string> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-biome-2385-"));
	createdDirs.push(dir);
	fs.writeFileSync(path.join(dir, "tsconfig.json"), TSCONFIG_JSON);
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src", "model.ts"), MODEL_TS);
	fs.writeFileSync(path.join(dir, "src", "widget.ts"), WIDGET_TS);
	fs.writeFileSync(path.join(dir, "reflect-metadata-shim.cjs"), METADATA_SHIM);
	// Project-local biome shim so BiomeClient.getBiomeBinary resolves the REAL
	// pinned binary from the fixture cwd — no PATH, no network, no managed
	// tools tree. getBiomeBinary prefers node_modules/.bin/biome, exactly as
	// it does for a project that ships biome.
	fs.mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
	if (process.platform === "win32") {
		fs.writeFileSync(
			path.join(dir, "node_modules", ".bin", "biome.cmd"),
			`@node "${BIOME_BIN}" %*\r\n`,
		);
	} else {
		const shim = path.join(dir, "node_modules", ".bin", "biome");
		fs.writeFileSync(shim, `#!/bin/sh\nexec node '${BIOME_BIN}' "$@"\n`);
		fs.chmodSync(shim, 0o755);
	}
	if (withUserBiomeConfig) {
		fs.writeFileSync(path.join(dir, "biome.json"), USER_BIOME_JSON);
	}
	return dir;
}

/** Compile the fixture with the real tsc, run it, report the design:type name. */
async function observedDesignType(dir: string): Promise<string> {
	const tsc = await safeSpawnAsync(
		process.execPath,
		[TSC_BIN, "-p", path.join(dir, "tsconfig.json")],
		{ timeout: 120_000, cwd: dir },
	);
	expect(tsc.error).toBeUndefined();
	const distWidget = path.join(dir, "dist", "widget.js");
	expect(fs.existsSync(distWidget)).toBe(true);
	const run = await safeSpawnAsync(
		process.execPath,
		["-r", path.join(dir, "reflect-metadata-shim.cjs"), distWidget],
		{ timeout: 30_000, cwd: dir },
	);
	expect(run.error).toBeUndefined();
	const match = /design:type=(\S+)/.exec(run.stdout ?? "");
	expect(match).not.toBeNull();
	return match?.[1] ?? "";
}

afterAll(() => {
	for (const dir of createdDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// Top-level CI guard (#448 convention). It must live OUTSIDE the conditional
// describe below: a suite-level skip would skip the guard itself — exactly
// the silent-vanish state it exists to catch. Locally a missing devDependency
// is fine; in CI a missing binary fails loud.
it("real Biome and TypeScript binaries are installed in CI", () => {
	if (process.env.CI) {
		expect(
			BINARIES_PRESENT,
			"real @biomejs/biome and typescript devDeps are required for the real-binary decorator-metadata proof (refs #2385)",
		).toBe(true);
	}
});

// Skipped visibly when the real binaries are absent; the title names them so
// a skipped report reads as a dependency skip, not a pass.
describe.skipIf(!BINARIES_PRESENT)(
	"bundled biome config preserves decorator metadata (real @biomejs/biome + typescript devDeps; refs #2385)",
	() => {
		it(
			"bundled fallback keeps the value import and its design:type metadata",
			{ timeout: 120_000 },
			async () => {
				const dir = await makeFixture(false);
				const file = path.join(dir, "src", "widget.ts");
				expect(fs.readFileSync(file, "utf-8")).toContain(
					'import { CounterModel } from "./model";',
				);

				const client = new BiomeClient();
				const result = await client.fixFileAsync(file, dir);

				// Positive control: the config parsed, biome ran, and no other
				// safe fix fired — so an unchanged import is evidence about THIS
				// rule, not a silently failed run.
				expect(result.success).toBe(true);
				expect(result.changed).toBe(false);
				const after = fs.readFileSync(file, "utf-8");
				expect(after).toContain('import { CounterModel } from "./model";');
				expect(after).not.toContain("import type");
				expect(await observedDesignType(dir)).toBe("CounterModel");
			},
		);

		it(
			"an explicit project biome.json stays authoritative: useImportType still converts",
			{ timeout: 120_000 },
			async () => {
				const dir = await makeFixture(true);
				// No --config-path flag: biomeConfigArgs yields to the user config.
				expect(biomeConfigArgs(dir)).toEqual([]);

				const client = new BiomeClient();
				const result = await client.fixFileAsync(
					path.join(dir, "src", "widget.ts"),
					dir,
				);

				expect(result.success).toBe(true);
				expect(
					fs.readFileSync(path.join(dir, "src", "widget.ts"), "utf-8"),
				).toContain('import type { CounterModel } from "./model";');
				// The consequence the user opted into: metadata identity changes.
				expect(await observedDesignType(dir)).toBe("Function");
			},
		);

		it(
			"other recommended rules still fire under the bundled fallback config",
			{ timeout: 120_000 },
			async () => {
				const dir = await makeFixture(false);
				const dirty = path.join(dir, "src", "dirty.ts");
				fs.writeFileSync(dirty, "debugger;\n");

				const args = biomeConfigArgs(dir);
				expect(args[0]).toMatch(/^--config-path=/);
				expect(args[0]).toMatch(/config[\\/]biome[\\/]core\.jsonc$/);
				const lint = await safeSpawnAsync(
					process.execPath,
					[BIOME_BIN, "lint", ...args, dirty],
					{ timeout: 60_000, cwd: dir },
				);
				expect(lint.error).toBeUndefined();
				// Biome renders diagnostics on stderr.
				const rendered = `${lint.stdout ?? ""}${lint.stderr ?? ""}`;
				expect(rendered).toContain("lint/suspicious/noDebugger");
			},
		);
	},
);
