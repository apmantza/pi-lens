/**
 * Golden projections of the three config loaders, per on-disk layout (#2426).
 *
 * #2426 re-hosts `loadLSPConfig`, `loadPiLensGlobalConfig` and
 * `loadPiLensProjectConfig` on the #2425 config core. The acceptance criterion
 * is that their PROJECTED return values stay deep-equal to what the pre-#2426
 * loaders produced, except for a SHORT, ENUMERATED list of deliberate changes.
 *
 * That is enforced here rather than asserted in prose:
 *
 * 1. `tests/fixtures/config-golden/*.json` was captured by running THIS file
 *    against pre-#2426 `clients/` (see `PI_LENS_CAPTURE_CONFIG_GOLDEN` below)
 *    and committed BEFORE the refactor. Those files are a frozen record of the
 *    old behavior and are never regenerated to make a diff go away.
 * 2. `ENUMERATED_DELTAS` below patches the frozen fixture into what #2426
 *    deliberately changes. Every entry names the change and the reason.
 * 3. The comparison is fixture-plus-deltas vs live. An UNENUMERATED difference
 *    fails, which is the point: a silent projection change cannot pass.
 *
 * Re-capture (only meaningful on pre-change code):
 *   PI_LENS_CAPTURE_CONFIG_GOLDEN=1 npx vitest run tests/clients/config-golden-layouts.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";
import { useConfigPath } from "../support/global-config.js";
const setConfigPath = useConfigPath();

// Same reason as tests/clients/lsp/config.test.ts: the extension log is an
// ndjson sink, not the terminal. Silenced here so a layout that deliberately
// carries a deprecated location does not spray the test output.
vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return { ...actual, logExtension: () => {} };
});

const CAPTURE = process.env.PI_LENS_CAPTURE_CONFIG_GOLDEN === "1";
const FIXTURE_DIR = path.join(
	import.meta.dirname,
	"..",
	"fixtures",
	"config-golden",
);

interface Layout {
	/** Fixture basename. */
	readonly name: string;
	/**
	 * Files to write, relative to the FAKE HOME: `.pi-lens/` is the
	 * machine-global dir and `proj/` the project root.
	 */
	readonly files: Readonly<Record<string, unknown>>;
	/** Directory the loaders are called with, relative to the fake home. */
	readonly startDir: string;
}

const CUSTOM_SERVER = {
	name: "Custom",
	extensions: [".custom"],
	command: "custom-lsp",
	args: ["--stdio"],
	rootMarkers: ["package.json"],
};

const LAYOUTS: readonly Layout[] = [
	{
		name: "lsp-json-only",
		startDir: "proj",
		files: {
			"proj/.pi-lens/lsp.json": {
				servers: { custom: CUSTOM_SERVER },
				serverOverrides: { rust: { initializationOptions: { check: true } } },
				disabledServers: ["typos"],
				warmFiles: ["src/main.rs"],
			},
		},
	},
	{
		name: "canonical-only",
		startDir: "proj",
		files: {
			"proj/.pi-lens.json": {
				ignore: ["dist/**"],
				rules: { "high-complexity": { threshold: 25 } },
				maxProjectFiles: 4000,
				lsp: {
					servers: { custom: CUSTOM_SERVER },
					disabledServers: ["typos"],
				},
			},
		},
	},
	{
		name: "pi-lsp-json",
		startDir: "proj",
		files: {
			"proj/pi-lsp.json": {
				servers: { custom: CUSTOM_SERVER },
				warmFiles: ["src/lib.rs"],
			},
		},
	},
	{
		name: "legacy-undotted-project",
		startDir: "proj",
		files: {
			"proj/pi-lens.json": {
				ignore: ["vendor/**"],
				maxProjectFiles: 1234,
			},
		},
	},
	{
		name: "mixed",
		startDir: "proj",
		files: {
			"proj/.pi-lens/lsp.json": {
				servers: { legacy: { ...CUSTOM_SERVER, name: "FromLspJson" } },
				disabledServers: ["typos"],
			},
			"proj/.pi-lens.json": {
				ignore: ["dist/**"],
				servers: { canonical: { ...CUSTOM_SERVER, name: "FromPiLensJson" } },
				warmFiles: ["src/main.rs"],
			},
		},
	},
	{
		name: "nested-package",
		startDir: "proj/packages/a",
		files: {
			"proj/.pi-lens.json": {
				ignore: ["dist/**"],
				maxProjectFiles: 9000,
				lsp: { disabledServers: ["typos"] },
			},
			"proj/packages/a/.pi-lens.json": {
				ignore: ["fixtures/**"],
				lsp: { warmFiles: ["src/a.ts"] },
			},
		},
	},
	{
		name: "global-and-project",
		startDir: "proj",
		files: {
			".pi-lens/lsp.json": {
				servers: { globalOnly: { ...CUSTOM_SERVER, name: "GlobalOnly" } },
				serverOverrides: { rust: { initializationOptions: { check: true } } },
				disabledServers: ["marksman"],
				warmFiles: ["global.rs"],
			},
			".pi-lens/config.json": {
				ignore: ["*.snap"],
				widget: { visible: false },
				dispatch: { runnerTimeoutFloorMs: 60000 },
				turnSummary: { enabled: true },
			},
			"proj/.pi-lens.json": {
				ignore: ["dist/**"],
				servers: { projectOnly: { ...CUSTOM_SERVER, name: "ProjectOnly" } },
			},
		},
	},
];

/**
 * Deliberate, changelogged projection changes #2426 makes. Keyed by
 * `<layout>.<projection>`; `apply` rewrites the FROZEN value into what the
 * change makes it, so a reviewer reads the transformation rather than a second
 * opaque blob, and anything not named here must still match byte for byte.
 *
 * Every entry corresponds to a line in `.changelog/feat-2426-*.md`.
 */
const ENUMERATED_DELTAS: Readonly<
	Record<
		string,
		{ readonly why: string; readonly apply: (frozen: unknown) => unknown }
	>
> = {
	"canonical-only.lsp": {
		why:
			"The `lsp` NAMESPACE is now the canonical home of LSP settings, so the " +
			"LSP projection is the `lsp` section rather than the whole file. Before, " +
			"`loadLSPConfig` returned every top-level key of `.pi-lens.json` — " +
			"`ignore`, `rules`, `maxProjectFiles` included — as if they were LSP " +
			"config, and the `lsp` section a user wrote did nothing at all.",
		apply: () => ({
			disabledServers: ["typos"],
			servers: { custom: CUSTOM_SERVER },
		}),
	},
	"mixed.lsp": {
		why:
			"Two changes, both #2426 scope. (a) The CANONICAL file wins: " +
			"`.pi-lens.json`'s `servers`/`warmFiles` now outrank the deprecated " +
			"`.pi-lens/lsp.json`, which previously won outright by being first in " +
			"the candidate list — a migration the user could never complete. (b) " +
			"Objects merge FIELD-WISE across sources (#2415), so `servers` carries " +
			"both entries instead of one file's map replacing the other's.",
		apply: () => ({
			disabledServers: ["typos"],
			servers: {
				canonical: { ...CUSTOM_SERVER, name: "FromPiLensJson" },
				legacy: { ...CUSTOM_SERVER, name: "FromLspJson" },
			},
			warmFiles: ["src/main.rs"],
		}),
	},
	"nested-package.lsp": {
		why:
			"Nested project configs LAYER (nearest wins per field) instead of the " +
			"nearest one winning wholesale, matching what `.pi-lens.json`'s `ignore` " +
			"has done since #783. The root's `lsp.disabledServers` now survives " +
			"beside the package's `lsp.warmFiles`; before, the package config " +
			"replaced the root config entirely — and, as in `canonical-only`, the " +
			"whole file was returned instead of its `lsp` section.",
		apply: () => ({
			disabledServers: ["typos"],
			warmFiles: ["src/a.ts"],
		}),
	},
	"nested-package.project": {
		why:
			"#5291: the project loader now reads through the layered seam, so a " +
			"session in `packages/a` keeps the root's `maxProjectFiles` and the " +
			"root's `lsp.disabledServers` (inside `raw`) unless the package sets " +
			"them; before, the package file won every field as a whole. This is " +
			"the same field-wise layering the `lsp` projection of this layout " +
			"already records. `ignore` stays the nearest file's list (replace, " +
			"not a union): nested `ignore` layering remains #783's " +
			"per-directory walk, not this loader's merge.",
		apply: (frozen) => {
			const project = frozen as Record<string, unknown>;
			const raw = project.raw as Record<string, unknown>;
			const lsp = raw.lsp as Record<string, unknown>;
			return {
				...project,
				maxProjectFiles: 9000,
				raw: {
					...raw,
					maxProjectFiles: 9000,
					lsp: { ...lsp, disabledServers: ["typos"] },
				},
			};
		},
	},
	"global-and-project.lsp": {
		why:
			"Same `lsp`-section projection: `.pi-lens.json`'s `ignore` is a project " +
			"config key and no longer leaks into `LSPConfig`. Everything else in " +
			"this layout — the field-wise `servers` merge across global and " +
			"project, `serverOverrides`, `disabledServers`, `warmFiles` — is " +
			"unchanged, which is the point of keeping the layout in the set.",
		apply: (frozen) => {
			const { ignore: _ignore, ...rest } = frozen as Record<string, unknown>;
			return rest;
		},
	},
};

const tempRoots: string[] = [];

function scrub(value: unknown, home: string): unknown {
	if (typeof value === "string") {
		const posix = value.replace(/\\/g, "/");
		const homePosix = home.replace(/\\/g, "/");
		return posix.startsWith(homePosix)
			? `<HOME>${posix.slice(homePosix.length)}`
			: posix;
	}
	if (Array.isArray(value)) return value.map((entry) => scrub(entry, home));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const child = (value as Record<string, unknown>)[key];
			// An explicitly-`undefined` property is dropped rather than mapped to
			// `null`, because that is what the comparison below means by it:
			// `toEqual` does not distinguish `{ a: undefined }` from `{}`. Writing
			// `null` into the fixture instead would freeze an artifact of the OLD
			// loaders' `{ ...global, ...project }` spread (which materializes an
			// `undefined` `disabledServers`/`warmFiles` key) as if it were part of
			// the contract, and every projection that stops materializing it would
			// read as a behavior change when nothing a caller can observe moved.
			if (child === undefined) continue;
			out[key] = scrub(child, home);
		}
		return out;
	}
	return value;
}

async function captureLayout(layout: Layout): Promise<unknown> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-golden-"));
	tempRoots.push(home);
	for (const [relative, content] of Object.entries(layout.files)) {
		const target = path.join(home, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, JSON.stringify(content, null, 2));
	}
	const startDir = path.join(home, layout.startDir);
	fs.mkdirSync(startDir, { recursive: true });

	const previousHome = process.env.PI_LENS_HOME;
	process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
	setConfigPath(path.join(home, ".pi-lens", "config.json"));

	const { loadLSPConfig, resetLSPConfigWarnCache } =
		await import("../../clients/lsp/config.js");
	const { loadPiLensGlobalConfig, resetGlobalConfigWarnCache } =
		await import("../../clients/lens-config.js");
	const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
		await import("../../clients/project-lens-config.js");
	resetLSPConfigWarnCache();
	resetGlobalConfigWarnCache();
	resetProjectLensConfigCache();

	try {
		return scrub(
			{
				lsp: await loadLSPConfig(startDir),
				global: loadPiLensGlobalConfig() ?? null,
				project: loadPiLensProjectConfig(startDir),
			},
			home,
		);
	} finally {
		if (previousHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = previousHome;
	}
}

function fixturePath(name: string): string {
	return path.join(FIXTURE_DIR, `${name}.json`);
}

function withDeltas(name: string, frozen: Record<string, unknown>): unknown {
	const out: Record<string, unknown> = { ...frozen };
	for (const projection of Object.keys(out)) {
		const delta = ENUMERATED_DELTAS[`${name}.${projection}`];
		if (delta) out[projection] = delta.apply(out[projection]);
	}
	return out;
}

afterEach(() => {
	for (const dir of tempRoots.splice(0)) removeTempDirSync(dir);
});

describe("config loader golden projections (#2426)", () => {
	for (const layout of LAYOUTS) {
		it(`projects ${layout.name} as its frozen pre-#2426 fixture`, async () => {
			const actual = await captureLayout(layout);
			if (CAPTURE) {
				// Capture mode writes the frozen record instead of comparing to it.
				// It still ASSERTS rather than returning early — a capture run that
				// silently produced nothing would be indistinguishable from a passing
				// one, which is the vacuous-skip shape #2089 exists to forbid.
				fs.mkdirSync(FIXTURE_DIR, { recursive: true });
				fs.writeFileSync(
					fixturePath(layout.name),
					`${JSON.stringify(actual, null, "\t")}\n`,
				);
				expect(fs.existsSync(fixturePath(layout.name))).toBe(true);
			} else {
				const frozen = JSON.parse(
					fs.readFileSync(fixturePath(layout.name), "utf-8"),
				) as Record<string, unknown>;
				expect(actual).toEqual(withDeltas(layout.name, frozen));
			}
		});
	}
});
