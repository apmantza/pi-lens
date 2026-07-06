import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// #402 — the `typescript` compiler is a devDependency-ONLY build tool (tsc), not a
// runtime dependency. Users install with `npm install --omit=dev`, so ANY runtime
// import of `typescript` (static OR dynamic) would throw at their runtime. Scan the
// shipped source and assert nothing imports it. (Previously typescript was a runtime
// dep kept out of the eager graph via a lazy accessor; the whole `deps/typescript`
// shim + its 5 compiler-backed consumers were removed in #402.)
const RUNTIME_DIRS = ["clients", "tools", "mcp", "commands"];
const ROOT_FILES = ["index.ts", "i18n.ts"];

// import ... from "typescript" | import("typescript") | require("typescript")
const TS_IMPORT = /(?:from|import|require)\s*\(?\s*["']typescript["']/;

function* walkTs(dir: string): Generator<string> {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const p = path.join(dir, entry);
		if (statSync(p).isDirectory()) {
			if (entry === "node_modules") continue;
			yield* walkTs(p);
		} else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
			yield p;
		}
	}
}

describe("typescript is devDependency-only, never imported at runtime (#402)", () => {
	it("no shipped source file imports the typescript compiler", () => {
		const files = [
			...ROOT_FILES.map((f) => path.join(root, f)),
			...RUNTIME_DIRS.flatMap((d) => [...walkTs(path.join(root, d))]),
		];
		const offenders = files
			.filter((f) => TS_IMPORT.test(readFileSync(f, "utf8")))
			.map((f) => path.relative(root, f).replace(/\\/g, "/"));
		expect(offenders).toEqual([]);
	});
});
