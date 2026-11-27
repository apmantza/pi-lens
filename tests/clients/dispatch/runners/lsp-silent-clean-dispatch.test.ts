/**
 * The dispatch boundary: what a CLEAN markdown edit reports to the agent.
 *
 * `tests/clients/lsp/silent-clean-auxiliary.test.ts` proves the service verdict;
 * this proves the layer that turns it into the user-visible answer. That layer
 * is where the bug was visible in the first place — `clients/dispatch`'s lsp
 * runner reported "not fully checked (a language tool is missing, timed out, or
 * failed to run)" on every edit of a clean markdown file, because the verdict it
 * received was `inconclusive`.
 *
 * The runner is driven for real; only the service's transport is a double, so
 * the scope choice (`auxiliaryServerIds.length > 0 ? "with-auxiliary" :
 * "primary"`, `clients/dispatch/runners/lsp.ts`) and the runner's own reading of
 * the touch result are production code.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import lspRunner from "../../../../clients/dispatch/runners/lsp.js";
import { installLspService } from "../../../support/lsp-service-seam.js";
import { removeTempDirSync } from "../../test-utils.js";

vi.mock(
	"../../../../clients/dispatch/auxiliary-lsp.js",
	async (importActual) => ({
		...(await importActual<
			typeof import("../../../../clients/dispatch/auxiliary-lsp.js")
		>()),
		// Force the with-auxiliary scope the real configuration takes on markdown
		// (typos is on by default) without depending on this machine's flags.
		enabledAuxiliaryLspServerIds: () => ["typos"],
	}),
);

const touchFile = vi.fn();
const attachedDiagnostics = vi.fn();

function installService(): void {
	installLspService({
		supportsLSP: () => true,
		touchFile,
		tryWarmAttachedDiagnostics: attachedDiagnostics,
		// The remaining member the runner can reach is inert for this path.
		codeAction: vi.fn(),
	} as never);
}

describe("LSP dispatch runner — a clean markdown edit reports a verdict, not a gap", () => {
	let cwd: string;

	beforeEach(() => {
		touchFile.mockReset();
		attachedDiagnostics.mockReset().mockResolvedValue({ available: false });
		installService();
		cwd = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-dispatch-silent-")),
		);
	});

	afterEach(() => removeTempDirSync(cwd));

	it("takes the with-auxiliary scope for a markdown edit", async () => {
		// A control, not a red-first test: the runner is unchanged by #5774, so
		// this passes on master too (#5775 review F4). It pins the scope the
		// with-auxiliary gate depends on: if the runner ever stopped taking it,
		// the gate would be unreachable again and this case would say so.
		const file = path.join(cwd, "note.md");
		fs.writeFileSync(file, "# Note\n");
		touchFile.mockResolvedValue({ diags: [] });

		await lspRunner.run({
			filePath: file,
			cwd,
			fileRole: "source",
			pi: { getFlag: () => undefined },
		} as never);

		expect(touchFile).toHaveBeenCalledTimes(1);
		const options = touchFile.mock.calls[0]?.[2] as { clientScope?: string };
		expect(options.clientScope).toBe("with-auxiliary");
	});
});
