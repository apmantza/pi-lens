import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKnipCommand } from "../../scripts/lib/knip-command.mjs";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * A throwaway `<pkgName>`-rooted "package" with `entry.js` nested one level
 * under its package.json, so `deps.resolve` can point straight at the entry
 * file the way a real `require.resolve("knip")` would.
 */
function fakePackage(pkgJson: Record<string, unknown>): string {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-knip-command-2698-"),
	);
	tempDirs.push(root);
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkgJson));
	fs.mkdirSync(path.join(root, "nested"));
	const entry = path.join(root, "nested", "entry.js");
	fs.writeFileSync(entry, "// fake entry\n");
	return entry;
}

describe("resolveKnipCommand (#2698 review rounds 2-3)", () => {
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
		const entry = fakePackage({
			name: "knip",
			bin: { "knip-bun": "bin/knip-bun.js" },
		});
		expect(() => resolveKnipCommand([], { resolve: () => entry })).toThrow(
			/no "knip" bin entry/,
		);
	});

	// #2698 review round 3, R2-F4, red-first: nothing checked that the
	// resolved package.json actually BELONGS to knip. A nearer package.json
	// with a string `bin` (not knip's own `{knip: ..., "knip-bun": ...}`
	// object form) would resolve silently and wrongly — not reachable with
	// the real installed knip@6.34.0 (its dist/ has no package.json to stop
	// the upward walk at early), but a fixture reproduces the shape exactly.
	it('throws when the resolved package.json\'s "name" is not "knip" (string-bin branch)', () => {
		const entry = fakePackage({ name: "not-knip", bin: "cli.js" });
		expect(() => resolveKnipCommand([], { resolve: () => entry })).toThrow(
			/"name" is "not-knip", not "knip"/,
		);
	});

	it('throws when the resolved package.json\'s "name" is not "knip" (object-bin branch)', () => {
		const entry = fakePackage({
			name: "not-knip",
			bin: { knip: "cli.js" },
		});
		expect(() => resolveKnipCommand([], { resolve: () => entry })).toThrow(
			/"name" is "not-knip", not "knip"/,
		);
	});
});
