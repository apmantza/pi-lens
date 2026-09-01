import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getServersForFileWithConfig } from "../../../clients/lsp/config.js";
import { LSP_SERVERS } from "../../../clients/lsp/server.js";
// Typed via scripts/smoke-tools.d.mts (the harness itself is plain ESM JS).
import { LSP_FIXTURES } from "../../../scripts/smoke-tools.mjs";
import { assertNonEmptyScan } from "../../support/sweep-kit.js";

/**
 * Nightly LSP handshake coverage drift guard (#274/#278 follow-through).
 *
 * `scripts/smoke-tools.mjs --lsp` installs, spawns, and verifies the JSON-RPC
 * initialize handshake for each server in `LSP_FIXTURES`. That list is
 * hand-maintained, and the runner-level `smoke-fixture-coverage` guard blanket-
 * exempts the single `lsp` runner — so a newly REGISTERED server gets ZERO
 * nightly handshake coverage and nothing complains. That gap left markdown's
 * marksman (#274) untested until caught by hand, and would have silently left
 * PowerShell's PSES (#278) untested too.
 *
 * This guard closes it structurally: every non-auxiliary server must route to a
 * `LSP_FIXTURES` entry (or be an explicitly-exempt alternate), and every
 * auxiliary server must be exercised via a fixture's `auxiliaryServerIds`. A new
 * server now forces a decision — add a fixture, or exempt it with a reason.
 */

// A fallback shares the preferred server's fixture because the --lsp layer
// exercises the preferred handshake. The fallback is reached only by
// availability fallthrough or an lsp.json override.
const EXEMPT_PRIMARY = new Map(
	LSP_SERVERS.filter(
		(server) => server.role !== "auxiliary" && server.fallbackFor !== undefined,
	).map((server) => [
		server.id,
		`fallback of ${server.fallbackFor}; the preferred handshake covers the default`,
	]),
);

// Faithful to getClientForFile's candidate stage: resolve each fixture file to
// its primary server (first non-auxiliary match in registry/config order). A
// synthetic absolute path avoids picking up any real .pi-lens/lsp.json from cwd.
function primaryServerIdFor(file: string): string | undefined {
	const probe = `/proj/${path.basename(file)}`;
	return getServersForFileWithConfig(probe).filter(
		(s) => s.role !== "auxiliary",
	)[0]?.id;
}

const NON_AUX = LSP_SERVERS.filter((s) => s.role !== "auxiliary");
const AUX = LSP_SERVERS.filter((s) => s.role === "auxiliary");
// Calibration: 45 servers and 49 fixtures on 2026-08-26; floors are half,
// rounded up, to keep a materially narrowed registry from reading as clean.
assertNonEmptyScan("LSP_SERVERS registry", LSP_SERVERS.length, 20);
assertNonEmptyScan("LSP_FIXTURES registry", LSP_FIXTURES.length, 22);

const coveredPrimary = new Set<string>();
const coveredAux = new Set<string>();
for (const fx of LSP_FIXTURES) {
	const id = primaryServerIdFor(fx.file);
	if (id) coveredPrimary.add(id);
	for (const auxId of fx.auxiliaryServerIds ?? []) coveredAux.add(auxId);
}

describe("LSP handshake fixture coverage (nightly --lsp)", () => {
	it("every non-auxiliary server has an --lsp handshake fixture (or is an exempt alternate)", () => {
		const uncovered = NON_AUX.filter(
			(s) => !coveredPrimary.has(s.id) && !EXEMPT_PRIMARY.has(s.id),
		).map((s) => s.id);
		expect(
			uncovered,
			`registered primary LSP server(s) with NO nightly handshake fixture — add an ` +
				`LSP_FIXTURES entry in scripts/smoke-tools.mjs (a fixture file whose extension ` +
				`routes to the server) so the server is install→spawn→handshake smoke-tested, ` +
				`or exempt it with a reason: ${uncovered.join(", ")}`,
		).toEqual([]);
	});

	it("every auxiliary server is exercised by a fixture's auxiliaryServerIds", () => {
		const uncovered = AUX.filter((s) => !coveredAux.has(s.id)).map((s) => s.id);
		expect(
			uncovered,
			`auxiliary LSP server(s) not attached by any --lsp fixture — add an LSP_FIXTURES ` +
				`entry with auxiliaryServerIds: [...]: ${uncovered.join(", ")}`,
		).toEqual([]);
	});

	it("no stale primary exemptions (every exempted id is still a registered server)", () => {
		const ids = new Set(LSP_SERVERS.map((s) => s.id));
		const stale = [...EXEMPT_PRIMARY.keys()].filter((id) => !ids.has(id));
		expect(
			stale,
			`exemption(s) for non-existent server(s): ${stale.join(", ")}`,
		).toEqual([]);
	});
});
