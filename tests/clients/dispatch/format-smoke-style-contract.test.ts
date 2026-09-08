/**
 * Format-smoke style-contract drift guard (#1144 follow-up).
 *
 * #1144 made biome/prettier/ruff/shfmt style-PRESERVING: with no formatter
 * config in the workspace AND no indented line to infer a style from, they
 * refuse to format rather than impose their stock style. Every `--format` smoke
 * fixture for those four was a flat, unindented snippet, so six rows
 * (javascript, python, shell, css, html, yaml) silently began asserting a
 * rewrite that the contract forbids — the nightly failed with "ran clean but
 * left the mis-formatted file unchanged" and nothing in the unit suite noticed.
 *
 * This screens the whole matrix instead of the six that happened to fire: a
 * `reformat` fixture driven by a style-pinning formatter must supply the style
 * evidence its formatter needs, or it can never pass.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasDetectableIndentation } from "../../../clients/dispatch/indent-detect.js";
import {
	ALL_FORMATTERS,
	resolveFormatterCwd,
} from "../../../clients/formatters.js";
// Typed via scripts/smoke-tools.d.mts (the harness itself is plain ESM JS).
import { FORMAT_FIXTURES } from "../../../scripts/smoke-tools.mjs";

const repoRoot = path.resolve(__dirname, "../../..");

describe("formatter-name cwd dispatch", () => {
	it("keeps Prettier at the gitignore root despite nested Biome config", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-format-dispatch-"),
		);
		try {
			const nested = path.join(root, "sub");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(path.join(root, ".gitignore"), "ignored.md\n");
			fs.writeFileSync(path.join(nested, "biome.json"), "{}\n");
			const filePath = path.join(nested, "app.ts");
			fs.writeFileSync(filePath, "const value = 1;\n");

			expect(resolveFormatterCwd(filePath, "prettier")).toBe(root);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

/** Formatters whose resolveCommand pins style from the file (indentationArgs). */
const STYLE_PINNING = new Set(["biome", "prettier", "ruff", "shfmt"]);

/** Config files that satisfy indentationArgs' "the repo already chose" branch. */
const CONFIG_FILES = new Set([
	".editorconfig",
	".prettierrc",
	".prettierrc.json",
	".prettierrc.yaml",
	".prettierrc.yml",
	".prettierrc.js",
	"prettier.config.js",
	"biome.json",
	"biome.jsonc",
	"ruff.toml",
	".ruff.toml",
	"pyproject.toml",
	"setup.cfg",
	"package.json",
]);

function hasFormatterConfig(dir: string): boolean {
	return fs
		.readdirSync(dir)
		.some((entry) => CONFIG_FILES.has(entry.toLowerCase()));
}

describe("format-smoke fixtures honor the style-preserving contract (#1144)", () => {
	const pinned = FORMAT_FIXTURES.filter((fx) =>
		STYLE_PINNING.has(fx.formatter),
	);

	it("covers every style-pinning formatter", () => {
		expect(new Set(pinned.map((fx) => fx.formatter))).toEqual(STYLE_PINNING);
	});

	it.each(pinned.filter((fx) => fx.expect !== "preserve"))(
		"$lang/$formatter supplies style evidence so a rewrite is reachable",
		(fx) => {
			const dir = path.join(repoRoot, fx.dir);
			const content = fs.readFileSync(path.join(dir, fx.file), "utf8");
			expect(
				hasDetectableIndentation(content) || hasFormatterConfig(dir),
				`${fx.dir}/${fx.file}: ${fx.formatter} refuses to format an unconfigured file with no indented line, so this fixture can only ever report "ran clean but left the mis-formatted file unchanged"`,
			).toBe(true);
		},
	);

	// #1337: the smoke matrix is the only place a formatter's REAL exit status
	// meets a real file. A `reformat` row driven by a strict formatter can no
	// longer report a green "ran clean but left the file unchanged" — a nonzero
	// exit now surfaces as a failure. Pin that each smoke row's formatter is a
	// registered one and that the strict/lenient split the smoke driver relies on
	// matches the registry, so a posture flip cannot silently change what the
	// nightly is asserting. (Full posture audit:
	// tests/clients/dispatch/formatter-exit-code-posture.test.ts.)
	it("every smoke fixture names a registered formatter", () => {
		const registered = new Set(ALL_FORMATTERS.map((f) => f.name));
		const unknown = FORMAT_FIXTURES.map((fx) => fx.formatter).filter(
			(name) => !registered.has(name),
		);
		// A fixture naming a formatter the registry does not have can never be
		// selected, so its row asserts nothing — the vacuous-fixture shape.
		expect(unknown).toEqual([]);
	});

	it("drives the strict majority of the matrix through the real spawn path", () => {
		const byName = new Map(ALL_FORMATTERS.map((f) => [f.name, f]));
		const rows = FORMAT_FIXTURES.filter((fx) => fx.expect !== "preserve");
		const strictRows = rows.filter(
			(fx) => !byName.get(fx.formatter)?.lenientExitCode,
		);
		// These are the rows where #1337's strict default actually bites: a
		// nonzero exit is now a red row instead of a green "ran clean but left the
		// file unchanged". A bare `> 0` would still pass with 32 of 33 formatters
		// flipped lenient, so assert the actual majority the title claims.
		expect(strictRows.length).toBeGreaterThan(rows.length / 2);
	});

	it("keeps every lint-autofix smoke row on the lenient side of the split", () => {
		// Derive from the registry rather than hand-listing names (#883): a
		// hardcoded ["rubocop","sqlfluff"] silently omitted ktlint and standardrb,
		// which are ALSO fixture rows and also lenient. A `continue` when a name is
		// absent would make this self-skipping — instead, assert the intersection
		// is non-empty so a fixture-set change cannot empty the guard unnoticed.
		const fixtureFormatters = new Set(
			FORMAT_FIXTURES.map((fx) => fx.formatter),
		);
		const lenientRows = ALL_FORMATTERS.filter(
			(f) => f.lenientExitCode && fixtureFormatters.has(f.name),
		);
		expect(
			lenientRows.length,
			"no lint-autofix formatter drives a smoke row — the lenient half of the split is unexercised",
		).toBeGreaterThan(0);
		for (const formatter of lenientRows) {
			expect(
				formatter.lenientExitCode,
				`${formatter.name} drives a smoke row and exits nonzero on remaining offenses`,
			).toBeTruthy();
		}
	});

	it("keeps a fixture that pins the refusal itself", () => {
		const preserve = FORMAT_FIXTURES.filter((fx) => fx.expect === "preserve");
		expect(preserve.length).toBeGreaterThan(0);
		for (const fx of preserve) {
			const dir = path.join(repoRoot, fx.dir);
			const content = fs.readFileSync(path.join(dir, fx.file), "utf8");
			expect(hasDetectableIndentation(content)).toBe(false);
			expect(hasFormatterConfig(dir)).toBe(false);
		}
	});
});
