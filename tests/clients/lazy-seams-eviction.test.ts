/**
 * #1570 per-site regression: each named lazy-import seam
 * (clients/lsp-lazy.ts, clients/formatters-lazy.ts, clients/dispatch/lazy.ts)
 * used its own hand-rolled `x ??= import(...)` memo, which cached a REJECTED
 * promise for the process lifetime once the underlying dynamic import
 * failed. Each now wraps `createLazyImport`, which evicts on rejection so
 * the next demand retries.
 *
 * The underlying `import("./lsp/index.js")` etc. call is mocked via
 * vi.doMock on the SAME module the seam imports, so this exercises the real
 * module-level memo variable, not a copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lspAttempts = vi.hoisted(() => ({ count: 0 }));
const formattersAttempts = vi.hoisted(() => ({ count: 0 }));
const dispatchAttempts = vi.hoisted(() => ({ count: 0 }));

beforeEach(() => {
	lspAttempts.count = 0;
	formattersAttempts.count = 0;
	dispatchAttempts.count = 0;
});

afterEach(() => {
	vi.doUnmock("../../clients/lsp/capabilities.js");
	vi.doUnmock("../../clients/formatters.js");
	vi.doUnmock("../../clients/dispatch/integration.js");
	vi.resetModules();
});

describe("lazy-import seam eviction (#1570)", () => {
	it("clients/lsp-lazy.ts retries loadLspService after a rejected import", async () => {
		vi.resetModules();
		vi.doMock("../../clients/lsp/capabilities.js", async () => {
			lspAttempts.count += 1;
			if (lspAttempts.count === 1) {
				return Promise.reject(new Error("EMFILE: transient fs error"));
			}
			return { __stub: "lsp-index" };
		});

		const { loadLspService } = await import("../../clients/lsp-lazy.js");

		// vitest wraps a mock-factory rejection in a helper error; the original
		// EMFILE cause is preserved on `.cause` (see @vitest/mocker's
		// createHelpfulError). The eviction contract under test is: the first
		// call rejects, and the SECOND call retries rather than replaying it.
		await expect(loadLspService()).rejects.toMatchObject({
			cause: expect.objectContaining({
				message: expect.stringContaining("EMFILE: transient fs error"),
			}),
		});
		await expect(loadLspService()).resolves.toEqual({ __stub: "lsp-index" });
		expect(lspAttempts.count).toBe(2);
	});

	it("clients/formatters-lazy.ts retries loadFormatters after a rejected import", async () => {
		vi.resetModules();
		vi.doMock("../../clients/formatters.js", async () => {
			formattersAttempts.count += 1;
			if (formattersAttempts.count === 1) {
				return Promise.reject(new Error("EMFILE: transient fs error"));
			}
			return { __stub: "formatters" };
		});

		const { loadFormatters } = await import("../../clients/formatters-lazy.js");

		await expect(loadFormatters()).rejects.toMatchObject({
			cause: expect.objectContaining({
				message: expect.stringContaining("EMFILE: transient fs error"),
			}),
		});
		await expect(loadFormatters()).resolves.toEqual({ __stub: "formatters" });
		expect(formattersAttempts.count).toBe(2);
	});

	it("clients/dispatch/lazy.ts retries loadDispatchIntegration after a rejected import", async () => {
		vi.resetModules();
		vi.doMock("../../clients/dispatch/integration.js", async () => {
			dispatchAttempts.count += 1;
			if (dispatchAttempts.count === 1) {
				return Promise.reject(new Error("EMFILE: transient fs error"));
			}
			return { __stub: "dispatch-integration" };
		});

		const { loadDispatchIntegration } =
			await import("../../clients/dispatch/lazy.js");

		await expect(loadDispatchIntegration()).rejects.toMatchObject({
			cause: expect.objectContaining({
				message: expect.stringContaining("EMFILE: transient fs error"),
			}),
		});
		await expect(loadDispatchIntegration()).resolves.toEqual({
			__stub: "dispatch-integration",
		});
		expect(dispatchAttempts.count).toBe(2);
	});
});
