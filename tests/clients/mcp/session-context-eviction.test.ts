/**
 * #1570: `getMcpSessionContext`'s `contextPromise ??= (async () => {...})()`
 * memo used to cache a REJECTED promise for the process lifetime. A single
 * transient failure while building the session context (e.g.
 * `loadBootstrapClients` hitting a momentary fs error) would permanently
 * break every later MCP call in the process — there is no session_start
 * boundary on the MCP path to re-arm anything, so eviction on rejection is
 * the only fix that lets a later call recover.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLspServiceDouble } from "../../support/lsp-service-double.js";

const loadBootstrapClients = vi.hoisted(() => vi.fn());

vi.mock("../../../clients/bootstrap.js", () => ({ loadBootstrapClients }));
vi.mock("../../../clients/ast-grep-client.js", () => ({
	AstGrepClient: class {},
}));
vi.mock("../../../clients/lsp/index.js", () => ({
	// `getMcpSessionContext` reads only `getAliveClientCount`; the rest of the
	// surface comes from the factory (#2592).
	getLSPService: () => makeLspServiceDouble({ getAliveClientCount: () => 0 }),
	resetLSPService: vi.fn(),
}));

// Static (module-load-time) import, not a dynamic `await import(...)` inside
// the it() body — a dynamic import's module-graph transform cost (measured
// 3.3-5.2s under contention) was charged against the per-test timeout and
// flaked. Mocks above still hoist ahead of this import (vitest hoists
// vi.mock calls regardless of import position), matching session.test.ts's
// pattern.
import {
	_resetMcpSessionContext,
	getMcpSessionContext,
} from "../../../clients/mcp/session.js";

beforeEach(() => {
	loadBootstrapClients.mockReset();
});

afterEach(() => {
	vi.resetModules();
});

describe("getMcpSessionContext memo eviction (#1570)", () => {
	it("retries after a rejected build instead of replaying the same rejection forever", async () => {
		_resetMcpSessionContext();

		loadBootstrapClients.mockRejectedValueOnce(
			new Error("EMFILE: transient fs error"),
		);
		await expect(getMcpSessionContext()).rejects.toThrow(
			"EMFILE: transient fs error",
		);

		loadBootstrapClients.mockResolvedValueOnce({ __stub: "clients" });
		const context = await getMcpSessionContext();
		expect(context.clients).toEqual({ __stub: "clients" });

		// The memo stays hot after a success — a THIRD call must not re-invoke
		// the loader.
		const again = await getMcpSessionContext();
		expect(again).toBe(context);
		expect(loadBootstrapClients).toHaveBeenCalledTimes(2);
	});
});
