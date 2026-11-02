import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetIgnoredConfigWarnCache } from "../../clients/config-warn.js";
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import {
	loadPiLensGlobalConfig,
	resetGlobalConfigWarnCache,
} from "../../clients/lens-config.js";
import {
	loadPiLensProjectConfig,
	resetProjectLensConfigCache,
} from "../../clients/project-lens-config.js";
import {
	resetUserNotifier,
	wireUserNotifier,
} from "../../clients/user-notify.js";
import { removeTempDirSync } from "./test-utils.js";

/**
 * Which stable code each user-visible config notice carries (#5140).
 *
 * The registry (`clients/config-diagnostic-codes.ts`) says `PILENS_CFG_0001`
 * means "config file unreadable or unparsable", `PILENS_CFG_0004` an unknown
 * field, and `PILENS_CFG_0005` a rejected value. Before #5140 both loaders
 * stamped EVERY hand-written notice with 0001, so a misspelled key told a
 * user the whole file was unreadable, and anyone filtering on 0001 saw the
 * typo notices too. These cases drive the real loaders (no mocks) and read
 * the code off the host notification, the same seam a user sees.
 */

const CODE_MARKER = /\[(PILENS_CFG_\d{4})\]/;

const notices: string[] = [];
let root: string;

beforeEach(() => {
	notices.length = 0;
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cfg-codes-"));
	wireUserNotifier(() => (message) => {
		notices.push(message);
	});
	resetIgnoredConfigWarnCache();
	resetProjectLensConfigCache();
	resetGlobalConfigWarnCache();
	resetDegradationLedger();
});

afterEach(() => {
	resetUserNotifier();
	resetIgnoredConfigWarnCache();
	resetProjectLensConfigCache();
	resetGlobalConfigWarnCache();
	resetDegradationLedger();
	removeTempDirSync(root);
});

/** The code of every notice the host received, in order. */
function codesOfNotices(): string[] {
	return notices.map((message) => CODE_MARKER.exec(message)?.[1] ?? "(none)");
}

/** Write a project `.pi-lens.json` and load it through the production loader. */
function loadProject(text: string) {
	const dir = path.join(root, "project");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi-lens.json"), text);
	return loadPiLensProjectConfig(dir);
}

/** Write a global `config.json` and load it through the production loader. */
function loadGlobal(text: string) {
	const file = path.join(root, "config.json");
	fs.writeFileSync(file, text);
	return loadPiLensGlobalConfig(file);
}

// Pre-fix each row below printed PILENS_CFG_0001 unless noted as a control.
const PROJECT_CASES = [
	[
		"an unknown top-level key",
		'{ "lps": { "enabled": true } }',
		"PILENS_CFG_0004",
	],
	[
		"a global-only setting in a project file",
		'{ "lsp": { "enabled": false } }',
		"PILENS_CFG_0004",
	],
	[
		"a global-only namespace",
		'{ "dispatch": { "bogus": 1 } }',
		"PILENS_CFG_0004",
	],
	[
		"a wrong-typed value",
		'{ "reviewGraph": { "maxFiles": "x" } }',
		"PILENS_CFG_0005",
	],
	[
		"a rule that is not an object",
		'{ "rules": { "x": 5 } }',
		"PILENS_CFG_0005",
	],
	// Unchanged by #5140: a document that is not a JSON object is ignored whole,
	// so it keeps the read/parse code (#2445).
	["a top-level array", "[1, 2]", "PILENS_CFG_0001"],
	["a top-level scalar", '"x"', "PILENS_CFG_0001"],
	// One row per notice site the table did not reach before #5140 (F3): a code
	// flipped at that site turns its row red.
	[
		"a maxProjectFiles that is not a number",
		'{ "maxProjectFiles": "x" }',
		"PILENS_CFG_0005",
	],
	[
		"a reviewGraph that is not an object",
		'{ "reviewGraph": "x" }',
		"PILENS_CFG_0005",
	],
	[
		"a rule threshold that is not a number",
		'{ "rules": { "x": { "threshold": "n" } } }',
		"PILENS_CFG_0005",
	],
	[
		"a rule disable that is not an array",
		'{ "rules": { "x": { "disable": "n" } } }',
		"PILENS_CFG_0005",
	],
	[
		"a rule disable with no usable string",
		'{ "rules": { "x": { "disable": [1] } } }',
		"PILENS_CFG_0005",
	],
	[
		"a rule ignorePaths that is not an array",
		'{ "rules": { "x": { "ignorePaths": "n" } } }',
		"PILENS_CFG_0005",
	],
	[
		"a rule ignorePaths with no usable string",
		'{ "rules": { "x": { "ignorePaths": [1] } } }',
		"PILENS_CFG_0005",
	],
	[
		"a rule with no recognized setting",
		'{ "rules": { "x": {} } }',
		"PILENS_CFG_0004",
	],
	// Controls: these already carried their own code before #5140.
	[
		"an invalid enum value (core-validated)",
		'{ "startup": { "mode": "nope" } }',
		"PILENS_CFG_0005",
	],
	[
		"an unknown tool name",
		'{ "tools": { "nosuchtool": { "enabled": false } } }',
		"PILENS_CFG_0009",
	],
	["a truncated file (unparsable)", '{ "lps": ', "PILENS_CFG_0001"],
] as const;

const GLOBAL_CASES = [
	[
		"an unknown top-level key",
		'{ "lps": { "enabled": true } }',
		"PILENS_CFG_0004",
	],
	[
		"an invalid enum value",
		'{ "format": { "mode": "nonsense" } }',
		"PILENS_CFG_0005",
	],
	["a wrong-typed value", '{ "tools": { "lazy": "nope" } }', "PILENS_CFG_0005"],
	// Unchanged by #5140: a document that is not a JSON object is ignored whole,
	// so it keeps the read/parse code (#2445).
	["a top-level array", "[1, 2]", "PILENS_CFG_0001"],
	["a top-level scalar", '"x"', "PILENS_CFG_0001"],
	// The flag helpers in lens-flag-registry.ts warn through the same callback.
	[
		"a flag section that is not an object",
		'{ "contextInjection": "yes" }',
		"PILENS_CFG_0005",
	],
	[
		"a flag leaf that is not a boolean",
		'{ "contextInjection": { "retain": "yes" } }',
		"PILENS_CFG_0005",
	],
	// One row per global notice site the table did not reach before #5140 (F3).
	[
		"a runner timeout floor that is not a number",
		'{ "dispatch": { "runnerTimeoutFloorMs": "x" } }',
		"PILENS_CFG_0005",
	],
	[
		"an autoFix maxFixes that is not a number",
		'{ "actionableWarnings": { "autoFix": { "maxFixes": "x" } } }',
		"PILENS_CFG_0005",
	],
	[
		"a requirePreExistingFixes that is not a boolean",
		'{ "contextInjection": { "requirePreExistingFixes": "x" } }',
		"PILENS_CFG_0005",
	],
	[
		"a widget visible flag that is not a boolean",
		'{ "widget": { "visible": "x" } }',
		"PILENS_CFG_0005",
	],
	// Controls: unchanged by #5140.
	[
		"an unknown tool name",
		'{ "tools": { "nosuchtool": { "enabled": false } } }',
		"PILENS_CFG_0009",
	],
	["a truncated file (unparsable)", '{ "lps": ', "PILENS_CFG_0001"],
] as const;

describe("project loader notices carry the code their kind names (#5140)", () => {
	it.each(PROJECT_CASES)("%s", (_label, text, code) => {
		loadProject(text);
		expect(codesOfNotices()).toEqual([code]);
	});
});

describe("global loader notices carry the code their kind names (#5140)", () => {
	it.each(GLOBAL_CASES)("%s", (_label, text, code) => {
		loadGlobal(text);
		expect(codesOfNotices()).toEqual([code]);
	});
});

describe("a coded notice never changes what the file applies (#5140)", () => {
	it("keeps the valid settings beside a rejected unknown key", () => {
		const config = loadGlobal(
			'{ "lps": { "enabled": true }, "format": { "mode": "deferred" } }',
		);
		expect(config?.format?.mode).toBe("deferred");
		expect(codesOfNotices()).toEqual(["PILENS_CFG_0004"]);
	});

	it("keeps the valid settings beside a rejected value in a project file", () => {
		const config = loadProject(
			'{ "reviewGraph": { "maxFiles": "x" }, "rules": { "r": { "threshold": 3 } } }',
		);
		expect(config.rules.r?.threshold).toBe(3);
		expect(codesOfNotices()).toEqual(["PILENS_CFG_0005"]);
	});
});
