/**
 * The generalized public-surface drift guard (#2427; #2415's third addition).
 *
 * The repo already had this test SHAPE four times — `lsp-registry-consistency`,
 * `lsp-fixture-coverage`, `tool-registry-consistency`,
 * `formatter-policy-consistency` — each a per-registry island, and none of them
 * relating a registry to a published schema or to a reference doc. The point of
 * this module is that #2416 and #2383 add an ENTRY, not a fifth island: they
 * describe their surface once and inherit every check below.
 *
 * Four questions, one per way a public surface rots:
 *
 * 1. Does the schema still publish only tiered fields, and is every field it
 *    publishes written down somewhere a user can read? (A field nobody
 *    documented is a field nobody can use on purpose.)
 * 2. Does the published schema enumerate every id the code actually accepts?
 *    (A built-in server the schema's `enum` omits is a value the editor
 *    red-underlines and the runtime honors.)
 * 3. Does every catalog entry have a smoke fixture, or an EXPLICIT exemption
 *    with a reason? (`lsp-fixture-coverage`'s lesson: a newly registered server
 *    got zero nightly handshake coverage and nothing complained.)
 * 4. Is every stable diagnostic code documented? (A code a user is told to
 *    match on, that the docs never mention, is a promise with no text.)
 *
 * Every check is CONDITIONAL on its input being supplied, and that is
 * deliberate rather than lax: a surface registers what it actually publishes,
 * and a check with nothing to bind to reports nothing rather than passing
 * vacuously while looking like coverage. `assertPublicSurface` throws when a
 * surface supplies an input and fails it; `publicSurfaceDrift` returns the same
 * findings for a caller that wants to assert on them one at a time.
 */

import * as fs from "node:fs";
import { escapeRegExp } from "./sweep-kit.js";
import {
	assertSchemaStabilityTiers,
	type JsonSchemaNode,
	walkSchemaProperties,
} from "./schema-stability.js";

/** One registry whose ids are public API. */
interface SurfaceCatalog {
	/** Human name, used in failure messages. */
	readonly name: string;
	/** Every id the code accepts today. */
	readonly ids: readonly string[];
	/**
	 * The ids the PUBLISHED schema enumerates. When supplied, every catalog id
	 * must appear in it. Omit until the schema actually publishes an enum —
	 * #2416/#2383 supply it, and `schemaEnumAt` extracts it.
	 */
	readonly publishedIds?: readonly string[];
	/** When true, every id must be named in the surface's docs. */
	readonly documented?: boolean;
	/**
	 * The ids a smoke fixture exercises. When supplied, every catalog id must be
	 * covered or exempt.
	 */
	readonly fixtureIds?: readonly string[];
	/** id -> why it needs no fixture. An exemption without a reason is a hole. */
	readonly fixtureExemptions?: ReadonlyMap<string, string>;
}

/** One public surface: a schema, its docs, its codes, and its catalogs. */
export interface PublicSurface {
	readonly name: string;
	/** The published JSON Schema object. */
	readonly schema?: unknown;
	/**
	 * Reference doc path(s). A LIST because pi-lens's reference is split by
	 * audience — `configuration.md` is the lookup-order narrative and points at
	 * `settings.md` / `globalconfig.md` / `environment-variables.md` for the
	 * per-setting tables — so requiring one file would either fail on 14
	 * documented sections or force them all into one page.
	 */
	readonly docsPath?: string | readonly string[];
	/** Stable diagnostic codes this surface promises. */
	readonly codes?: readonly string[];
	readonly catalogs?: readonly SurfaceCatalog[];
}

/**
 * Is `name` genuinely written down, rather than merely a substring?
 *
 * A bare `text.includes(name)` passes for `tools` against the word
 * "tools" in a sentence — which would make the whole check read as coverage
 * while proving nothing. A documented field appears as code, as a JSON key in
 * an example, in a heading, or in a table row, and those four shapes are what
 * this matches.
 *
 * The name must be a WHOLE TOKEN in all four (#2427 review round 2, F7).
 * Round 1 matched the name anywhere inside a code span, so `ui` was
 * "documented" by a span reading `builtin` and `guard` by `guardrails` — and
 * the helper test that claimed to reject an incidental substring only ever
 * exercised the PROSE case, which is rejected on the span shape rather than on
 * the name, so the claim was never tested. The boundary excludes identifier
 * characters only, so a dotted or indexed path still documents its head: a
 * span reading `config.ui.compact` documents `ui`, a longer word does not.
 */
export function documentedIn(text: string, name: string): boolean {
	const escaped = escapeRegExp(name);
	const token = `(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`;
	return new RegExp(
		`(\`[^\`\\n]*${token}[^\`\\n]*\`)|("${escaped}"\\s*:)|(^#{1,6}\\s.*${token})|(^\\|[^\\n]*${token})`,
		"m",
	).test(text);
}

function docTexts(docsPath: string | readonly string[] | undefined): string[] {
	if (docsPath === undefined) return [];
	const paths = typeof docsPath === "string" ? [docsPath] : docsPath;
	return paths.map((file) => fs.readFileSync(file, "utf-8"));
}

/**
 * The `enum` a schema declares at a JSON-pointer path, or `undefined`.
 *
 * The extractor rather than a hand-written path walk at each call site, so
 * "where the catalog's ids are published" is spelled once per surface.
 */
export function schemaEnumAt(
	schema: unknown,
	pointer: string,
): string[] | undefined {
	let node: unknown = schema;
	for (const segment of pointer.split("/").filter(Boolean)) {
		if (typeof node !== "object" || node === null) return undefined;
		node = (node as Record<string, unknown>)[segment];
	}
	if (typeof node !== "object" || node === null) return undefined;
	const values = (node as Record<string, unknown>).enum;
	return Array.isArray(values)
		? values.map((value) => String(value))
		: undefined;
}

/**
 * Catalog ids with no fixture and no exemption.
 *
 * Exported on its own because `lsp-fixture-coverage.test.ts` asks exactly this
 * question of a registry that has no schema and no docs entry yet; it calls
 * here rather than keeping its own copy, which is the whole reason this module
 * exists.
 */
export function catalogFixtureGaps(input: {
	readonly ids: readonly string[];
	readonly covered: ReadonlySet<string>;
	readonly exempt?: ReadonlyMap<string, string>;
}): string[] {
	return input.ids.filter(
		(id) => !input.covered.has(id) && !(input.exempt?.has(id) ?? false),
	);
}

/** Exemptions naming an id that no longer exists — a stale reason is a lie. */
export function staleExemptions(
	ids: readonly string[],
	exempt: ReadonlyMap<string, string> | undefined,
): string[] {
	if (!exempt) return [];
	const known = new Set(ids);
	return [...exempt.keys()].filter((id) => !known.has(id));
}

/** Every drift finding for one surface, as human-readable lines. */
export function publicSurfaceDrift(surface: PublicSurface): string[] {
	const findings: string[] = [];
	const docs = docTexts(surface.docsPath);
	const documented = (name: string) =>
		docs.some((text) => documentedIn(text, name));

	if (surface.schema !== undefined) {
		try {
			assertSchemaStabilityTiers(surface.schema);
		} catch (error) {
			findings.push(
				`${surface.name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (docs.length > 0) {
			const undocumented: string[] = [];
			walkSchemaProperties(surface.schema, ({ name, pointer }) => {
				if (!documented(name)) undocumented.push(`${pointer} (${name})`);
			});
			if (undocumented.length > 0) {
				findings.push(
					`${surface.name}: schema field(s) not documented in ${
						typeof surface.docsPath === "string"
							? surface.docsPath
							: (surface.docsPath ?? []).join(", ")
					} — a published field a user cannot look up: ${undocumented.join(", ")}`,
				);
			}
		}
	}

	for (const catalog of surface.catalogs ?? []) {
		if (catalog.publishedIds !== undefined) {
			const published = new Set(catalog.publishedIds);
			const missing = catalog.ids.filter((id) => !published.has(id));
			if (missing.length > 0) {
				findings.push(
					`${surface.name}/${catalog.name}: id(s) the code accepts but the ` +
						`published schema enum omits — add them to the schema: ${missing.join(", ")}`,
				);
			}
			const extra = catalog.publishedIds.filter(
				(id) => !catalog.ids.includes(id),
			);
			if (extra.length > 0) {
				findings.push(
					`${surface.name}/${catalog.name}: published schema enum offers id(s) ` +
						`no registry entry backs: ${extra.join(", ")}`,
				);
			}
		}

		if (catalog.documented === true && docs.length > 0) {
			const missing = catalog.ids.filter((id) => !documented(id));
			if (missing.length > 0) {
				findings.push(
					`${surface.name}/${catalog.name}: catalog entr(ies) missing from the reference docs: ${missing.join(", ")}`,
				);
			}
		}

		if (catalog.fixtureIds !== undefined) {
			const gaps = catalogFixtureGaps({
				ids: catalog.ids,
				covered: new Set(catalog.fixtureIds),
				exempt: catalog.fixtureExemptions,
			});
			if (gaps.length > 0) {
				findings.push(
					`${surface.name}/${catalog.name}: catalog entr(ies) with NO smoke ` +
						`fixture — add a fixture or an exemption with a reason: ${gaps.join(", ")}`,
				);
			}
		}

		const stale = staleExemptions(catalog.ids, catalog.fixtureExemptions);
		if (stale.length > 0) {
			findings.push(
				`${surface.name}/${catalog.name}: fixture exemption(s) for id(s) that no longer exist: ${stale.join(", ")}`,
			);
		}
	}

	if (surface.codes !== undefined && docs.length > 0) {
		const missing = surface.codes.filter((code) => !documented(code));
		if (missing.length > 0) {
			findings.push(
				`${surface.name}: diagnostic code(s) not documented — a code users are ` +
					`told to match on must appear in the reference: ${missing.join(", ")}`,
			);
		}
	}

	return findings;
}

/** Throw with every finding, or return quietly. */
export function assertPublicSurface(surface: PublicSurface): void {
	const findings = publicSurfaceDrift(surface);
	if (findings.length > 0) {
		throw new Error(`public surface drift:\n  ${findings.join("\n  ")}`);
	}
}

/**
 * A minimal well-formed surface, so the harness's own positive and negative
 * behavior is provable independently of any real registry — the same reason
 * `PLACEHOLDER_CONFIG_SCHEMA` exists next door.
 */
export const PLACEHOLDER_SURFACE_SCHEMA: JsonSchemaNode = {
	type: "object",
	properties: {
		widgetMode: { type: "string", "x-stability": "stable" },
	},
};
