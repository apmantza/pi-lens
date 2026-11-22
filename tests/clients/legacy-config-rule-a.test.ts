/**
 * A legacy `pi-lens.json` follows ONE rule in every reader (#5740, the #5291
 * decision): once a canonical `.pi-lens.json` is in the chain, legacy documents
 * stay out; a chain with no canonical file still reads them.
 *
 * Recurrence this guards: the layered project loader refused a legacy file
 * beside a canonical one, while the dispatch policy, the nested per-file flag
 * and `ignore` readers and `effective_config` still merged or read it. A
 * half-migrated tree then answered autofix from the canonical file for a
 * session at `pkg`, and from `pkg/pi-lens.json` for an edit in it, and applied
 * legacy `rules.disable` the loader treats as records-only.
 *
 * One tree per config shape is driven through every reader that takes a
 * legacy document as input, with the production functions each reader's
 * callers use. The LSP loader is the documented exception and keeps reading
 * legacy `lsp` values for its deprecation window.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectRulePolicy } from "../../clients/dispatch/finding-policy.js";
import { effectiveConfig } from "../../clients/effective-config.js";
import { getProjectIgnoreMatcher } from "../../clients/file-utils.js";
import { resolvePiLensFlagWithSource } from "../../clients/lens-config.js";
import { loadLSPConfig } from "../../clients/lsp/config.js";
import {
	loadPiLensProjectConfig,
	resetProjectLensConfigCache,
} from "../../clients/project-lens-config.js";
import { registerRunnerId } from "../../clients/dispatch/known-runner-ids.js";
import { useConfigPath } from "../support/global-config.js";
import { removeTempDirSync } from "./test-utils.js";

const setConfigPath = useConfigPath();

let home: string;
let repo: string;
let pkg: string;
let previousPiLensHome: string | undefined;

function writeJson(relative: string, value: unknown): void {
	const target = path.join(home, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, JSON.stringify(value));
}

/** The canonical file the half-migrated project is moving to. */
const CANONICAL = { autofix: { enabled: true } };

/**
 * Legacy `pi-lens.json` at the repo root and in `pkg`. Every key a reader
 * could take from them carries a value the canonical file does not.
 */
const LEGACY_REPO = {
	autofix: { enabled: true },
	tools: { module_report: { enabled: false } },
	rules: { "kl-rule": { disable: ["no-legacy"] } },
	dispatch: { disabledRunners: ["dotnet-build"] },
	ignore: ["legacy-ignored/**"],
};
const LEGACY_PKG = {
	autofix: { enabled: false },
	rules: { "kn-rule": { disable: ["no-nested-legacy"] } },
	ignore: ["nested-legacy/**"],
};

/** What every reader answers when no canonical file is in the chain. */
const LEGACY_ONLY_ANSWERS = {
	"M1 session at repo, autofix.enabled": true,
	// The session at pkg reads pkg/pi-lens.json whole (nearest wins).
	"M1 session at pkg, autofix.enabled": false,
	// The nested legacy file decides the edit in pkg.
	"M2 edit in pkg, no-autofix": true,
	"M3 ignores pkg/nested-legacy/x.ts": true,
	"M3 ignores legacy-ignored/y.ts": true,
	"M4 rule keys for pkg/Program.cs": ["kl-rule", "kn-rule"],
	"M6 module_report enabled": false,
	"M6 dotnet-build denied by config": true,
};

beforeEach(() => {
	home = fs.realpathSync.native(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rule-a-")),
	);
	repo = path.join(home, "repo");
	pkg = path.join(repo, "pkg");
	previousPiLensHome = process.env.PI_LENS_HOME;
	process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
	setConfigPath(path.join(home, ".pi-lens", "config.json"));
	registerRunnerId("dotnet-build");
	resetProjectLensConfigCache();
	writeJson("repo/.git/HEAD", "ref: refs/heads/main");
});

afterEach(() => {
	resetProjectLensConfigCache();
	if (previousPiLensHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousPiLensHome;
	removeTempDirSync(home);
});

/** What each reader answers for the tree on disk, with the legacy signal named. */
async function answers(): Promise<Record<string, unknown>> {
	const edited = path.join(pkg, "Program.cs");
	const root = loadPiLensProjectConfig(repo);
	const inPkg = loadPiLensProjectConfig(pkg);
	// M2: the per-edit flag read (nested mutation value, then the project value).
	const flag = resolvePiLensFlagWithSource(
		"no-autofix",
		undefined,
		undefined,
		root,
		edited,
		repo,
	);
	// M3: the nested `ignore` matcher.
	const matcher = getProjectIgnoreMatcher(repo);
	// M4: the dispatch policy of the file's config owner.
	const policy = loadProjectRulePolicy(repo).forFile(edited);
	// M6: the introspection view for the same file.
	const view = await effectiveConfig({
		cwd: repo,
		homeDir: home,
		file: edited,
	});
	const file =
		view.file !== undefined && "tools" in view.file ? view.file : undefined;
	return {
		"M1 session at repo, autofix.enabled": root.autofix?.enabled,
		"M1 session at pkg, autofix.enabled": inPkg.autofix?.enabled,
		"M2 edit in pkg, no-autofix": flag.value,
		"M3 ignores pkg/nested-legacy/x.ts": matcher.isIgnored(
			path.join(pkg, "nested-legacy", "x.ts"),
			false,
		),
		"M3 ignores legacy-ignored/y.ts": matcher.isIgnored(
			path.join(repo, "legacy-ignored", "y.ts"),
			false,
		),
		"M4 rule keys for pkg/Program.cs": Object.keys(policy ?? {}).sort(),
		"M6 module_report enabled": view.tools.find(
			(tool) => tool.name === "module_report",
		)?.enabled,
		"M6 dotnet-build denied by config":
			file?.tools.find((tool) => tool.id === "dotnet-build")?.reason ===
			"disabled-by-config",
	};
}

describe("a legacy pi-lens.json follows one rule in every reader (#5740)", () => {
	it("a half-migrated tree answers from the canonical file in every reader", async () => {
		writeJson("repo/.pi-lens.json", CANONICAL);
		writeJson("repo/pi-lens.json", LEGACY_REPO);
		writeJson("repo/pkg/pi-lens.json", LEGACY_PKG);

		expect(await answers()).toEqual({
			"M1 session at repo, autofix.enabled": true,
			"M1 session at pkg, autofix.enabled": true,
			"M2 edit in pkg, no-autofix": false,
			"M3 ignores pkg/nested-legacy/x.ts": false,
			"M3 ignores legacy-ignored/y.ts": false,
			"M4 rule keys for pkg/Program.cs": [],
			"M6 module_report enabled": true,
			"M6 dotnet-build denied by config": false,
		});
	});

	it("a legacy-only tree still loads: every reader reads the legacy files", async () => {
		writeJson("repo/pi-lens.json", LEGACY_REPO);
		writeJson("repo/pkg/pi-lens.json", LEGACY_PKG);

		expect(await answers()).toEqual(LEGACY_ONLY_ANSWERS);
	});

	it("a canonical file above the git root is not in the chain", async () => {
		// The project chain ends at the git root (#5291), so a folder above the
		// repo cannot hide the repo's own legacy files.
		repo = path.join(home, "work", "repo");
		pkg = path.join(repo, "pkg");
		writeJson("work/repo/.git/HEAD", "ref: refs/heads/main");
		writeJson("work/.pi-lens.json", CANONICAL);
		writeJson("work/repo/pi-lens.json", LEGACY_REPO);
		writeJson("work/repo/pkg/pi-lens.json", LEGACY_PKG);

		expect(await answers()).toEqual(LEGACY_ONLY_ANSWERS);
	});

	it("the global file is not a project canonical file", () => {
		// PI_LENS_CONFIG_PATH may name any file. Discovery refuses the global
		// file as a project document (#2457), so it cannot hide a legacy one.
		setConfigPath(path.join(repo, ".pi-lens.json"));
		writeJson("repo/.pi-lens.json", CANONICAL);
		writeJson("repo/pkg/pi-lens.json", LEGACY_PKG);
		const flag = resolvePiLensFlagWithSource(
			"no-autofix",
			undefined,
			undefined,
			loadPiLensProjectConfig(repo),
			path.join(pkg, "a.ts"),
			repo,
		);

		expect(flag.value).toBe(true);
	});

	it("a canonical file above a nested legacy file is in the chain", async () => {
		// Canonical only at the repo root; the legacy file is two levels down.
		writeJson("repo/.pi-lens.json", CANONICAL);
		writeJson("repo/pkg/sub/pi-lens.json", {
			autofix: { enabled: false },
			ignore: ["deep-legacy/**"],
		});
		const edited = path.join(pkg, "sub", "a.ts");
		const flag = resolvePiLensFlagWithSource(
			"no-autofix",
			undefined,
			undefined,
			loadPiLensProjectConfig(repo),
			edited,
			repo,
		);

		expect(flag.value).toBe(false);
		expect(
			getProjectIgnoreMatcher(repo).isIgnored(
				path.join(pkg, "sub", "deep-legacy", "x.ts"),
				false,
			),
		).toBe(false);
	});

	it("keeps legacy lsp values: the LSP loader is the documented exception", async () => {
		writeJson("repo/.pi-lens.json", CANONICAL);
		writeJson("repo/pi-lsp.json", { disabledServers: ["typos"] });

		const lsp = await loadLSPConfig(repo, home, { report: false });

		expect(lsp.disabledServers).toContain("typos");
	});
});
