import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The kernel's `realpath` is the filesystem boundary the PATH judgement pays
// at; counting it pins how often one scan resolves, without a wall clock.
const realpathCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	const native = (...args: Parameters<typeof actual.realpathSync.native>) => {
		realpathCalls.count += 1;
		return actual.realpathSync.native(...args);
	};
	const realpathSync = Object.assign(
		(...args: Parameters<typeof actual.realpathSync>) =>
			actual.realpathSync(...args),
		{ native },
	);
	return { ...actual, realpathSync, default: { ...actual, realpathSync } };
});

import { commandSearchReachesProject } from "../../clients/package-manager.js";
import { setProjectTrustState } from "../../clients/project-trust.js";

const ENTRIES = 20;
const originalPath = process.env.PATH;
let scratch: string;

beforeEach(() => {
	scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5674-judge-"));
	setProjectTrustState("trusted");
});

afterEach(() => {
	process.env.PATH = originalPath;
	fs.rmSync(scratch, { recursive: true, force: true });
});

describe("PATH judgement cost for a root (#5678 verify V2)", () => {
	it("resolves each entry once per scan, whatever the root's depth", () => {
		// Recurrence: #5678 verify V2. The per-entry check re-walked the bin
		// dirs of the root and every ancestor and resolved each of them, so one
		// scan cost entries x depth x layouts resolutions (an unadmitted root's
		// launch of 10 absent candidates went from about 40 ms to 1.1 s).
		let root = path.join(scratch, "tree");
		for (let level = 0; level < 8; level += 1)
			root = path.join(root, `d${level}`);
		root = path.join(root, "proj");
		fs.mkdirSync(root, { recursive: true });
		const scanCost = (count: number): number => {
			process.env.PATH = Array.from({ length: count }, (_, index) => {
				const dir = path.join(scratch, "global", `bin${index}`);
				fs.mkdirSync(dir, { recursive: true });
				return dir;
			}).join(path.delimiter);
			realpathCalls.count = 0;
			expect(commandSearchReachesProject(root)).toBe(false);
			return realpathCalls.count;
		};

		// The root's walk is paid once per scan; each further entry costs its
		// own two forms (spelling and identity), nothing per bin dir.
		const perEntry = (scanCost(2 * ENTRIES) - scanCost(ENTRIES)) / ENTRIES;
		expect(perEntry).toBeLessThanOrEqual(2);
	});
});
