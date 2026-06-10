/**
 * Unit test for the build-freshness guard (#198). The guard runs as a vitest
 * globalSetup; if it ever silently stopped detecting staleness it would
 * reintroduce the exact bug it exists to prevent (tests passing against stale
 * in-place compiled `.js`), so its detection logic is exercised here against a
 * controlled temp fixture with explicit mtimes.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findStaleCompiledSources } from "./support/check-build-freshness.js";

let root: string;
const older = new Date("2020-01-01T00:00:00Z");
const newer = new Date("2020-01-02T00:00:00Z");

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pi-lens-freshness-"));
	const clients = join(root, "clients");
	mkdirSync(clients, { recursive: true });

	const write = (rel: string, ts: Date) => {
		const p = join(root, rel);
		writeFileSync(p, "");
		utimesSync(p, ts, ts);
	};

	// fresh: .js newer than .ts → not stale
	write("clients/fresh.ts", older);
	write("clients/fresh.js", newer);
	// stale: .ts newer than .js → stale
	write("clients/stale.js", older);
	write("clients/stale.ts", newer);
	// missing: source with no compiled .js → stale
	write("clients/missing.ts", newer);
	// must be ignored (not compiled in place)
	write("clients/thing.test.ts", newer);
	write("clients/thing.d.ts", newer);
	// root file, fresh
	write("index.js", newer);
	write("index.ts", older);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("findStaleCompiledSources (#198 build-freshness guard)", () => {
	const run = () =>
		findStaleCompiledSources({
			root,
			dirs: ["clients"],
			rootFiles: ["index.ts"],
		}).map((p) => p.replace(/\\/g, "/"));

	it("flags a source whose compiled .js is older", () => {
		expect(run().some((p) => p.endsWith("clients/stale.ts"))).toBe(true);
	});

	it("flags a source with no compiled .js", () => {
		expect(run().some((p) => p.endsWith("clients/missing.ts"))).toBe(true);
	});

	it("does not flag a fresh source (.js newer than .ts)", () => {
		const r = run();
		expect(r.some((p) => p.endsWith("clients/fresh.ts"))).toBe(false);
		expect(r.some((p) => p.endsWith("index.ts"))).toBe(false);
	});

	it("ignores .test.ts and .d.ts (excluded from the in-place build)", () => {
		const r = run();
		expect(r.some((p) => p.includes("thing.test.ts"))).toBe(false);
		expect(r.some((p) => p.includes("thing.d.ts"))).toBe(false);
	});
});
