// Shape (b): a plain async stub, no `vi.fn` anywhere. Live in
// tests/clients/write-autofix-attachment-message.test.ts before #2582 round 2.
import { vi } from "vitest";

vi.mock("../../../clients/lsp/capabilities.js", () => ({
	getLSPService: () => ({
		supportsLSP: () => false,
		touchFile: async () => ({ diags: [] }),
		getAllDiagnostics: async () => new Map(),
	}),
}));
