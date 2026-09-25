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
// The shared web-tree-sitter ladder imports nothing but node:fs/node:path, so
// importing it keeps this module's "loads even when the deps that failed are
// unreachable" property intact.
import { resolveWebTreeSitterPackageDir } from "../scripts/lib/web-tree-sitter-dir.mjs";

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

interface DepStatus {
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

/** The resolver-ladder inputs of {@link grammarsInstalled}. */
export interface GrammarProbeDeps {
	resolve: (specifier: string) => string;
	packageRoot: () => string;
	cwd: () => string;
}

/**
 * Whether web-tree-sitter's core grammars are installed.
 *
 * #3409 (sweep sibling of the same shape): this probe used to walk up from
 * the BARE `web-tree-sitter` specifier, so on the host pi ships — a `bun
 * build --compile` binary, where a bare specifier throws MODULE_NOT_FOUND —
 * it reported `grammars: false` for an install whose grammars were present.
 * The one report a user pastes when the long tail of grammars is dead has to
 * measure the same directory the client does, through the same ladder.
 *
 * #3424: the ladder's inputs are injected so the compiled-host, populated and
 * empty cases are testable in every lane; the authoritative Unit tests lane's
 * own `node_modules/web-tree-sitter/grammars` is empty, so the live probe
 * cannot be pinned there.
 */
export function grammarsInstalled(deps: GrammarProbeDeps): boolean {
	const dir = resolveWebTreeSitterPackageDir(deps);
	return (
		!!dir &&
		fs.existsSync(path.join(dir, "grammars", "tree-sitter-typescript.wasm"))
	);
}

/**
 * The explanatory notes for a diagnostic block. #3424: an unresolved runtime
 * dependency names the compiled-host cause alongside the layout ones — on a
 * `bun build --compile` host (how pi ships) a bare specifier cannot resolve
 * whatever the package manager did, so a note naming only pnpm/nested layouts
 * sent that user to inspect the wrong thing (#3409's root cause).
 */
export function installDiagnosticNotes(input: {
	depsUnresolved: boolean;
	astGrepCli: boolean;
	grammars: boolean;
}): string[] {
	const notes: string[] = [];
	if (input.depsUnresolved) {
		notes.push(
			"One or more runtime dependencies did not resolve. This is the #285/#335 failure mode — a package-manager layout (pnpm symlink store / nested install) the runtime's resolver can't traverse, an outdated runtime, or a runtime compiled into a single binary (`bun build --compile`, the way pi ships), where a bare package specifier cannot resolve whatever the layout is (#3409).",
		);
	}
	if (!input.astGrepCli || !input.grammars) {
		notes.push(
			"ast-grep CLI and/or tree-sitter grammars are missing — pnpm/bun skip lifecycle scripts by default, so the postinstall that fetches them did not run.",
		);
	}
	return notes;
}

/** Gather the environment fingerprint. Never throws. */
export function collectInstallDiagnostics(): InstallDiagnostics {
	const notes: string[] = [];
	const here = safe(() => path.dirname(fileURLToPath(import.meta.url)), "");
	const pkgDir = safe(() => path.resolve(here, ".."), here); // dist/clients -> dist; good enough as anchor
	// Walk up to the real package root (dir holding our package.json).
	let root = pkgDir;
	for (let i = 0; i < 6; i++) {
		if (safe(() => fs.existsSync(path.join(root, "package.json")), false))
			break;
		const up = path.dirname(root);
		if (up === root) break;
		root = up;
	}

	const piLensVersion = safe(() => {
		const pj = JSON.parse(
			fs.readFileSync(path.join(root, "package.json"), "utf8"),
		);
		return String(pj.version ?? "unknown");
	}, "unknown");

	const bunVersion = (globalThis as { Bun?: { version?: string } }).Bun
		?.version;
	const runtime = bunVersion
		? `bun ${bunVersion}`
		: `node ${process.versions.node}`;
	const platform = `${process.platform}-${process.arch}`;

	const pkgRealDir = safe(() => fs.realpathSync(root), root);
	const behindSymlink = pkgRealDir !== root;
	let packageManager: InstallDiagnostics["packageManager"] = "unknown";
	if (pkgRealDir.includes(`${path.sep}.pnpm${path.sep}`) || behindSymlink) {
		packageManager = "pnpm-symlinked";
	} else if (
		safe(
			() => fs.existsSync(path.join(root, "node_modules", "typescript")),
			false,
		)
	) {
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

	const grammars = safe(
		() =>
			grammarsInstalled({
				resolve: (specifier) => require.resolve(specifier),
				// `root` is this probe's own walk to the package root, computed above.
				packageRoot: () => root,
				cwd: () => process.cwd(),
			}),
		false,
	);

	notes.push(
		...installDiagnosticNotes({
			depsUnresolved: deps.some((d) => !d.resolved),
			astGrepCli,
			grammars,
		}),
	);

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
	lines.push(
		`install:   ${diag.packageManager}${diag.behindSymlink ? " (behind symlink)" : ""}`,
	);
	lines.push(`pkg dir:   ${diag.pkgDir}`);
	if (diag.behindSymlink) lines.push(`real dir:  ${diag.pkgRealDir}`);
	lines.push("deps:");
	for (const d of diag.deps) {
		lines.push(
			`  ${d.resolved ? "ok  " : "FAIL"} ${d.name}${d.error ? ` — ${d.error}` : ""}`,
		);
	}
	lines.push(
		`assets:    ast-grep-cli=${diag.astGrepCli ? "ok" : "MISSING"} grammars=${diag.grammars ? "ok" : "MISSING"}`,
	);
	for (const n of diag.notes) lines.push(`note: ${n}`);
	lines.push(`Please paste this into a report at ${ISSUES_URL}`);
	lines.push("─────────────────────────────────────────────");
	return lines.join("\n");
}
