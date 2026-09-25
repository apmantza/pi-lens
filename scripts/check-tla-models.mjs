#!/usr/bin/env node
/**
 * Model-check every TLA+ config under formal/ and compare TLC's verdict with
 * the one the config expects (#3447).
 *
 * Each `.cfg` starts with two header lines:
 *
 *   \* expect: pass                        (or: violated <InvariantName>)
 *   \* module: FileLock                    (the .tla beside it)
 *
 * A config that documents a known bug expects the violation, so the check is
 * a ratchet both ways: a model edit that hides the bug reds, and a fix that
 * makes the invariant hold reds until its config says `pass`.
 *
 * Usage: node scripts/check-tla-models.mjs [--jar <tla2tools.jar>]
 * Without --jar, the pinned release is downloaded to .cache/ and verified.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TLA_TOOLS = Object.freeze({
	release: "v1.7.4",
	url: "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
	sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
});

const EXPECT_LINE = /^\\\*\s*expect:\s*(.+?)\s*$/m;
const MODULE_LINE = /^\\\*\s*module:\s*([A-Za-z_]\w*)\s*$/m;

/**
 * Read a config's expected verdict and module. Returns `{ error }` for a
 * missing or malformed header, so the check can name the file.
 */
export function parseModelHeader(text) {
	const expectMatch = EXPECT_LINE.exec(text);
	const moduleMatch = MODULE_LINE.exec(text);
	if (!expectMatch) return { error: "missing `\\* expect:` header" };
	if (!moduleMatch) return { error: "missing `\\* module:` header" };
	const value = expectMatch[1];
	if (value === "pass")
		return { module: moduleMatch[1], expect: { status: "pass" } };
	const violated = /^violated\s+([A-Za-z_]\w*)$/.exec(value);
	if (violated)
		return {
			module: moduleMatch[1],
			expect: { status: "violated", invariant: violated[1] },
		};
	return { error: `unrecognised expectation "${value}"` };
}

/** TLC's verdict from its combined output. */
export function classifyTlcOutput(output) {
	const violated = /Error: Invariant (\w+) is violated/.exec(output);
	if (violated) return { status: "violated", invariant: violated[1] };
	if (/Model checking completed\. No error has been found\./.test(output))
		return { status: "pass" };
	const errorLine = output
		.split("\n")
		.find((line) => /Error|Exception/.test(line));
	return { status: "error", detail: errorLine?.trim() ?? "no verdict" };
}

export function verdictMatches(expected, actual) {
	if (expected.status !== actual.status) return false;
	return (
		expected.status !== "violated" || expected.invariant === actual.invariant
	);
}

export function describeVerdict(verdict) {
	if (verdict.status === "violated") return `violated ${verdict.invariant}`;
	if (verdict.status === "error") return `error: ${verdict.detail}`;
	return "pass";
}

/** Every `formal/<dir>/*.cfg`, sorted. */
export function listModelConfigs(root) {
	const formal = path.join(root, "formal");
	if (!fs.existsSync(formal)) return [];
	const configs = [];
	for (const dir of fs.readdirSync(formal, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const abs = path.join(formal, dir.name);
		for (const file of fs.readdirSync(abs)) {
			if (file.endsWith(".cfg")) configs.push(path.join(abs, file));
		}
	}
	return configs.sort();
}

function sha256(file) {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function ensureJar(jarArg, root) {
	const jar = jarArg ?? path.join(root, ".cache", "tla2tools.jar");
	if (!fs.existsSync(jar)) {
		if (jarArg) throw new Error(`--jar ${jarArg} does not exist`);
		fs.mkdirSync(path.dirname(jar), { recursive: true });
		const response = await fetch(TLA_TOOLS.url);
		if (!response.ok)
			throw new Error(`download ${TLA_TOOLS.url}: HTTP ${response.status}`);
		fs.writeFileSync(jar, Buffer.from(await response.arrayBuffer()));
	}
	const actual = sha256(jar);
	if (actual !== TLA_TOOLS.sha256)
		throw new Error(
			`${jar}: sha256 ${actual}, expected ${TLA_TOOLS.sha256} (${TLA_TOOLS.release})`,
		);
	return jar;
}

function runTlc(jar, config, module) {
	const metadir = fs.mkdtempSync(path.join(os.tmpdir(), "tlc-"));
	try {
		const result = spawnSync(
			"java",
			[
				"-XX:+UseParallelGC",
				"-cp",
				jar,
				"tlc2.TLC",
				"-workers",
				"auto",
				"-metadir",
				metadir,
				"-config",
				path.basename(config),
				module,
			],
			{ cwd: path.dirname(config), encoding: "utf8", maxBuffer: 64 << 20 },
		);
		if (result.error) return { status: "error", detail: result.error.message };
		return classifyTlcOutput(`${result.stdout}\n${result.stderr}`);
	} finally {
		fs.rmSync(metadir, { recursive: true, force: true });
	}
}

async function main() {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const jarIndex = process.argv.indexOf("--jar");
	const jar = await ensureJar(
		jarIndex === -1 ? undefined : process.argv[jarIndex + 1],
		root,
	);
	const configs = listModelConfigs(root);
	if (configs.length === 0) throw new Error("no formal/*/*.cfg found");
	let failures = 0;
	for (const config of configs) {
		const name = path.relative(root, config);
		const header = parseModelHeader(fs.readFileSync(config, "utf8"));
		if (header.error) {
			failures += 1;
			console.log(`FAIL ${name}: ${header.error}`);
			continue;
		}
		const started = Date.now();
		const actual = runTlc(jar, config, header.module);
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		const ok = verdictMatches(header.expect, actual);
		if (!ok) failures += 1;
		console.log(
			`${ok ? "ok  " : "FAIL"} ${name}: expected ${describeVerdict(header.expect)}, got ${describeVerdict(actual)} (${seconds}s)`,
		);
	}
	if (failures > 0) {
		console.log(`${failures} of ${configs.length} models did not match.`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
