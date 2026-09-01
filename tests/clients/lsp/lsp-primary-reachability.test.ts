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

const NON_AUX = LSP_SERVERS.filter((s) => s.role !== "auxiliary");
const AUX = LSP_SERVERS.filter((s) => s.role === "auxiliary");
const DECLARED_FALLBACKS = LSP_SERVERS.filter(
	(s) => s.fallbackFor !== undefined,
);
const SERVER_BY_ID = new Map(LSP_SERVERS.map((server) => [server.id, server]));

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

/**
 * Validate fallback declarations without relying on primary selection. The
 * production selection path only consumes `fallbackFor` as a lookup key, so
 * these registry-wide checks independently reject malformed metadata.
 */
function fallbackDeclarationIssues(
	servers: readonly (typeof LSP_SERVERS)[number][],
): string[] {
	const byId = new Map(servers.map((server) => [server.id, server]));
	const issues: string[] = [];
	for (const fallback of servers.filter(
		(server) => server.fallbackFor !== undefined,
	)) {
		const preferred = byId.get(fallback.fallbackFor as string);
		if (!preferred) {
			issues.push(`${fallback.id} targets missing ${fallback.fallbackFor}`);
			continue;
		}
		if (fallback.role === "auxiliary") {
			issues.push(`${fallback.id} is auxiliary`);
		}
		if (preferred.role === "auxiliary") {
			issues.push(`${fallback.id} targets auxiliary ${preferred.id}`);
		}
		if (fallback.id === preferred.id) {
			issues.push(`${fallback.id} targets itself`);
		}
		if (
			!fallback.extensions.some((extension) =>
				preferred.extensions.includes(extension),
			)
		) {
			issues.push(`${fallback.id} shares no extension with ${preferred.id}`);
		}
		if (servers.indexOf(preferred) >= servers.indexOf(fallback)) {
			issues.push(`${fallback.id} is not after ${preferred.id}`);
		}
	}
	return issues;
}

describe("LSP primary reachability", () => {
	it("every non-auxiliary server is selectable as primary (default winner or declared alternate)", () => {
		const declaredFallbackIds = new Set(
			DECLARED_FALLBACKS.filter((server) => server.role !== "auxiliary").map(
				(server) => server.id,
			),
		);
		const unreachable: string[] = [];
		for (const s of NON_AUX) {
			const winsByDefault = s.extensions.some(
				(t) => defaultPrimary(t) === s.id,
			);
			if (!winsByDefault && !declaredFallbackIds.has(s.id)) {
				unreachable.push(s.id);
			}
		}
		expect(
			unreachable,
			`These non-auxiliary servers win NO extension by default and are not declared alternates, ` +
				`so getClientForFile can never select them in the common case (a real language server ` +
				`shadows them for every extension they claim). If a server is a cross-cutting / ` +
				`diagnostic-only tool (linter, scanner, spellcheck), set role:"auxiliary" so it attaches ` +
				`ALONGSIDE the primary. If it is a genuine alternate language server, declare its ` +
				`preferred server with fallbackFor. Offenders: ${unreachable.join(", ")}`,
		).toEqual([]);
	});

	it("marksman is the primary markdown server for .md and .mdx (#274)", () => {
		expect(defaultPrimary(".md")).toBe("marksman");
		expect(defaultPrimary(".mdx")).toBe("marksman");
	});

	it("PowerShell Editor Services is the primary server for .ps1/.psm1/.psd1 (#278)", () => {
		expect(defaultPrimary(".ps1")).toBe("powershell");
		expect(defaultPrimary(".psm1")).toBe("powershell");
		expect(defaultPrimary(".psd1")).toBe("powershell");
	});

	it("routes Fish and both CMake filename forms to their primary servers (#892, #893)", () => {
		expect(defaultPrimary(".fish")).toBe("fish");
		expect(defaultPrimary(".cmake")).toBe("cmake");
		expect(defaultPrimary("CMakeLists.txt")).toBe("cmake");
	});

	it("fallback declarations target reachable, ordered, compatible primary servers", () => {
		const issues = fallbackDeclarationIssues(LSP_SERVERS);
		expect(issues, "malformed fallbackFor declarations").toEqual([]);

		for (const fallback of DECLARED_FALLBACKS) {
			const preferred = SERVER_BY_ID.get(fallback.fallbackFor as string);
			expect(preferred, `${fallback.id} preferred server exists`).toBeDefined();
			if (!preferred) continue;
			const sharedExtension = fallback.extensions.find((extension) =>
				preferred.extensions.includes(extension),
			);
			expect(
				sharedExtension,
				`${fallback.id} shares an extension`,
			).toBeDefined();
			if (!sharedExtension) continue;
			const chain = primaryCandidates(sharedExtension).map((s) => s.id);
			expect(
				chain,
				`${fallback.id} is reachable for ${sharedExtension}`,
			).toContain(fallback.id);
			expect(
				chain,
				`${preferred.id} is reachable for ${sharedExtension}`,
			).toContain(preferred.id);
			expect(
				chain.indexOf(preferred.id),
				`${preferred.id} should precede ${fallback.id} for ${sharedExtension}`,
			).toBeLessThan(chain.indexOf(fallback.id));
			const predecessors = new Set(chain.slice(0, chain.indexOf(fallback.id)));
			const next = chain.find((serverId) => !predecessors.has(serverId));
			expect(
				next,
				`with [${[...predecessors].join(", ")}] unavailable, ${fallback.id} should be selected for ${sharedExtension}`,
			).toBe(fallback.id);
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
