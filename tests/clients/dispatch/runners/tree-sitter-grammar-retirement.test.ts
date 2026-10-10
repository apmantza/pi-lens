import { afterEach, beforeEach, describe, expect, it } from "vitest";
import treeSitterRunner from "../../../../clients/dispatch/runners/tree-sitter.js";
import { getSharedTreeSitterClient } from "../../../../clients/tree-sitter-shared.js";
import { resetDegradationLedger } from "../../../../clients/degradation-ledger.js";
import { makeRealRunnerEnv } from "../../../support/real-runner-ctx.js";

const { WebAssembly } = globalThis as unknown as {
	WebAssembly: { RuntimeError: new (message: string) => Error };
};

describe("tree-sitter runner grammar retirement (#4010)", () => {
	let cleanup: (() => void) | undefined;

	beforeEach(() => {
		resetDegradationLedger();
	});
	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
		resetDegradationLedger();
	});

	it("reports a retired grammar as unavailable, not clean (#4010)", async () => {
		const client = getSharedTreeSitterClient();
		expect(client).not.toBeNull();
		await client!.init();
		expect(await client!.isLanguageSupported("typescript")).toBe(true);
		// Two distinct inputs, each trapping once: the first-trap count retires.
		for (const source of ["runner-trap-a", "runner-trap-b"]) {
			client!.reportWasmAbort(
				new WebAssembly.RuntimeError("table index is out of bounds"),
				{ languageId: "typescript", source },
			);
		}

		const env = makeRealRunnerEnv();
		cleanup = env.cleanup;
		const result = await treeSitterRunner.run(
			env.addFile("retired.ts", "function f() { debugger; }\n").ctx,
		);

		expect(result).toEqual({
			status: "skipped",
			diagnostics: [],
			semantic: "none",
		});
	});
});
