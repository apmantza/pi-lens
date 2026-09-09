// COMPLIANT: the factory's documented usage. A focused `vi.fn()` override on a
// seeded object is the whole point of the factory — a detector that flagged
// this would push authors back to hand-rolling, which is how round 1 ended up
// laundering identifiers.
import { vi } from "vitest";
import { makeLspServiceDouble } from "../../support/lsp-service-double.js";
import { getLSPService } from "../../../clients/lsp/index.js";

vi.mock("../../../clients/lsp/index.js", () => ({
	getLSPService: vi.fn(() =>
		makeLspServiceDouble({ touchFile: vi.fn(), supportsLSP: () => true }),
	),
}));

const spread = { ...makeLspServiceDouble(), touchFile: vi.fn() };
vi.mocked(getLSPService).mockReturnValue(spread as never);

const seeded = makeLspServiceDouble();
seeded.touchFile = vi.fn();
vi.mocked(getLSPService).mockReturnValue(seeded as never);
