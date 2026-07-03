/**
 * Regression test for scripts/download-grammars.js — stdout must stay CLEAN.
 *
 * The script runs inside the `prepare` lifecycle, so it executes during
 * `npm pack --silent`, whose stdout is captured as the tarball filename by
 * install-smoke's `smoke` job. If the script logs progress to stdout (as it did
 * before this fix — #376's break), that chatter is captured alongside the
 * filename and the multi-line value blows up `>> $GITHUB_ENV` ("Invalid
 * format"), turning the whole smoke matrix red. Progress therefore goes to
 * stderr; stdout must emit nothing.
 *
 * Runs the real built script against a pre-populated dest so every grammar hits
 * the no-network "skip" path — deterministic and offline.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../scripts/download-grammars.js",
);

// Mirrors the CORE list in scripts/download-grammars.ts. Pre-creating these
// forces every entry down the offline "skip (already exists)" branch, so the
// test never touches the network.
const CORE_FILES = [
	"tree-sitter-typescript.wasm",
	"tree-sitter-tsx.wasm",
	"tree-sitter-javascript.wasm",
	"tree-sitter-python.wasm",
	"tree-sitter-go.wasm",
	"tree-sitter-rust.wasm",
	"tree-sitter-json.wasm",
	"tree-sitter-yaml.wasm",
	"tree-sitter-bash.wasm",
	"tree-sitter-html.wasm",
	"tree-sitter-css.wasm",
	"tree-sitter-java.wasm",
];

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("download-grammars stdout hygiene (#376)", () => {
	it("writes nothing to stdout when bundling core grammars (all skipped)", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-grammars-"));
		dirs.push(base);
		const dest = path.join(base, "grammars");
		fs.mkdirSync(dest, { recursive: true });
		// Pre-create every core grammar so the script skips (no network fetch).
		for (const f of CORE_FILES) fs.writeFileSync(path.join(dest, f), "");

		// dest is resolved relative to cwd (join(process.cwd(), args.dest)), so
		// run with cwd=base and --dest grammars.
		const res = spawnSync(
			process.execPath,
			[SCRIPT, "--core", "--dest", "grammars"],
			{ cwd: base, encoding: "utf8" },
		);

		expect(res.status).toBe(0);
		// The invariant: stdout is empty so `npm pack --silent` captures only the
		// tarball name. All progress ("skip …", "Downloading …") must be stderr.
		expect(res.stdout).toBe("");
		expect(res.stderr).toContain("skip");
	});
});
