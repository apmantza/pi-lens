import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isProjectLocalLspBinary } from "../../../clients/lsp/launch.js";
import { PROJECT_LOCAL_BIN_DIRS } from "../../../clients/package-manager.js";

describe("project-local LSP binary classifier (#4248 R3-1)", () => {
	it("tracks every canonical local-bin resolver layout", () => {
		const project = path.join(os.tmpdir(), "pi-lens-project-local-bin");
		for (const binDir of PROJECT_LOCAL_BIN_DIRS) {
			// Recurrence: adding a resolver layout without adding the trust admission
			// lets an unknown-trust project-local LSP binary spawn.
			expect(
				isProjectLocalLspBinary(path.join(project, binDir, "python"), project),
				binDir,
			).toBe(true);
		}
	});
});
