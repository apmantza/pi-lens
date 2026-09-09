// Shape (a): SHORTHAND properties. The method names never appear next to a
// `vi.fn(` literal at all, so the round-1 regex found nothing. Live in
// tests/tools/lsp-diagnostics-per-server-concurrency.test.ts and
// tests/clients/runtime-session-warm.test.ts before #2582 round 2.
import { vi } from "vitest";

const touchFile = vi.fn();
const openFile = vi.fn();
const supportsLSP = vi.fn(() => true);

vi.mock("../../../clients/lsp/index.js", () => ({
	getLSPService: () => ({ supportsLSP, touchFile, openFile }),
}));
