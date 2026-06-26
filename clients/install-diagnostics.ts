/**
 * Install/runtime diagnostics — a paste-able environment fingerprint for bug
 * reports about extension load failures (#285/#335: `ResolveMessage: Cannot
 * find package …`).
 *
 * This module is deliberately self-contained and dependency-free: it only
 * RESOLVES specifiers (never imports them), reads package.json, and stats files.
 * So it loads and reports correctly even when the very deps that failed (e.g.
 * `typescript`) are unreachable — which is exactly when we need it. Every probe
 * is best-effort and never throws.
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ISSUES_URL = "https://github.com/apmantza/pi-lens/issues";

/** Runtime third-party deps whose resolution is the documented failure surface. */
const CRITICAL_DEPS = [
	"typescript",
	"minimatch",
	"typebox",
	"js-yaml",
	"vscode-jsonrpc",
	"web-tree-sitter",
	"@ast-grep/napi",
];

export interface DepStatus {
	name: string;
	resolved: boolean;
	resolvedPath?: string;
	error?: string;
}

export interface InstallDiagnostics {
	piLensVersion: string;
	runtime: string; // e.g. "node 22.23.1" or "bun 1.3.14 (on node shim)"
	platform: string; // `${os}-${arch}`
	packageManager: "npm-hoisted" | "pnpm-symlinked" | "nested" | "unknown";
	pkgDir: string;
	pkgRealDir: string;
	behindSymlink: boolean;
	deps: DepStatus[];
	astGrepCli: boolean;
	grammars: boolean;
	notes: string[];
}

function safe<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

/** Gather the environment fingerprint. Never throws. */
export function collectInstallDiagnostics(): InstallDiagnostics {
	const notes: string[] = [];
	const here = safe(() => path.dirname(fileURLToPath(import.meta.url)), "");
	const pkgDir = safe(() => path.resolve(here, ".."), here); // dist/clients -> dist; good enough as anchor
	// Walk up to the real package root (dir holding our package.json).
	let root = pkgDir;
	for (let i = 0; i < 6; i++) {
		if (safe(() => fs.existsSync(path.join(root, "package.json")), false)) break;
		const up = path.dirname(root);
		if (up === root) break;
		root = up;
	}

	const piLensVersion = safe(() => {
		const pj = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
		return String(pj.version ?? "unknown");
	}, "unknown");

	const bunVersion = (globalThis as { Bun?: { version?: string } }).Bun?.version;
	const runtime = bunVersion
		? `bun ${bunVersion}`
		: `node ${process.versions.node}`;
	const platform = `${process.platform}-${process.arch}`;

	const pkgRealDir = safe(() => fs.realpathSync(root), root);
	const behindSymlink = pkgRealDir !== root;
	let packageManager: InstallDiagnostics["packageManager"] = "unknown";
	if (pkgRealDir.includes(`${path.sep}.pnpm${path.sep}`) || behindSymlink) {
		packageManager = "pnpm-symlinked";
	} else if (safe(() => fs.existsSync(path.join(root, "node_modules", "typescript")), false)) {
		packageManager = "nested";
	} else {
		packageManager = "npm-hoisted";
	}

	const deps: DepStatus[] = CRITICAL_DEPS.map((name) => {
		try {
			return { name, resolved: true, resolvedPath: require.resolve(name) };
		} catch (err) {
			return {
				name,
				resolved: false,
				error: `${(err as { code?: string })?.code ?? ""} ${
					(err as Error)?.message ?? String(err)
				}`.trim(),
			};
		}
	});

	const astGrepCli = safe(() => {
		const cliPkg = require.resolve("@ast-grep/cli/package.json");
		const dir = path.dirname(cliPkg);
		return ["ast-grep", "ast-grep.exe", "sg", "sg.exe"].some((b) =>
			fs.existsSync(path.join(dir, b)),
		);
	}, false);

	const grammars = safe(() => {
		let dir = path.dirname(require.resolve("web-tree-sitter"));
		while (path.basename(dir) !== "web-tree-sitter" && dir !== path.dirname(dir)) {
			dir = path.dirname(dir);
		}
		return fs.existsSync(path.join(dir, "grammars", "tree-sitter-typescript.wasm"));
	}, false);

	if (deps.some((d) => !d.resolved)) {
		notes.push(
			"One or more runtime dependencies did not resolve. This is the #285/#335 failure mode — usually a package-manager layout (pnpm symlink store / nested install) the runtime's resolver can't traverse, or an outdated runtime.",
		);
	}
	if (!astGrepCli || !grammars) {
		notes.push(
			"ast-grep CLI and/or tree-sitter grammars are missing — pnpm/bun skip lifecycle scripts by default, so the postinstall that fetches them did not run.",
		);
	}

	return {
		piLensVersion,
		runtime,
		platform,
		packageManager,
		pkgDir: root,
		pkgRealDir,
		behindSymlink,
		deps,
		astGrepCli,
		grammars,
		notes,
	};
}

/** Render a compact, paste-able diagnostic block for a bug report. */
export function formatInstallDiagnostics(
	diag: InstallDiagnostics = collectInstallDiagnostics(),
	cause?: unknown,
): string {
	const lines: string[] = [];
	lines.push("──────── pi-lens install diagnostics ────────");
	if (cause) {
		const msg = (cause as Error)?.message ?? String(cause);
		lines.push(`LOAD ERROR: ${msg}`);
	}
	lines.push(`pi-lens:   ${diag.piLensVersion}`);
	lines.push(`runtime:   ${diag.runtime}`);
	lines.push(`platform:  ${diag.platform}`);
	lines.push(`install:   ${diag.packageManager}${diag.behindSymlink ? " (behind symlink)" : ""}`);
	lines.push(`pkg dir:   ${diag.pkgDir}`);
	if (diag.behindSymlink) lines.push(`real dir:  ${diag.pkgRealDir}`);
	lines.push("deps:");
	for (const d of diag.deps) {
		lines.push(`  ${d.resolved ? "ok  " : "FAIL"} ${d.name}${d.error ? ` — ${d.error}` : ""}`);
	}
	lines.push(`assets:    ast-grep-cli=${diag.astGrepCli ? "ok" : "MISSING"} grammars=${diag.grammars ? "ok" : "MISSING"}`);
	for (const n of diag.notes) lines.push(`note: ${n}`);
	lines.push(`Please paste this into a report at ${ISSUES_URL}`);
	lines.push("─────────────────────────────────────────────");
	return lines.join("\n");
}
