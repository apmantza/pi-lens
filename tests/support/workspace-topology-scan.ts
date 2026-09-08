/**
 * Topology-derived cache consumer scan — #2294.
 *
 * `registerWorkspaceTopologyReset` (`clients/workspace-topology.ts`) is a
 * PUSH-ONLY registry: a module that memoizes results derived from topology
 * probe seams registers a downstream reset only by calling it. There is no
 * pull-side authority that notices a NEW consumer forgot to register. Three
 * modules wire this today (`startup-scan.ts`, `review-graph/tsconfig-paths.ts`,
 * `language-profile.ts`); the registry cannot tell whether that list is
 * complete.
 *
 * This scan is the compensating, pull-side guard. It ENUMERATES the modules
 * under `clients/` that structurally IMPORT a topology probe seam from its
 * canonical source path, then the conformance
 * test asserts each is either registered (the file calls
 * `registerWorkspaceTopologyReset(`) or carries a documented freshness-key
 * exemption. A future consumer that memoizes from a seam without registering
 * shows up as an unaccounted item, exactly like a session-state file that
 * forgets `handleSessionStart`.
 *
 * ## Population rule: IMPORT-aware binding detection
 *
 * The population is scoped to the CANONICAL SOURCE MODULES that export the
 * governed probe seams — `workspace-topology.js` for its probe exports and
 * `startup-scan.js` for `findNearestProjectRoot` — and detected by IMPORT
 * binding, not by call shape. A module is a consumer when a governed probe
 * enters its scope through any of:
 *
 * - a named import: `import { getDirectoryMarkers } from "..."`;
 * - an ALIASED named import: `import { getDirectoryMarkers as markers }` —
 *   the imported name is still the governed probe, so this belongs to the
 *   population even though the call site spells `markers(...)` (the defect a
 *   call-shaped sweep misses);
 * - a NAMESPACE import of a canonical module:
 *   `import * as topo from "workspace-topology.js"` — the namespace makes
 *   every governed probe of that module reachable as `topo.<probe>`.
 *
 * A named import of a governed probe enters the population even when the local
 * binding is never called — importing the seam is the act that can feed a
 * memo. Stateless imports that hold no derived cache are documented
 * exemptions, exactly like the call-shaped population's per-run consumers.
 *
 * Crucially, an UNRELATED same-name LOCAL function or module does NOT enter
 * the population: `function getDirectoryMarkers() {}` in a file that never
 * imports the seam is not a topology consumer, and a call-shaped detector
 * would flag it. Import-scoped binding detection is what keeps that out.
 *
 * Multiline named imports and namespace imports are supported; both a default
 * and a named binding in one statement are handled. Type-only and
 * side-effect-only imports of a canonical module carry no runtime probe
 * binding and do not enter the population.
 *
 * ## The probe-seam list (the canonical set)
 *
 * The seams that READ the shared marker/walk index and could feed a derived
 * memo. Lifecycle helpers (`resetWorkspaceTopology`,
 * `registerWorkspaceTopologyReset`, `releaseWorkspaceTopologyIdleTimers`) are
 * deliberately excluded — they are the reset/teardown mechanism, not a read
 * whose result a consumer memoizes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ts as sgTs } from "@ast-grep/napi";
import { listSourceFiles, relativePosix, stripSource } from "./sweep-kit.js";
import { repoRoot } from "./session-state-scan.js";

const CLIENTS_ROOT = path.join(repoRoot, "clients");

/** The seam module that OWNS the reset mechanism — never a consumer.
 *  It is excluded structurally so its own re-export of the governed names is
 *  not read as a consumption. */
export const TOPOLOGY_OWNER = "workspace-topology.ts";

/**
 * The canonical source modules and the governed probe seam each exports.
 *
 * A module is a topology consumer when one of these names ENTERS its scope via
 * an import from the listed source file. `findNearestProjectRoot` lives in
 * `startup-scan.ts`, NOT `workspace-topology.ts` — it is EXCLUDED from the
 * latter's export set, so a consumer importing it from workspace-topology
 * (a mistake) would not be falsely governed by the wrong module.
 */
const GOVERNED_PROBES_BY_MODULE: Readonly<Record<string, readonly string[]>> = {
	"workspace-topology.js": [
		"getDirectoryMarkers",
		"findNearestDirWithMarker",
		"findNearestDirWithAnyBasename",
		"findPiLensConfigMarkerInDir",
		"findGoverningTsconfigDir",
		"getWorkspaceManifestMarkers",
	],
	"startup-scan.js": ["findNearestProjectRoot"],
};

/** Flat union of every governed probe, for documentation and the test's
 *  canonical-list pin. */
export const TOPOLOGY_PROBE_SEAMS: readonly string[] = Object.values(
	GOVERNED_PROBES_BY_MODULE,
).flat();

/** Call-shaped needle that proves a module REGISTERED a downstream reset. */
const REGISTER_CALL = /\bregisterWorkspaceTopologyReset\(/;

/** Every `.ts` file under `dir` (default `clients/`), minus declarations. */
function topologyScanSourceFiles(dir = CLIENTS_ROOT): string[] {
	return listSourceFiles(dir, { extensions: [".ts"], skipTests: true });
}

/** `module` relative to `clients/` for message clarity in registration counts. */
function moduleRelative(dir: string, absolute: string): string {
	return relativePosix(path.resolve(dir), absolute);
}

/**
 * Resolve a local import to one of the canonical source modules.
 *
 * Matching the basename is not enough: `some-package/workspace-topology.js`
 * and `../workspace-topology.js` can share a basename while referring to
 * unrelated modules. Compare the import's resolved path with the governed
 * source path instead. The source twin candidates support the repository's
 * ESM convention (`.js` specifiers for `.ts` sources) without accepting a
 * sibling or package path that only happens to end in the same name.
 */
function canonicalModuleForSpec(
	spec: string,
	sourceFilePath: string,
	rootDir: string,
): string | undefined {
	if (!spec.startsWith(".")) return undefined;
	const resolved = path.resolve(path.dirname(sourceFilePath), spec);
	const ext = path.extname(resolved).toLowerCase();
	const sourceBase = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(ext)
		? resolved.slice(0, -ext.length)
		: resolved;
	const candidates = new Set([
		resolved,
		`${sourceBase}.ts`,
		`${sourceBase}.tsx`,
		`${sourceBase}.mts`,
		`${sourceBase}.cts`,
	]);
	for (const module of Object.keys(GOVERNED_PROBES_BY_MODULE)) {
		const canonical = path.resolve(rootDir, module.replace(/\.js$/, ".ts"));
		for (const candidate of candidates) {
			const equal =
				process.platform === "win32"
					? candidate.toLowerCase() === canonical.toLowerCase()
					: candidate === canonical;
			if (equal) return module;
		}
	}
	return undefined;
}

interface TopologyImport {
	/** The governed probe(s) that entered scope through this import. */
	probes: string[];
	/** 1-based line of the import statement. */
	line: number;
	/** True when this was a namespace import (`import * as X`). */
	namespace: boolean;
}

interface ScanGovernedImportsOptions {
	/** Absolute path of the source file containing the import declarations. */
	sourceFilePath: string;
	/** Directory containing the canonical governed source modules. */
	rootDir: string;
}

/**
 * The governed-probe imports in `source`, found from TypeScript's parsed import
 * declarations and binding nodes. Parsing is structural: comments, strings,
 * template literals, malformed textual decoys, and dead code cannot become an
 * import. The resolved module path must also be the canonical source twin.
 * Named imports use the imported name (not an alias), namespace imports of a
 * canonical module contribute that module's full probe set, and type-only
 * imports contribute nothing because they cannot feed runtime state.
 */
function scanGovernedImports(
	source: string,
	options: ScanGovernedImportsOptions,
): TopologyImport[] {
	const out: TopologyImport[] = [];
	const root = sgTs.parse(source).root();
	for (const statement of root.children()) {
		if (statement.kind() !== "import_statement") continue;
		const clause = statement
			.children()
			.find((child) => child.kind() === "import_clause");
		if (
			!clause ||
			statement.children().some((child) => child.kind() === "type")
		)
			continue;
		const module = canonicalModuleForSpec(
			(statement.field("source")?.text() ?? "").replace(/^['"]|['"]$/g, ""),
			options.sourceFilePath,
			options.rootDir,
		);
		if (!module) continue;
		const namespace = clause
			.children()
			.find((child) => child.kind() === "namespace_import");
		if (namespace) {
			out.push({
				probes: [...GOVERNED_PROBES_BY_MODULE[module]],
				line: statement.range().start.line + 1,
				namespace: true,
			});
			continue;
		}
		const named = clause
			.children()
			.find((child) => child.kind() === "named_imports");
		if (!named) continue;
		const governed = named
			.children()
			.filter((element) => element.kind() === "import_specifier")
			.filter((element) => !/^type\s+/.test(element.text().trim()))
			.map((element) => element.field("name")?.text() ?? "")
			.filter((name) =>
				(GOVERNED_PROBES_BY_MODULE[module] as readonly string[]).includes(name),
			);
		if (governed.length === 0) continue;
		out.push({
			probes: governed,
			line: statement.range().start.line + 1,
			namespace: false,
		});
	}

	return out;
}

export interface TopologyConsumer {
	/** `clients/`-relative posix path (or dir-relative when a fixture dir is passed). */
	file: string;
	/** 1-based lines of the governed imports that entered scope. */
	importLines: number[];
}

/**
 * Every module under `dir` that IMPORTED a governed topology probe, sorted by
 * file. Excludes the seam owner (`workspace-topology.ts`) structurally.
 */
export function scanTopologyConsumers(dir = CLIENTS_ROOT): TopologyConsumer[] {
	const out: TopologyConsumer[] = [];
	for (const absolute of topologyScanSourceFiles(dir)) {
		const rel = moduleRelative(dir, absolute);
		if (rel === TOPOLOGY_OWNER) continue;
		const imports = scanGovernedImports(fs.readFileSync(absolute, "utf8"), {
			sourceFilePath: absolute,
			rootDir: dir,
		});
		if (imports.length === 0) continue;
		out.push({
			file: rel,
			importLines: imports.map((i) => i.line).sort((a, b) => a - b),
		});
	}
	return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * The registered consumer set, DERIVED from source rather than a copied list —
 * a module is registered only when its OWN source calls
 * `registerWorkspaceTopologyReset(`. This is the anti-drift half: a module
 * that imports the register but never calls it is not registered. Registration
 * is deliberately CALL-shaped and source-scoped (it is the one act that PROVES
 * a downstream clear was wired), so the import detection above does not apply.
 */
export function registeredTopologyConsumers(dir = CLIENTS_ROOT): Set<string> {
	const registered = new Set<string>();
	for (const absolute of topologyScanSourceFiles(dir)) {
		const rel = moduleRelative(dir, absolute);
		if (rel === TOPOLOGY_OWNER) continue;
		const blankSource = stripSource(fs.readFileSync(absolute, "utf8"), {
			strings: "blank",
		});
		if (REGISTER_CALL.test(blankSource)) registered.add(rel);
	}
	return registered;
}
