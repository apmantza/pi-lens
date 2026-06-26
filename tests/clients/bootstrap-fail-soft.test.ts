import { describe, expect, it } from "vitest";
import { degradedClient } from "../../clients/bootstrap.js";

// Fail-soft is consolidated in ONE seam (the bootstrap): when an analyzer's
// module can't load (an unresolved runtime dep — #285/#335), it's replaced by a
// degradedClient stub so the rest still load and consumers never special-case
// the absence. This pins the stub's contract: every call no-ops to `undefined`
// and NEVER throws, and it doesn't masquerade as a promise/iterable.
interface FakeClient {
	isSupportedFile(p: string): boolean;
	analyzeFile(p: string): { score: number } | null;
	recordToolCall(a: string, b: string): void;
}

describe("degradedClient (single-seam fail-soft stub)", () => {
	it("no-ops every method to undefined and never throws", () => {
		const stub = degradedClient<FakeClient>();
		expect(() => stub.isSupportedFile("x.ts")).not.toThrow();
		expect(stub.isSupportedFile("x.ts")).toBeUndefined();
		expect(stub.analyzeFile("x.ts")).toBeUndefined();
		expect(stub.recordToolCall("write", "x.ts")).toBeUndefined();
	});

	it("is not thenable (won't be mistaken for a promise when awaited)", () => {
		const stub = degradedClient<FakeClient>();
		expect((stub as unknown as { then?: unknown }).then).toBeUndefined();
	});

	it("is not iterable (won't break a spread/for-of)", () => {
		const stub = degradedClient<FakeClient>();
		expect(
			(stub as unknown as { [Symbol.iterator]?: unknown })[Symbol.iterator],
		).toBeUndefined();
	});
});
