import { describe, expect, it, vi } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";
import {
	adaptLspService,
	getLSPService,
	type LspCapabilities,
} from "../../../clients/lsp/capabilities.js";

describe("LspCapabilities adapter", () => {
	it("forwards flat and grouped calls to the same service", () => {
		const service = new LSPService();
		const getAliveServerIds = vi
			.spyOn(service, "getAliveServerIds")
			.mockReturnValue(["ts"]);
		const facade = adaptLspService(service);

		expect(facade.getAliveServerIds()).toEqual(["ts"]);
		expect(facade.clients?.getAliveServerIds()).toEqual(["ts"]);
		expect(facade.clients?.getAliveServerIds).toBeDefined();
		expect(getAliveServerIds).toHaveBeenCalledTimes(2);
		expect(adaptLspService(service)).toBe(facade);
	});

	it("keeps the singleton lifecycle compatibility export on the facade", () => {
		const facade: LspCapabilities = getLSPService();
		expect(facade.documents).toBeDefined();
		expect(facade.diagnostics).toBeDefined();
		expect(facade.navigation).toBeDefined();
		expect(facade.workspace).toBeDefined();
	});
});
