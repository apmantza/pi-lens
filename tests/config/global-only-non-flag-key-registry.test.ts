/**
 * Governance test for `GLOBAL_ONLY_NON_FLAG_KEYS` (#3131 review round 2).
 *
 * `clients/lens-flag-registry.ts`'s `GLOBAL_ONLY_NON_FLAG_KEYS` is the single
 * source the project loader's mixed-scope sub-key scan
 * (`clients/project-lens-config.ts`) derives its non-flag global-only
 * population from — the sibling, at KEY granularity, of the SECTION-level
 * registries. No test checks those section lists now. Nothing else verified a
 * member is actually global-only, so a wrongly-added entry naming a key the PROJECT
 * loader genuinely honors too (e.g. `startup.mode`, parsed identically at
 * both scopes) would make the mixed-scope scan emit a false "global-only,
 * ignored" notice for a value that still takes effect — #3112 verbatim (a
 * documented project-scope override announced as ignored while it was
 * actually honored), reproduced through a bad REGISTRY ENTRY instead of a
 * bad SECTION LIST.
 *
 * For every member of `GLOBAL_ONLY_NON_FLAG_KEYS`, this drives BOTH real
 * loaders through `GLOBAL_HONOR_CHECKS` below — one entry per member, naming
 * a TYPE-VALID value and the key's own documented production reader. A
 * member with no entry fails both assertions by name (a hole in COVERAGE,
 * not a silently-accepted hole in the registry: the loop is
 * `GLOBAL_ONLY_NON_FLAG_KEYS.map`, never a hand-typed list of key names):
 *
 *   (a) the GLOBAL loader honors the key — the SAME value, written to a
 *       pinned `~/.pi-lens/config.json`, comes back through the reader;
 *   (b) the PROJECT loader drops the SAME value from the parsed struct
 *       (checked generically: the value must never reach ANY field of the
 *       parsed config — `.raw` and `.configPath` excluded, since `.raw`
 *       deliberately mirrors the whole file for other subsystems, e.g.
 *       `trivy-client.ts`, `helm-render.ts`) — AND emits the one-time
 *       `"<key>" is a global-only` notice.
 *
 * Reusing the SAME value for both halves matters: a naive independently-
 * invented marker for (b) can be REJECTED by a field's own type validation
 * (`startup.mode` accepts only `"quick"|"full"|"minimal"`) before it ever
 * reaches the mixed-scope scan, which would make (b) pass for the wrong
 * reason — dropped because malformed, not because the scan (correctly)
 * never honors it. A value already proven valid enough for the GLOBAL
 * reader to accept in (a) does not have that blind spot: if a value like
 * `startup.mode: "minimal"` were ever wrongly promoted to
 * `GLOBAL_ONLY_NON_FLAG_KEYS`, (a) would legitimately pass (the global
 * loader really does read `startup.mode`) and (b) is what catches it —
 * `"minimal"` is a well-formed value the project loader's OWN `startup.mode`
 * parser accepts and stores, so it PROVES the leak instead of coincidentally
 * avoiding it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getGlobalActionableWarningMaxFixes,
	getGlobalLspQueryMaxFileLines,
	getPiLensGlobalConfigPath,
	loadPiLensGlobalConfig,
	resetGlobalConfigWarnCache,
} from "../../clients/lens-config.js";
import { GLOBAL_ONLY_NON_FLAG_KEYS } from "../../clients/lens-flag-registry.js";
import {
	loadPiLensProjectConfig,
	resetProjectLensConfigCache,
} from "../../clients/project-lens-config.js";
import { removeTempDirSync } from "../clients/test-utils.js";
import { useConfigPath } from "../support/global-config.js";

// Same sink-forwarding shim `project-lens-config.test.ts` and
// `lens-config.test.ts` each install — see either file's comment for why.
vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: { message: string }) => console.error(entry.message),
	};
});

/** Build the nested object a dotted config key reads from. */
function nestedObjectFor(
	configKey: string,
	value: unknown,
): Record<string, unknown> {
	const segments = configKey.split(".");
	const root: Record<string, unknown> = {};
	let node = root;
	for (const segment of segments.slice(0, -1)) {
		node[segment] = {};
		node = node[segment] as Record<string, unknown>;
	}
	node[segments.at(-1) as string] = value;
	return root;
}

interface GlobalHonorCheck {
	/**
	 * A value the key's OWN type validation accepts — reused verbatim for both
	 * the global-honor read (a) and the project-drop probe (b), and chosen
	 * distinctive enough that it cannot collide with any other field's default
	 * or a sibling test's value.
	 */
	value: unknown;
	/** The key's own documented production reader. */
	read: (configPath: string) => unknown;
}

/**
 * One entry per `GLOBAL_ONLY_NON_FLAG_KEYS` member, naming how the GLOBAL
 * loader is proven to honor it. A member with no entry here fails both
 * assertions below by name — this is the enforcement the registry itself
 * lacked (#3131 R2).
 */
const GLOBAL_HONOR_CHECKS: ReadonlyMap<string, GlobalHonorCheck> = new Map([
	[
		"actionableWarnings.autoFix.maxFixes",
		{
			value: 483_721,
			read: (configPath) => getGlobalActionableWarningMaxFixes(configPath),
		},
	],
	[
		// `dispatch` is recognized at project scope for `dispatch.disabledRunners`,
		// so this sibling needs the mixed-scope notice. Its reader
		// (`getRunnerTimeoutFloorMs`) memoizes and merges an env var, so the
		// proof reads the loader projection it is built from.
		"dispatch.runnerTimeoutFloorMs",
		{
			value: 483_722,
			read: (configPath) =>
				loadPiLensGlobalConfig(configPath)?.dispatch?.runnerTimeoutFloorMs,
		},
	],
	[
		// #5306: `lsp` is a project-recognized namespace (the LSP loader's), so a
		// project file carrying the explicit-query line limit needs the dotted
		// global-only notice. In range [5000, 40000], and unlike a round number it
		// cannot collide with a default the project struct carries.
		"lsp.queryMaxFileLines",
		{
			value: 23_456,
			read: (configPath) => getGlobalLspQueryMaxFileLines(configPath),
		},
	],
]);

let tmpDirs: string[] = [];
let projectDir: string;
const setConfigPath = useConfigPath();

function makeTempHome(): string {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-global-only-non-flag-"),
	);
	tmpDirs.push(dir);
	return dir;
}

beforeEach(() => {
	setConfigPath(undefined);
	projectDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-global-only-non-flag-project-"),
	);
	tmpDirs.push(projectDir);
	resetGlobalConfigWarnCache();
	resetProjectLensConfigCache();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetGlobalConfigWarnCache();
	resetProjectLensConfigCache();
	for (const dir of tmpDirs.splice(0)) removeTempDirSync(dir);
	tmpDirs = [];
});

function warnedFor(substring: string): boolean {
	return (console.error as ReturnType<typeof vi.fn>).mock.calls
		.flat()
		.some((arg) => typeof arg === "string" && arg.includes(substring));
}

describe.each(GLOBAL_ONLY_NON_FLAG_KEYS)(
	"GLOBAL_ONLY_NON_FLAG_KEYS member %s (#3131 R2)",
	(configKey) => {
		const check = GLOBAL_HONOR_CHECKS.get(configKey);
		const missingCheckMessage =
			`"${configKey}" has no wired GLOBAL_HONOR_CHECKS entry — add one ` +
			`naming a type-valid value and the global reader that proves this ` +
			`key is really global-only`;

		it("is honored by the global loader through its own documented reader", () => {
			expect(check, missingCheckMessage).toBeDefined();
			if (!check) return;
			const home = makeTempHome();
			const configPath = getPiLensGlobalConfigPath(home);
			fs.mkdirSync(path.dirname(configPath), { recursive: true });
			fs.writeFileSync(
				configPath,
				JSON.stringify(nestedObjectFor(configKey, check.value)),
				"utf-8",
			);
			expect(check.read(configPath), configKey).toEqual(check.value);
		});

		it("is dropped from the project-parsed struct and emits the one-time global-only notice", () => {
			expect(check, missingCheckMessage).toBeDefined();
			if (!check) return;
			fs.writeFileSync(
				path.join(projectDir, ".pi-lens.json"),
				JSON.stringify(nestedObjectFor(configKey, check.value)),
			);
			const cfg = loadPiLensProjectConfig(projectDir);
			expect(warnedFor(`"${configKey}" is a global-only`), configKey).toBe(
				true,
			);
			expect(
				warnedFor("pass the matching CLI flag"),
				`${configKey} is not backed by a CLI flag`,
			).toBe(false);
			// Every field EXCEPT `.raw`/`.configPath` — `.raw` deliberately mirrors
			// the whole file for other subsystems (trivy-client.ts,
			// helm-render.ts) and must still carry the value; that is not this
			// key taking effect at project scope.
			const { raw: _raw, configPath: _configPath, ...parsed } = cfg;
			expect(JSON.stringify(parsed), configKey).not.toContain(
				JSON.stringify(check.value),
			);
		});
	},
);
