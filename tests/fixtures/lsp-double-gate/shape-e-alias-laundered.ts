// Shape (e): identifier laundering — the attack the round-1 sweep shipped 28
// of in cascade-compute.test.ts to keep itself green. Renaming `vi.fn` changes
// nothing at runtime and everything for a text scan.
import { vi } from "vitest";

const makeTouchFileMock = vi.fn;

vi.mock("../../../clients/lsp/index.js", () => ({
	getLSPService: () => ({
		supportsLSP: () => true,
		touchFile: makeTouchFileMock(),
	}),
}));
