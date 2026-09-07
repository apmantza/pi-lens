import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveKnipCommand } from "../../scripts/lib/knip-command.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("resolveKnipCommand (#2698 review round 2, F2)", () => {
	it("resolves knip's real bin/knip.js entry via process.execPath, not node_modules/.bin's shim", () => {
		const { command, args } = resolveKnipCommand(["--reporter", "json"]);
		expect(command).toBe(process.execPath);
		expect(args[0]).toMatch(/knip[\\/]bin[\\/]knip\.js$/);
		expect(args.slice(1)).toEqual(["--reporter", "json"]);
	});

	it("is platform-invariant — forcing process.platform to win32 changes nothing (shape 30 guard: no module-load platform const, no live-read branch to force)", () => {
		const before = resolveKnipCommand([]);
		const original = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});
		try {
			expect(resolveKnipCommand([])).toEqual(before);
		} finally {
			Object.defineProperty(process, "platform", original);
		}
	});

	it('throws a clear error when the resolved package.json has no "knip" bin entry', () => {
		// pi-lens's own package.json has a `bin` field, but no `knip` key —
		// exercises the missing-entry branch without a second fake npm
		// package. Points `resolve("knip")` at pi-lens's package.json
		// directly (findPackageJsonUpward finds it immediately, one dirname
		// call up and back).
		expect(() =>
			resolveKnipCommand([], {
				resolve: () => resolve(repoRoot, "package.json"),
			}),
		).toThrow(/no "knip" bin entry/);
	});
});
