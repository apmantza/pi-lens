import { describe, expect, it } from "vitest";
import { INITIALIZE_TIMEOUT_MS } from "../../../clients/lsp/client.js";
import * as serverModule from "../../../clients/lsp/server.js";
import { LSP_SERVERS } from "../../../clients/lsp/server.js";
import {
	LSP_DIAGNOSTICS_WAIT_MS,
	LSP_RUNNER_TIMEOUT_MS,
} from "../../../clients/dispatch/runners/lsp.js";

/** A module export that is shaped like an LSPServerInfo (duck-typed). */
function isServerInfoLike(v: unknown): v is { id: string } {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.id === "string" &&
		typeof o.spawn === "function" &&
		typeof o.root === "function" &&
		Array.isArray(o.extensions)
	);
}

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
			expect(
				s.extensions.length,
				`non-empty extensions on ${s.id}`,
			).toBeGreaterThan(0);
		}
	});

	// #5699: every built-in joins the ownership-gated orphan backstop.
	it("every built-in declares command markers and OS images for the backstop", () => {
		for (const server of LSP_SERVERS) {
			expect(server.orphanProcess?.names.length, server.id).toBeGreaterThan(0);
			expect(server.orphanProcess?.images.length, server.id).toBeGreaterThan(0);
		}
	});

	it("has no orphan servers — every exported *Server is registered in LSP_SERVERS (#270)", () => {
		// Catches the dead-code class the consistency checks above can't see: a
		// fully-defined server const that was never added to LSP_SERVERS, so it can
		// never be a candidate for any file (e.g. the removed ruby-solargraph).
		const registered = new Set(LSP_SERVERS);
		const orphans = Object.entries(serverModule)
			.filter(([, v]) => isServerInfoLike(v))
			.filter(([, v]) => !registered.has(v as (typeof LSP_SERVERS)[number]))
			.map(([name, v]) => `${name} (id="${(v as { id: string }).id}")`);
		expect(
			orphans,
			`server(s) defined but not in LSP_SERVERS: ${orphans.join(", ")}`,
		).toEqual([]);
	});

	it("server ids are globally unique", () => {
		const seen = new Map<string, number>();
		for (const s of LSP_SERVERS) seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
		const dupes = [...seen.entries()]
			.filter(([, n]) => n > 1)
			.map(([id]) => id);
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
				expect(
					ext,
					`${s.id} extension "${ext}" has separator/space`,
				).not.toMatch(/[\\/\s]/);
			}
		}
	});

	it("optional timeouts, when set, are positive finite numbers", () => {
		for (const s of LSP_SERVERS) {
			for (const key of [
				"initializeTimeoutMs",
				"clientWaitTimeoutMs",
			] as const) {
				const v = s[key];
				if (v !== undefined) {
					expect(Number.isFinite(v), `${s.id}.${key}`).toBe(true);
					expect(v, `${s.id}.${key}`).toBeGreaterThan(0);
				}
			}
		}
	});

	/**
	 * #2169/#2176: the dispatch lsp-runner's `touchFile` call bounds cold-spawn
	 * waiting at `RUNTIME_CONFIG.pipeline.lspSpawnBudgetMs` (5s) by default —
	 * `getClientForFile` only raises that floor when the matching server
	 * declares `clientWaitTimeoutMs` (the same seam RubyServer already uses for
	 * its own slow cold-start bundle setup). Bash and JSON got a 20s installer
	 * verification bound in #2194, and Vue a 30s bound in #2176's first PR, but
	 * none of the three raised this SEPARATE dispatch-side floor — so a cold
	 * spawn could still lose the 5s race and read as unavailable even after
	 * installer verification would have accepted it. Svelte and Prisma need
	 * the same floor for their own #2169 installer bounds.
	 */
	it("raises the dispatch client-wait floor for every known cold-start server (#2169, #2176)", () => {
		const expected: Record<string, number> = {
			bash: 20_000,
			json: 20_000,
			prisma: 40_000,
			vue: 30_000,
			svelte: 20_000,
		};
		for (const [id, timeoutMs] of Object.entries(expected)) {
			const server = LSP_SERVERS.find((s) => s.id === id);
			expect(server, `${id} registered`).toBeDefined();
			expect(server?.clientWaitTimeoutMs, `${id}.clientWaitTimeoutMs`).toBe(
				timeoutMs,
			);
			// Fix-round F1 (#2233): `clientWaitTimeoutMs` alone is a no-op. The
			// spawn's own `initialize` handshake is hard-killed at
			// `initializeTimeoutMs` (default 15s, `clients/lsp/client.ts`),
			// independently of how long the caller is willing to wait. A raised
			// wait floor with no matching raise on this field dies at the
			// unraised inner bound before the outer wait ever gets to matter.
			expect(server?.initializeTimeoutMs, `${id}.initializeTimeoutMs`).toBe(
				timeoutMs,
			);
		}
	});

	/**
	 * Fix-round F1 (#2233), generalized: for every server that declares
	 * `clientWaitTimeoutMs` (a promise to the caller "I'll wait this long for
	 * a cold spawn"), `initializeTimeoutMs` must be at least as generous —
	 * otherwise `createLSPClient`'s hard kill (`clients/lsp/client.ts`,
	 * enforced around the `initialize` request) fires first and the raised
	 * outer wait can never be used. This is exactly the shape that made the
	 * original Prisma/Vue `clientWaitTimeoutMs` raise a no-op: both left
	 * `initializeTimeoutMs` unset, falling back to the 15s default well
	 * under their own 40s/30s waits.
	 */
	it("never lets the inner initialize kill fire before the outer client wait (#2233 F1)", () => {
		for (const s of LSP_SERVERS) {
			if (s.clientWaitTimeoutMs === undefined) continue;
			const effectiveInit = s.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;
			expect(
				effectiveInit,
				`${s.id}: initializeTimeoutMs (${effectiveInit}) must be >= ` +
					`clientWaitTimeoutMs (${s.clientWaitTimeoutMs}) or the raised ` +
					`wait can never be used — the spawn is killed first`,
			).toBeGreaterThanOrEqual(s.clientWaitTimeoutMs);
		}
	});

	/**
	 * Fix-round F2 (#2233): the dispatch lsp-runner's OWN wall-clock budget
	 * (`clients/dispatch/runners/lsp.ts`'s `LSP_RUNNER_TIMEOUT_MS`, passed as
	 * this runner's `timeoutMs` to `dispatcher.ts`'s `runRunner`) must leave
	 * headroom over any server's `clientWaitTimeoutMs` plus the diagnostics
	 * wait that still runs after a cold spawn succeeds. Without this, the
	 * dispatcher's own race (`runner.timeoutMs ?? RUNNER_TIMEOUT_MS`, 30s by
	 * default) fires before a server's raised client-wait floor ever
	 * elapses — exactly what made Prisma's original 40s wait and Vue's
	 * original 30s wait both dead code against the shared 30s default.
	 */
	it("gives every server's client wait headroom under the dispatch runner budget (#2233 F2)", () => {
		for (const s of LSP_SERVERS) {
			if (s.clientWaitTimeoutMs === undefined) continue;
			const required = s.clientWaitTimeoutMs + LSP_DIAGNOSTICS_WAIT_MS;
			expect(
				required,
				`${s.id}: clientWaitTimeoutMs (${s.clientWaitTimeoutMs}) + ` +
					`diagnostics wait (${LSP_DIAGNOSTICS_WAIT_MS}) = ${required} must ` +
					`fit under LSP_RUNNER_TIMEOUT_MS (${LSP_RUNNER_TIMEOUT_MS}) or the ` +
					`dispatcher kills the runner phase before the client wait can elapse`,
			).toBeLessThan(LSP_RUNNER_TIMEOUT_MS);
		}
	});
});
