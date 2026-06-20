/**
 * Footer LSP-status selection (#170).
 *
 * Turns three raw inputs — the alive server ids (#267), the raw failed-spawn
 * server ids (widget-state), and the file-kinds in use this session — into the
 * two id lists the footer renders: `LSP Active: …` (green) and `LSP Failed: …`
 * (red). Kept as a pure function so the policy is unit-testable without spawning
 * a server or touching module state.
 *
 * Failure is a per-LANGUAGE property, not per-server:
 *   - A failed language server is surfaced ONLY when no live language-server
 *     sibling covers its extensions (so pyright-fails-but-jedi-succeeds reads as
 *     Active, never Failed), AND its kind is still in use this session (a failure
 *     for a language you're no longer editing is stale and dropped).
 *   - Auxiliary servers (opengrep/ast-grep) are cross-cutting scanners, not a
 *     language's LSP — they neither provide language coverage nor surface as a
 *     language failure. They still appear in the Active list via the alive set.
 */

import { getFileKindsForExtension } from "./file-kinds.js";
import { LSP_SERVERS } from "./lsp/server.js";

export interface LspStatusSelection {
	/** Alive servers, as-is (#267 ordering; includes auxiliaries). */
	activeIds: string[];
	/** Language servers that failed with no live sibling and a still-in-use kind. */
	failedIds: string[];
}

function serverById(id: string) {
	return LSP_SERVERS.find((s) => s.id === id);
}

export function selectLspStatus(
	aliveServerIds: string[],
	failedServerIds: string[],
	sessionKinds: string[],
): LspStatusSelection {
	// Extensions covered by an ALIVE language server (auxiliaries excluded — an
	// alive opengrep must not make a failed python server look "covered").
	const aliveSet = new Set(aliveServerIds);
	const aliveLangExts = new Set<string>();
	for (const s of LSP_SERVERS) {
		if (s.role === "auxiliary" || !aliveSet.has(s.id)) continue;
		for (const ext of s.extensions) aliveLangExts.add(ext.toLowerCase());
	}

	const sessionKindSet = new Set(sessionKinds);
	const failedIds: string[] = [];
	const seen = new Set<string>();
	for (const id of failedServerIds) {
		if (seen.has(id)) continue;
		seen.add(id);
		const server = serverById(id);
		if (!server || server.role === "auxiliary") continue; // language servers only
		const exts = server.extensions.map((e) => e.toLowerCase());
		// (a) a live language sibling already covers this language → not a failure.
		if (exts.some((e) => aliveLangExts.has(e))) continue;
		// (b) still in use this session? else the failure is stale.
		const kinds = new Set<string>();
		for (const e of exts) for (const k of getFileKindsForExtension(e)) kinds.add(k);
		if (![...kinds].some((k) => sessionKindSet.has(k))) continue;
		failedIds.push(id);
	}

	return { activeIds: [...aliveServerIds], failedIds };
}
