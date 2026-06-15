import { describe, expect, it } from "vitest";
import { LSP_SERVERS } from "../../../clients/lsp/server.js";

/**
 * Deterministic, server-free guard on the LSP registry wiring. The live
 * install→launch→handshake net lives in scripts/smoke-lsp.mjs (opt-in/nightly);
 * this catches the cheap-to-catch class of mistake per-PR: a half-wired or
 * duplicated server entry. Complements the #208 verify-contract test
 * (installer/lsp-transport-verify) — that locks how a server is *verified*;
 * this locks that every server pi-lens claims to support is *well-formed*.
 */
describe("LSP_SERVERS registry consistency", () => {
	it("is non-empty", () => {
		expect(LSP_SERVERS.length).toBeGreaterThan(0);
	});

	it("every server has the required wiring (id, name, spawn, root, extensions)", () => {
		for (const s of LSP_SERVERS) {
			expect(typeof s.id, `id on ${JSON.stringify(s)}`).toBe("string");
			expect(s.id.length, `non-empty id`).toBeGreaterThan(0);
			expect(typeof s.name, `name on ${s.id}`).toBe("string");
			expect(typeof s.spawn, `spawn on ${s.id}`).toBe("function");
			expect(typeof s.root, `root on ${s.id}`).toBe("function");
			expect(Array.isArray(s.extensions), `extensions on ${s.id}`).toBe(true);
			expect(s.extensions.length, `non-empty extensions on ${s.id}`).toBeGreaterThan(0);
		}
	});

	it("server ids are globally unique", () => {
		const seen = new Map<string, number>();
		for (const s of LSP_SERVERS) seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
		const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
		expect(dupes, `duplicate server ids: ${dupes.join(", ")}`).toEqual([]);
	});

	it("every extension entry is a clean matchable token (dotted suffix or basename)", () => {
		// The registry matches by suffix (".ts", ".c++") AND by full basename
		// ("Dockerfile"), so don't force a leading dot — just assert each entry is
		// a non-empty token with no path separators or whitespace.
		for (const s of LSP_SERVERS) {
			for (const ext of s.extensions) {
				expect(typeof ext, `${s.id} extension type`).toBe("string");
				expect(ext.length, `${s.id} empty extension`).toBeGreaterThan(0);
				expect(ext, `${s.id} extension "${ext}" has separator/space`).not.toMatch(
					/[\\/\s]/,
				);
			}
		}
	});

	it("optional timeouts, when set, are positive finite numbers", () => {
		for (const s of LSP_SERVERS) {
			for (const key of ["initializeTimeoutMs", "clientWaitTimeoutMs"] as const) {
				const v = s[key];
				if (v !== undefined) {
					expect(Number.isFinite(v), `${s.id}.${key}`).toBe(true);
					expect(v, `${s.id}.${key}`).toBeGreaterThan(0);
				}
			}
		}
	});
});
