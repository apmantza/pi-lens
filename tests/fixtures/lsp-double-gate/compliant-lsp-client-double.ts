// COMPLIANT, and the reason the detector is anchored on the `getLSPService`
// seam rather than on a method-name vocabulary: a fake LSP *client* shares
// `openFile`/`getDiagnostics`/`documentSymbol` with the service but is a
// DIFFERENT seam (`createLSPClient`) with its own factory story. The
// vocabulary-only cut of this gate flagged 159 of these across 65 files in
// tests/clients/lsp/*.
import { vi } from "vitest";

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient: vi.fn(async () => ({
		openFile: vi.fn(),
		getDiagnostics: vi.fn(() => []),
		documentSymbol: vi.fn(async () => []),
		references: vi.fn(async () => []),
	})),
}));
