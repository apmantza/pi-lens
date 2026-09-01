/**
 * Unconfigured template-bearing HTML/YAML must select NO formatter (#2384).
 *
 * `FORMATTER_POLICY_BY_EXTENSION` previously set `defaultWhenUnconfigured:
 * true` for `.html`/`.htm`/`.yaml`/`.yml`, so the deferred formatter drain ran
 * real Prettier over files whose content carries template markers. Prettier
 * reinterprets them as code: an HTML `<script>{{JS}}</script>` runtime embed
 * became nested JavaScript blocks (the #2384 report), and a Helm
 * `apiVersion: {{ .Values.apiVersion }}` became
 * `apiVersion: { { .Values.apiVersion } }`. Both break the runtime that
 * replaces the marker. Users opt in via project `.prettierrc`, which the
 * explicit-config branch still honours.
 *
 * The policy-level regression lives in `formatters.test.ts` and
 * `tool-policy.test.ts` and runs everywhere. This file adds the disk-level
 * proof: it drives the production selection seam and `formatFile` against the
 * REAL Prettier binary, so a reverted policy flag corrupts a real file on real
 * disk instead of merely changing a selection array.
 *
 * Prettier is an optional runtime tool, NOT a devDependency of this
 * repository, so the binary is discovered (test-only `PI_LENS_TEST_PRETTIER_BIN`
 * override, then the repo-local install, then the real home's managed tools
 * tree — a read-only path probe) and the whole suite skips, visibly, where no
 * real binary exists. A binary that exists but cannot run reds the positive
 * control below instead of passing silently.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearFormatterRuntimeState,
	formatFile,
	getFormattersForFile,
	prettierFormatter,
} from "../../clients/formatters.js";
import { setupTestEnvironment } from "./test-utils.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * Locate a real Prettier entry script (prettier 3.x ships `bin/prettier.cjs`),
 * mirroring the installer's own read-only discovery order: repo-local first,
 * then the managed tools tree under the real home. PI_LENS_HOME is hermetic
 * under vitest, so the managed probe reads the real home directly — it never
 * writes there.
 */
function findRealPrettierEntry(): string | undefined {
	const override = process.env.PI_LENS_TEST_PRETTIER_BIN;
	if (override) {
		if (fs.existsSync(override)) return override;
		throw new Error(
			`PI_LENS_TEST_PRETTIER_BIN is set but does not exist: ${override}`,
		);
	}
	const candidates = [
		path.join(REPO_ROOT, "node_modules", "prettier", "bin", "prettier.cjs"),
		path.join(
			os.homedir(),
			".pi-lens",
			"tools",
			"node_modules",
			"prettier",
			"bin",
			"prettier.cjs",
		),
	];
	return candidates.find((candidate) => fs.existsSync(candidate));
}

const PRETTIER_ENTRY = findRealPrettierEntry();

/**
 * The #448 pattern: a describe.skip on a missing optional binary silently
 * vanishes this whole suite, so say why that is acceptable here — the
 * binary-free policy regressions in formatters.test.ts and tool-policy.test.ts
 * run on every machine; this file adds the real-process, real-disk proof where
 * a real Prettier exists.
 */
const d = PRETTIER_ENTRY ? describe : describe.skip;

/**
 * Plant a node_modules/.bin/prettier in the temp project that re-execs the
 * real binary. `findInNodeModules` walks up from the file's directory, so this
 * is what makes `resolveCommand` pick the local branch deterministically
 * instead of depending on whatever `prettier` happens to be on PATH.
 */
function plantLocalPrettier(projectDir: string): void {
	if (!PRETTIER_ENTRY) throw new Error("real prettier entry not found");
	const binDir = path.join(projectDir, "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(
		path.join(binDir, "prettier"),
		`#!/bin/sh\nexec node ${JSON.stringify(PRETTIER_ENTRY)} "$@"\n`,
		{ mode: 0o755 },
	);
	// findInNodeModules prefers the .cmd on win32.
	fs.writeFileSync(
		path.join(binDir, "prettier.cmd"),
		`@ECHO off\r\nnode "${PRETTIER_ENTRY}" %*\r\n`,
	);
}

/** Multiline, indented content: one-line files legitimately hit
 * SKIP_FORMATTING (#1144 style-preserving refusal) and would prove nothing. */
const TEMPLATE_HTML = [
	"<!doctype html>",
	"<html>",
	"  <body>",
	"    <script>",
	"      {{JS}}",
	"    </script>",
	"    <p>hello</p>",
	"  </body>",
	"</html>",
	"",
].join("\n");

const TEMPLATE_YAML = [
	"apiVersion: apps/v1",
	"kind: Deployment",
	"metadata:",
	"  name: demo",
	"  annotations:",
	"    checksum/config: {{ .Values.apiVersion }}",
	"spec:",
	"  replicas: {{ .Values.replicas }}",
	"",
].join("\n");

const MESSY_HTML = [
	"<html>",
	"  <head><title>x</title></head>",
	"  <body><p>hi</p><p>there</p></body>",
	"</html>",
	"",
].join("\n");

function runRealPrettierOn(target: string, projectDir: string): string {
	if (!PRETTIER_ENTRY) throw new Error("real prettier entry not found");
	execFileSync(process.execPath, [PRETTIER_ENTRY, "--write", target], {
		cwd: projectDir,
		encoding: "utf-8",
	});
	return fs.readFileSync(target, "utf-8");
}

d("unconfigured template files survive the formatter drain (#2384)", () => {
	let env: { tmpDir: string; cleanup: () => void } | undefined;

	afterEach(() => {
		clearFormatterRuntimeState();
		env?.cleanup();
	});

	// Documents the hazard this policy exists for, against the real tool (same
	// posture as the oxfmt contract test): a future Prettier that preserves
	// template markers reds here and the policy rationale gets revisited.
	it("real prettier reinterprets HTML and YAML template markers", () => {
		const project = setupTestEnvironment("pi-lens-2384-hazard-");
		env = project;
		const html = path.join(project.tmpDir, "page.html");
		const yaml = path.join(project.tmpDir, "template.yaml");
		fs.writeFileSync(html, TEMPLATE_HTML);
		fs.writeFileSync(yaml, TEMPLATE_YAML);

		const formattedHtml = runRealPrettierOn(html, project.tmpDir);
		expect(formattedHtml).not.toContain("{{JS}}");

		const formattedYaml = runRealPrettierOn(yaml, project.tmpDir);
		expect(formattedYaml).not.toContain("{{ .Values.apiVersion }}");
		expect(formattedYaml).not.toContain("{{ .Values.replicas }}");
	});

	// Positive control: with explicit config the production seam really selects
	// prettier, the planted shim resolves the REAL binary, and formatFile
	// rewrites the file. Without this, the regression below could pass because
	// the binary never resolves rather than because the policy holds.
	it("explicit prettier config still reformats an HTML file", async () => {
		env = setupTestEnvironment("pi-lens-2384-optin-");
		fs.writeFileSync(path.join(env.tmpDir, ".prettierrc"), "{}\n");
		plantLocalPrettier(env.tmpDir);
		const target = path.join(env.tmpDir, "messy.html");
		fs.writeFileSync(target, MESSY_HTML);

		const formatters = await getFormattersForFile(target, env.tmpDir);
		expect(formatters.map((f) => f.name)).toEqual(["prettier"]);

		const result = await formatFile(target, prettierFormatter);
		expect(result.error).toBeUndefined();
		expect(result.success).toBe(true);
		expect(result.changed).toBe(true);
		expect(fs.readFileSync(target, "utf-8")).not.toBe(MESSY_HTML);
	});

	// THE RED-PROOF. With any of the four flags reverted, selection returns
	// prettier, formatFile launches the REAL binary, and the file on disk is
	// corrupted — the selection assert and the byte-identical assert both red.
	it("selection is empty and template bytes are untouched for unconfigured html", async () => {
		env = setupTestEnvironment("pi-lens-2384-html-");
		plantLocalPrettier(env.tmpDir);
		const target = path.join(env.tmpDir, "page.html");
		fs.writeFileSync(target, TEMPLATE_HTML);
		const before = fs.readFileSync(target, "utf-8");

		const formatters = await getFormattersForFile(target, env.tmpDir);
		expect(formatters.map((f) => f.name)).toEqual([]);

		for (const formatter of formatters) {
			await formatFile(target, formatter);
		}
		expect(fs.readFileSync(target, "utf-8")).toBe(before);
	});

	it("selection is empty and template bytes are untouched for unconfigured yaml", async () => {
		env = setupTestEnvironment("pi-lens-2384-yaml-");
		plantLocalPrettier(env.tmpDir);
		const target = path.join(env.tmpDir, "template.yaml");
		fs.writeFileSync(target, TEMPLATE_YAML);
		const before = fs.readFileSync(target, "utf-8");

		const formatters = await getFormattersForFile(target, env.tmpDir);
		expect(formatters.map((f) => f.name)).toEqual([]);

		for (const formatter of formatters) {
			await formatFile(target, formatter);
		}
		expect(fs.readFileSync(target, "utf-8")).toBe(before);
	});
});
