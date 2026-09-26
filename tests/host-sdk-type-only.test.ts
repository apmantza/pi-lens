import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * #1334 S6 — `@earendil-works/pi-coding-agent` is an OPTIONAL PEER + devDep,
 * never a runtime dependency. pi installs extensions with
 * `npm install --omit=dev` (peers omitted), so any *value* import of the host
 * SDK fails to resolve at user sites, and making it a real dependency drags a
 * transitive tree whose nested paths exceed Windows MAX_PATH — which breaks
 * `git clean -fdx` on `pi update`. See AGENTS.md, "Dependencies & install
 * constraints".
 *
 * This invariant was previously prose only. It is load-bearing: it is exactly
 * why pi-lens INLINES the SDK's runtime helpers (`clients/tool-event.ts`)
 * instead of importing `isToolCallEventType` / `isEditToolResult` and friends.
 * Modelled on the #402 `typescript`-runtime-free scan.
 */
const RUNTIME_DIRS = ["clients", "tools", "mcp", "commands"];
const ROOT_FILES = ["index.ts", "i18n.ts"];

const HOST_SDK = "@earendil-works/pi-coding-agent";

/**
 * `import … from "<pkg>"` — the clause is captured for type-only checking.
 * The clause excludes `;` and quotes so the lazy match cannot run backwards
 * across a preceding import statement from a different package.
 */
const STATIC_IMPORT = new RegExp(
	String.raw`import\s+([^;"']*?)\s+from\s*["']${HOST_SDK}["']`,
	"g",
);
/**
 * `import "<pkg>"` — a bare side-effect import executes the module: a runtime
 * value import with no clause (#1353 review; the STATIC_IMPORT regex requires
 * a clause + `from`, so this form needs its own pattern).
 */
const SIDE_EFFECT_IMPORT = new RegExp(String.raw`import\s*["']${HOST_SDK}["']`);
/** `import("<pkg>")` / `require("<pkg>")` — always a runtime value import. */
const DYNAMIC_IMPORT = new RegExp(
	String.raw`(?:\bimport|\brequire)\s*\(\s*["']${HOST_SDK}["']`,
);

/**
 * #3506: the admitted LAZY dynamic imports, by file and exact count. pi exposes
 * `withFileMutationQueue` only as a package export, and its extension loader
 * serves that package from the running host (jiti `virtualModules` in the
 * bundled CLI), so the pi host adapter looks it up on pi-lens' first write,
 * behind a catch that falls back to unqueued writes and records
 * `host-file-mutation-queue-unavailable` (`clients/file-mutation-queue.ts`).
 * Nothing is imported at load, so a host that cannot serve the package still
 * loads pi-lens, which is the failure #1334 S6 exists to prevent. A new site,
 * or a stale entry here, fails the scan.
 */
const ADMITTED_LAZY_DYNAMIC_IMPORTS: Readonly<Record<string, number>> = {
	"index.ts": 1,
};

function* walkTs(dir: string): Generator<string> {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const p = path.join(dir, entry);
		if (statSync(p).isDirectory()) {
			if (entry === "node_modules") continue;
			yield* walkTs(p);
		} else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
			yield p;
		}
	}
}

/** True when every binding in an import clause is erased at compile time. */
function isTypeOnlyClause(clause: string): boolean {
	const trimmed = clause.trim();
	// `import type { … }` / `import type X` — whole statement is type-only.
	if (/^type\b/.test(trimmed)) return true;
	// Otherwise it must be a braced list where EVERY specifier is `type X`.
	const braced = /^\{([\s\S]*)\}$/.exec(trimmed);
	if (!braced) return false;
	return braced[1]
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.every((s) => /^type\s/.test(s));
}

function shippedSourceFiles(): string[] {
	return [
		...ROOT_FILES.map((f) => path.join(root, f)),
		...RUNTIME_DIRS.flatMap((d) => [...walkTs(path.join(root, d))]),
	];
}

describe("host SDK is imported type-only, never at runtime (#1334 S6)", () => {
	it("no shipped source file value-imports @earendil-works/pi-coding-agent", () => {
		const offenders: string[] = [];
		for (const file of shippedSourceFiles()) {
			const src = readFileSync(file, "utf8");
			if (!src.includes(HOST_SDK)) continue;
			const rel = path.relative(root, file).replace(/\\/g, "/");

			const dynamicImports = src.match(
				new RegExp(DYNAMIC_IMPORT.source, "g"),
			)?.length;
			if ((dynamicImports ?? 0) !== (ADMITTED_LAZY_DYNAMIC_IMPORTS[rel] ?? 0)) {
				offenders.push(`${rel} (dynamic import/require)`);
			}
			if (SIDE_EFFECT_IMPORT.test(src)) {
				offenders.push(`${rel} (side-effect import)`);
			}
			for (const match of src.matchAll(STATIC_IMPORT)) {
				if (!isTypeOnlyClause(match[1])) {
					offenders.push(`${rel} (value import: ${match[1].trim()})`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("the scan actually recognizes a value import (guards the guard)", () => {
		expect(isTypeOnlyClause("type { ExtensionAPI }")).toBe(true);
		expect(isTypeOnlyClause("{ type Theme, type ToolDefinition }")).toBe(true);
		// The exact shape S6 audited and rejected: the host's tool-result
		// discriminators are runtime functions, so importing them is a value
		// import even though they only ever narrow types.
		expect(isTypeOnlyClause("{ isEditToolResult, isReadToolResult }")).toBe(
			false,
		);
		expect(isTypeOnlyClause("{ type EditToolInput, isEditToolResult }")).toBe(
			false,
		);
		expect(isTypeOnlyClause("* as pi")).toBe(false);
		expect(DYNAMIC_IMPORT.test(`await import("${HOST_SDK}")`)).toBe(true);
		expect(DYNAMIC_IMPORT.test(`require("${HOST_SDK}")`)).toBe(true);
		expect(SIDE_EFFECT_IMPORT.test(`import "${HOST_SDK}";`)).toBe(true);
		expect(
			SIDE_EFFECT_IMPORT.test(`import type { X } from "${HOST_SDK}";`),
		).toBe(false);
	});

	it("keeps the host SDK out of runtime dependencies", () => {
		const pkg = JSON.parse(
			readFileSync(path.join(root, "package.json"), "utf8"),
		) as {
			dependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		expect(pkg.dependencies?.[HOST_SDK]).toBeUndefined();
		expect(pkg.peerDependencies?.[HOST_SDK]).toBeDefined();
		expect(pkg.devDependencies?.[HOST_SDK]).toBeDefined();
	});
});
