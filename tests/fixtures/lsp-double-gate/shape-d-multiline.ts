// Shape (d): the same literal the round-1 regex was written for, split across
// a newline. `/touchFile\s*:\s*vi\.fn\s*\(/` requires no whitespace INSIDE
// `vi.fn`, so this produced zero matches.
import { vi } from "vitest";

vi.mock("../../../clients/lsp/index.js", () => ({
	getLSPService: () => ({
		supportsLSP: () => true,
		touchFile: vi
			.fn(async () => ({ diags: [] })),
	}),
}));
