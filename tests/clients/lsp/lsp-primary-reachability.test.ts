import { describe, expect, it } from "vitest";
import { getServersForFileWithConfig } from "../../../clients/lsp/config.js";
import { LSP_SERVERS } from "../../../clients/lsp/server.js";

/**
 * Reachability guard for primary LSP selection.
 *
 * `getClientForFile` selects the primary by iterating
 * `getServersForFileWithConfig(file).filter(role !== "auxiliary")` in registry
 * order and taking the first server whose `spawn` succeeds. So a non-auxiliary
 * server earns its registry slot only if it can actually be *selected* as
 * primary for some file — either as the DEFAULT first-match for an extension it
 * claims, or as an ALTERNATE that wins when the higher-priority server(s) for a
 * shared extension are unavailable (not installed) or disabled in
 * `.pi-lens/lsp.json`.
 *
 * The dormant ESLint LSP (removed in the #111 follow-up) is the cautionary
 * case: it claimed `.js/.jsx/.svelte/.vue` but was shadowed by typescript /
 * svelte / vue for every one of them, so the only time it could be selected was
 * when no real language server for those files existed — i.e. never, in
 * practice. A cross-cutting linter belongs ALONGSIDE the primary
 * (`role:"auxiliary"`), not buried in the primary fallback chain. This guard
 * fails any future non-auxiliary server that is neither a default winner nor a
 * declared alternate, with guidance to mark it auxiliary or declare it.
 */

/**
 * Intentional alternate primaries: a second language server for a language
 * whose default is registered ahead of it. Reached at runtime by availability
 * fallthrough (default not installed) or by disabling the default in
 * `.pi-lens/lsp.json`. `ext` is one extension both servers share. Derived from
 * the registry's actual zero-default-win set — keep it in lockstep with reality
 * (the completeness test below fails if a non-aux server is neither a winner
 * nor declared here).
 */
const ALTERNATES = [
	{ id: "deno", defaultId: "typescript", ext: ".ts" },
	{ id: "python-jedi", defaultId: "python", ext: ".py" },
	{ id: "omnisharp", defaultId: "csharp", ext: ".cs" },
] as const;

const NON_AUX = LSP_SERVERS.filter((s) => s.role !== "auxiliary");
const AUX = LSP_SERVERS.filter((s) => s.role === "auxiliary");

const probePath = (token: string) =>
	token.startsWith(".") ? `/proj/probe${token}` : `/proj/${token}`;

// Faithful to getClientForFile's candidate stage: real extension/basename
// matching + registry order, auxiliaries filtered out (they attach alongside,
// never as primary). The only stage not modelled here is the runtime spawn —
// which removes an unavailable server from contention exactly as disabling it
// would, so the alternate-fallthrough test below filters predecessors out of
// this same list to model that.
const primaryCandidates = (token: string) =>
	getServersForFileWithConfig(probePath(token)).filter(
		(s) => s.role !== "auxiliary",
	);
const defaultPrimary = (token: string) => primaryCandidates(token)[0]?.id;

describe("LSP primary reachability", () => {
	it("every non-auxiliary server is selectable as primary (default winner or declared alternate)", () => {
		const declaredAlternates = new Set<string>(ALTERNATES.map((a) => a.id));
		const unreachable: string[] = [];
		for (const s of NON_AUX) {
			const winsByDefault = s.extensions.some(
				(t) => defaultPrimary(t) === s.id,
			);
			if (!winsByDefault && !declaredAlternates.has(s.id)) {
				unreachable.push(s.id);
			}
		}
		expect(
			unreachable,
			`These non-auxiliary servers win NO extension by default and are not declared alternates, ` +
				`so getClientForFile can never select them in the common case (a real language server ` +
				`shadows them for every extension they claim). If a server is a cross-cutting / ` +
				`diagnostic-only tool (linter, scanner, spellcheck), set role:"auxiliary" so it attaches ` +
				`ALONGSIDE the primary. If it is a genuine alternate language server, add it to ALTERNATES ` +
				`with the default it falls back from. Offenders: ${unreachable.join(", ")}`,
		).toEqual([]);
	});

	it("each declared alternate is wired behind its default and is the next pick when predecessors drop out", () => {
		for (const { id, defaultId, ext } of ALTERNATES) {
			const chain = primaryCandidates(ext).map((s) => s.id);
			expect(chain, `${id} should be a primary candidate for ${ext}`).toContain(
				id,
			);
			expect(
				chain,
				`${id}'s declared default ${defaultId} should be a candidate for ${ext}`,
			).toContain(defaultId);
			// The default precedes the alternate, so it wins when both are available…
			expect(
				chain.indexOf(defaultId),
				`${defaultId} should be ordered before ${id} for ${ext}`,
			).toBeLessThan(chain.indexOf(id));
			// …and with every predecessor unavailable/disabled, the alternate is the
			// next server selected as primary (models spawn-fallthrough / config disable).
			const predecessors = new Set(chain.slice(0, chain.indexOf(id)));
			const next = chain.find((c) => !predecessors.has(c));
			expect(
				next,
				`with [${[...predecessors].join(", ")}] unavailable, ${id} should be selected for ${ext}`,
			).toBe(id);
		}
	});

	it("declared alternates and their defaults are real, distinct, non-auxiliary servers", () => {
		for (const { id, defaultId } of ALTERNATES) {
			expect(
				NON_AUX.some((s) => s.id === id),
				`${id} is a registered non-aux server`,
			).toBe(true);
			expect(
				NON_AUX.some((s) => s.id === defaultId),
				`${defaultId} is a registered non-aux server`,
			).toBe(true);
			expect(id, `${id} must differ from its default`).not.toBe(defaultId);
		}
	});

	it("auxiliary servers are never selected as primary for the extensions they attach to", () => {
		expect(
			AUX.length,
			"expected at least one auxiliary server (opengrep)",
		).toBeGreaterThan(0);
		for (const aux of AUX) {
			for (const t of aux.extensions) {
				expect(
					primaryCandidates(t).map((s) => s.id),
					`auxiliary ${aux.id} must not appear in the primary candidate list for ${t}`,
				).not.toContain(aux.id);
			}
		}
	});
});
