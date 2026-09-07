#!/usr/bin/env node
// scripts/warm-loader-cache.mjs (#1926)
//
// Pay pi's jiti transform of dist/index.js at install time, so no interactive
// session pays it.
//
// pi loads an extension with jiti, which Babel-transforms the entry and caches
// the result under <tmpdir>/jiti. pi-lens's entry is a ~4MB esbuild bundle, so
// the transform is the dominant startup cost exactly once per build: the first
// session after a `git:` install or update measured 4847ms of `module import`,
// against 138ms once the cache is warm. `prepare` has just built that bundle,
// so this script transforms it through the same jiti and writes the same cache
// entry pi will read.
//
// See scripts/lib/warm-loader-cache.mjs for why the entry this writes is the
// entry pi reads — the cache key, the transform-version marker that makes a
// mismatch a miss instead of a corruption, and the measurement that proved the
// output byte-identical to pi's own.
//
// POSTURE: best-effort, last in the chain, always exit 0. `prepare` also runs
// `build:dist` and `download-grammars`, which consumers depend on and which
// MUST fail loudly. A cache warm is an optimisation and must never share their
// failure path — the same split `scripts/setup-git-hooks.mjs` makes (#1804).
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOST_PROVIDED_PACKAGES } from "./lib/host-provided-deps.mjs";
import {
	appendBounded,
	buildStubAliases,
	expectedCacheFileName,
	resolveJitiCacheDir,
	verifyCacheEntry,
	warmSkipReason,
} from "./lib/warm-loader-cache.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function log(message) {
	process.stderr.write(`[warm-loader-cache] ${message}\n`);
}

/**
 * Append one JSONL record to PI_LENS_INSTALL_LOG, or install.log under
 * PI_LENS_HOME (falling back to ~/.pi-lens when neither is set).
 *
 * pi's install output scrolls away, so without this there is no record that the
 * warm ran, was skipped, or failed. One bounded line per install keeps the
 * question answerable after the fact. `PI_LENS_INSTALL_LOG` redirects the file,
 * which is how the tests read the record back.
 */
function record(entry) {
	try {
		const override = process.env.PI_LENS_INSTALL_LOG;
		const home = process.env.PI_LENS_HOME?.trim();
		const file =
			typeof override === "string" && override.length > 0
				? override
				: path.join(home || path.join(os.homedir(), ".pi-lens"), "install.log");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const existing = fs.existsSync(file)
			? fs.readFileSync(file, "utf8").split("\n")
			: [];
		const line = JSON.stringify({
			ts: new Date().toISOString(),
			event: "warm_loader_cache",
			...entry,
		});
		fs.writeFileSync(file, `${appendBounded(existing, line).join("\n")}\n`);
	} catch {
		// The log is diagnostic. Losing it must not change the install outcome.
	}
}

/** Entries pi will load, read from the manifest rather than hardcoded. */
function extensionEntries() {
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(root, "package.json"), "utf8"),
		);
		return (pkg.pi?.extensions ?? []).map((entry) => path.resolve(root, entry));
	} catch {
		return [];
	}
}

async function loadCreateJiti() {
	// `jiti/static` is the subpath pi's loader imports, and it is export-mapped
	// for `import` only — `require.resolve` reports it as not exported. Resolve
	// it the ESM way, and fall back to the package root for older runtimes.
	for (const specifier of ["jiti/static", "jiti"]) {
		try {
			const url = import.meta.resolve
				? import.meta.resolve(specifier)
				: pathToFileURL(require.resolve(specifier)).href;
			const mod = await import(url);
			if (typeof mod.createJiti === "function") return mod.createJiti;
		} catch {
			// Try the next specifier; absence is a skip, not a failure.
		}
	}
	return undefined;
}

/**
 * The installed jiti's version, so a host jiti bump — which changes the marker
 * and silently turns every warm into a cold session — is diagnosable from the
 * record rather than from a bisect.
 */
function jitiVersion() {
	try {
		const url = import.meta.resolve
			? import.meta.resolve("jiti/package.json")
			: pathToFileURL(require.resolve("jiti/package.json")).href;
		return JSON.parse(fs.readFileSync(fileURLToPath(url), "utf8")).version;
	} catch {
		return null;
	}
}

/** Real-filesystem probes for `verifyCacheEntry`. */
const fsDeps = {
	existsSync: (p) => fs.existsSync(p),
	readFileSync: (p) => fs.readFileSync(p, "utf8"),
	isWritable: (p) => {
		try {
			fs.accessSync(p, fs.constants.W_OK);
			return true;
		} catch {
			return false;
		}
	},
};

export async function main() {
	const entries = extensionEntries();
	const createJiti = await loadCreateJiti();
	const skip = warmSkipReason({
		env: process.env,
		distEntryExists:
			entries.length > 0 && entries.every((e) => fs.existsSync(e)),
		jitiResolvable: typeof createJiti === "function",
	});
	if (skip) {
		log(`skipped: ${skip}`);
		record({ status: "skipped", reason: skip });
		return;
	}

	const cacheDir = resolveJitiCacheDir({
		tmpdir: os.tmpdir,
		env: process.env,
		cwd: process.cwd,
		join: path.join,
	});
	const alias = buildStubAliases(HOST_PROVIDED_PACKAGES);
	const version = jitiVersion();

	for (const entry of entries) {
		const started = Date.now();
		const cacheFile = expectedCacheFileName(entry);
		const jiti = createJiti(pathToFileURL(entry).href, {
			// Mirror pi's loader: no in-process module cache, aliases present.
			// Neither affects the transform or the cache key, but staying close to
			// pi's call keeps the two easy to compare.
			moduleCache: false,
			fsCache: cacheDir,
			alias,
		});
		try {
			// jiti writes the cache entry BEFORE it evaluates the module, so the
			// warm is complete even though evaluation then fails on the first
			// host-provided import — those only resolve inside pi.
			await jiti.import(entry, { default: true });
		} catch {
			// Expected. Evaluation is not the goal; the transform is.
		}
		const ms = Date.now() - started;
		const relative = path.relative(root, entry);

		// The import returning proves nothing. Several exit-0 paths leave no usable
		// entry — an unwritable cache directory, an import that never reached the
		// transform, a stale file that fails jiti's marker check — so read the file
		// back before claiming anything was cached.
		const verdict = verifyCacheEntry({
			cacheDir,
			fileName: cacheFile,
			source: fs.readFileSync(entry, "utf8"),
			fsDeps,
		});
		const common = {
			entry: relative,
			ms,
			cacheDir,
			cacheFile,
			jitiVersion: version,
		};
		if (verdict.ok) {
			log(`warmed ${relative} in ${ms}ms (cache: ${cacheDir}/${cacheFile})`);
			record({
				status: "warmed",
				...common,
				transformVersion: verdict.transformVersion,
			});
			continue;
		}
		log(`not cached: ${relative} after ${ms}ms — ${verdict.reason}`);
		record({ status: "not_cached", ...common, reason: verdict.reason });
	}
}

/**
 * Run `work`, absorbing any failure. Exported so a test can inject a throwing
 * body and assert the process still exits 0 and still leaves a record.
 */
export async function run(work = main) {
	try {
		await work();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log(`failed: ${message}`);
		record({ status: "failed", reason: message });
	}
}

const invokedPath = process.argv[1];
const invokedDirectly =
	typeof invokedPath === "string" &&
	pathToFileURL(path.resolve(invokedPath)).href === import.meta.url;
if (invokedDirectly) {
	await run();
}
