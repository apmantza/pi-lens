// Shape (c): the seam receives a binding this module never builds a literal
// for — the stub comes from another module — and the LSPService surface is
// bolted on afterwards, one property at a time. The object-literal rule sees
// nothing here (there is no literal to see), so this fixture is what makes the
// post-hoc-assignment rule load-bearing: a mutation probe that deletes that
// rule turns THIS case red and nothing else.
import { vi } from "vitest";
import { getLSPService } from "../../../clients/lsp/index.js";
import { createHostServiceStub } from "./external-stub-factory.js";

const service = createHostServiceStub();
service.touchFile = vi.fn(async () => ({ diags: [] }));
service.supportsLSP = vi.fn(() => true);

vi.mocked(getLSPService).mockReturnValue(service as never);
