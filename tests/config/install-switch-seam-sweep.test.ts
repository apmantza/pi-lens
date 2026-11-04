/**
 * Every install path asks the install kill switch through one seam (#5231).
 *
 * RECURRENCE THIS PREVENTS: #5231. `PI_LENS_DISABLE_TOOL_INSTALL=1` stopped
 * only the managed installer. The lazy installer (`gem install`, `rustup
 * component add`) and govulncheck's `go install` called `assertInstallAllowed`
 * (project trust) and never read the switch, so a tool was installed with the
 * operator's switch set. The installer itself carried four hand-written copies
 * of the read, and the LSP switch two. `clients/env-utils.ts` now owns both
 * reads (`isToolInstallDisabledByEnv`, `isLspInstallDisabledByEnv`).
 *
 * Two detectors, each fail-closed over comment-blanked source (string contents
 * kept: the evidence for a bracket read is a string literal, so the needle policy
 * is "keep" for this scan).
 *
 * 1. RAW READS. Admitted: the seam's own file, `PI_LENS_DISABLE_TOOL_REFRESH`
 *    (another switch), and a switch name followed by `=` (message text such as
 *    `refused — PI_LENS_DISABLE_TOOL_INSTALL=1`). Every other occurrence of the
 *    `PI_LENS_DISABLE_` prefix refuses: a dot read, a bracket read, a
 *    destructured read, a name split across a concatenation.
 * 2. THE GATE POPULATION. Every file that mentions `assertInstallAllowed` (the
 *    central trust gate for downloading or installing executable content,
 *    whatever the spelling: import, alias, namespace member, string key) must
 *    be classified below. A `tool` row must call `isToolInstallDisabledByEnv`,
 *    an `lsp` row `isLspInstallDisabledByEnv`; an unclassified file, or a row
 *    whose file no longer mentions the gate, reds.
 *
 * Residual, stated: an install path that calls neither the trust gate nor the
 * seam is outside detector 2's population, and a read of a switch name that is
 * assembled from fragments none of which holds `PI_LENS_DISABLE_` is outside
 * detector 1. The behaviour cells in `tests/clients/install-kill-switch-5231.test.ts`
 * are the guard for those.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_FORMATTERS } from "../../clients/formatters.js";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** The seam's own file; the one place the switches are read. */
const SEAM_FILE = "clients/env-utils.ts";

type GateRow =
	| { switch: "tool" | "lsp" }
	| { switch: "exempt"; reason: string };

/** Files that mention `assertInstallAllowed`, and what each does about the switch. */
const GATE_USERS: Record<string, GateRow> = {
	"clients/installer/index.ts": { switch: "tool" },
	"clients/dispatch/runners/utils/lazy-installer.ts": { switch: "tool" },
	"clients/govulncheck-client.ts": { switch: "tool" },
	"clients/lsp/client-registry.ts": { switch: "lsp" },
	"clients/formatters.ts": {
		switch: "exempt",
		reason:
			"the formatter lazy installs reach `runLazyInstall` (a `tool` row above); the static `npx` fallback is reached by no registered formatter (asserted below), and `resolveNpxFallback` goes through `ensureTool`",
	},
	"clients/tree-sitter-client.ts": {
		switch: "exempt",
		reason:
			"a wasm grammar fetch, not a managed tool: the switch is documented for formatters, linters and scanners (docs/environment-variables.md), and the harness sets it for every test while grammars must still load",
	},
	"index.ts": {
		switch: "exempt",
		reason:
			"hands `assertInstallAllowed` to the host port `spawn.isAllowed` (clients/host-ports.ts); no install path calls that port",
	},
};

interface Finding {
	line: number;
	what: string;
}

function lineAt(source: string, index: number): number {
	return source.slice(0, index).split("\n").length;
}

/** Detector 1: occurrences of the switch prefix that no admitted form covers. */
export function scanRawSwitchReads(source: string): Finding[] {
	const kept = stripSource(source, { strings: "keep" });
	const findings: Finding[] = [];
	for (const m of kept.matchAll(/PI_LENS_DISABLE_[A-Z_]*/g)) {
		const token = m[0];
		const after = kept[(m.index ?? 0) + token.length];
		if (token === "PI_LENS_DISABLE_TOOL_REFRESH") continue;
		if (
			(token === "PI_LENS_DISABLE_TOOL_INSTALL" ||
				token === "PI_LENS_DISABLE_LSP_INSTALL") &&
			after === "="
		)
			continue;
		findings.push({ line: lineAt(kept, m.index ?? 0), what: token });
	}
	return findings;
}

/** Detector 2, population: the file mentions the trust gate in any spelling. */
export function mentionsInstallGate(source: string): boolean {
	const kept = stripSource(source, { strings: "keep" });
	// The file that defines the gate is its owner, not a user of it.
	if (/\bfunction\s+assertInstallAllowed\b/.test(kept)) return false;
	return /assertInstallAllowed/.test(kept);
}

/** Detector 2, evidence: the file calls the seam function in code. */
export function callsSeam(source: string, fn: string): boolean {
	return new RegExp(`\\b${fn}\\s*\\(`).test(
		stripSource(source, { strings: "blank" }),
	);
}

const SOURCE_ROOTS = ["clients", "tools", "mcp"];

function productionFiles(): Array<{ rel: string; source: string }> {
	const files = [
		...SOURCE_ROOTS.flatMap((dir) =>
			listSourceFiles(path.join(ROOT, dir), { skipTests: true }),
		),
		path.join(ROOT, "index.ts"),
	];
	return files.map((file) => ({
		rel: relativePosix(ROOT, file),
		source: fs.readFileSync(file, "utf-8"),
	}));
}

describe("install kill switches have one reader (#5231)", () => {
	let memo: Array<{ rel: string; source: string }> | undefined;
	const population = () => (memo ??= productionFiles());

	it(
		"scans a real production population",
		() => {
			assertNonEmptyScan("install-switch-seam sweep", population().length, 300);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"no file outside the seam reads a switch itself",
		() => {
			const offenders = population()
				.filter(({ rel }) => rel !== SEAM_FILE)
				.flatMap(({ rel, source }) =>
					scanRawSwitchReads(source).map((f) => `${rel}:${f.line} ${f.what}`),
				);
			expect(offenders).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"every file that mentions the trust install gate is classified, and a tool row calls the seam",
		() => {
			const users = population().filter(({ source }) =>
				mentionsInstallGate(source),
			);
			const unclassified = users
				.map(({ rel }) => rel)
				.filter((rel) => !(rel in GATE_USERS))
				.sort();
			expect(unclassified).toEqual([]);

			const stale = Object.keys(GATE_USERS)
				.filter((rel) => !users.some((u) => u.rel === rel))
				.sort();
			expect(stale).toEqual([]);

			const missingCall = users.flatMap(({ rel, source }) => {
				const row = GATE_USERS[rel];
				if (row === undefined || row.switch === "exempt") return [];
				const fn =
					row.switch === "tool"
						? "isToolInstallDisabledByEnv"
						: "isLspInstallDisabledByEnv";
				return callsSeam(source, fn) ? [] : [`${rel} never calls ${fn}`];
			});
			expect(missingCall).toEqual([]);

			for (const [rel, row] of Object.entries(GATE_USERS)) {
				if (row.switch === "exempt")
					expect(row.reason.length, rel).toBeGreaterThan(40);
			}
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("no registered formatter reaches the static npx fallback", () => {
		// The `clients/formatters.ts` exemption above rests on this: a formatter with
		// an `npx` static command and no `resolveCommand` would run `npx` (which can
		// download) after `ensureTool` declined under the switch.
		const reachable = ALL_FORMATTERS.filter(
			(f) => f.command[0] === "npx" && f.resolveCommand === undefined,
		).map((f) => f.name);
		expect(reachable).toEqual([]);
	});
});

describe("the detectors refuse spellings their author did not design for (shape 69)", () => {
	it("detector 1 refuses an alias, an indirect read and a read through another binding", () => {
		const alias = `const e = process.env;\nif (e.PI_LENS_DISABLE_TOOL_INSTALL === "1") {}`;
		const indirect = `const k = "PI_LENS_DISABLE_";\nconst v = process.env[k + "TOOL_INSTALL"];`;
		const binding = `const { PI_LENS_DISABLE_LSP_INSTALL: off } = process.env;`;
		const bracket = `const v = process.env["PI_LENS_DISABLE_TOOL_INSTALL"];`;
		for (const [name, source] of Object.entries({
			alias,
			indirect,
			binding,
			bracket,
		}))
			expect(scanRawSwitchReads(source), name).not.toEqual([]);
	});

	it("detector 1 admits message text, another switch, and comments", () => {
		const text = "const m = `refused — PI_LENS_DISABLE_TOOL_INSTALL=1`;";
		const other = `const v = process.env.PI_LENS_DISABLE_TOOL_REFRESH;`;
		const prose = `// PI_LENS_DISABLE_TOOL_INSTALL is read in env-utils\n/* PI_LENS_DISABLE_LSP_INSTALL */`;
		expect(scanRawSwitchReads(text)).toEqual([]);
		expect(scanRawSwitchReads(other)).toEqual([]);
		expect(scanRawSwitchReads(prose)).toEqual([]);
	});

	it("detector 2 sees an aliased import, a namespace member and a destructured dynamic import", () => {
		const aliased = `import { assertInstallAllowed as gate } from "./gate.js";\ngate("x");`;
		const namespace = `import * as trust from "./gate.js";\ntrust.assertInstallAllowed("x");`;
		const dynamic = `const { assertInstallAllowed: gate } = await import("./gate.js");`;
		const bracket = `import * as trust from "./gate.js";\ntrust["assertInstallAllowed"]("x");`;
		for (const [name, source] of Object.entries({
			aliased,
			namespace,
			dynamic,
			bracket,
		}))
			expect(mentionsInstallGate(source), name).toBe(true);
	});

	it("detector 2 does not count the file that defines the gate as a user of it", () => {
		expect(
			mentionsInstallGate(
				"export function assertInstallAllowed(context: string): boolean {\n\treturn true;\n}",
			),
		).toBe(false);
	});

	it("detector 2 does not take a comment for the seam call or for the gate", () => {
		expect(
			callsSeam(
				`// isToolInstallDisabledByEnv() would go here\nconst s = "isToolInstallDisabledByEnv(";`,
				"isToolInstallDisabledByEnv",
			),
		).toBe(false);
		expect(
			mentionsInstallGate(`// assertInstallAllowed is called elsewhere`),
		).toBe(false);
	});
});
