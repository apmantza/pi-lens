// flake-shape: real-process-spawn — the CLI's actual exit code (2/3/4) and
// its GITHUB_OUTPUT side effect are the subject under test; an in-process
// stub of resolve-newest-in-range-host.mjs would just re-assert whatever
// exit code the test author typed, not what the script actually does on a
// bad usage, an unreachable registry, or an empty semver match (#2613).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	pickNewestInRange,
	readPeerRange,
	readSupportedRangeEnv,
} from "../../scripts/lib/resolve-newest-in-range-host.mjs";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const CLI = path.join(REPO_ROOT, "scripts/resolve-newest-in-range-host.mjs");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// Pure selection logic — no live registry, no fs, no child_process (#2613).
describe("pickNewestInRange (#2613)", () => {
	it("picks the highest version in an `||` range, ignoring the next minor", () => {
		// The exact range shape #2588 produced for pi-tui: two explicitly
		// endorsed minors, joined with `||` rather than a >=/< span.
		const versions = [
			"0.83.0",
			"0.84.0",
			"0.84.1",
			"0.84.9",
			"0.85.0",
			"0.85.1",
			"0.85.9",
			"0.86.0",
			"0.86.1",
		];
		expect(pickNewestInRange(versions, "^0.84.1 || ^0.85.0")).toBe("0.85.9");
	});

	it("excludes prereleases even when they are numerically newer", () => {
		const versions = ["0.85.9", "0.85.10-beta.0", "0.86.0"];
		expect(pickNewestInRange(versions, "^0.84.1 || ^0.85.0")).toBe("0.85.9");
	});

	it("returns null when nothing published satisfies the range", () => {
		const versions = ["0.80.10", "0.81.0"];
		expect(pickNewestInRange(versions, "^0.90.0")).toBeNull();
	});

	// Review S1: a single wildcard range alone IS unbounded (this repo's
	// actual pi-coding-agent peer spec today) -- the guard against that is a
	// SECOND range, not this function refusing "*" outright.
	it("a lone wildcard range is unbounded on its own", () => {
		expect(pickNewestInRange(["0.84.1", "0.85.1", "9.9.9"], "*")).toBe("9.9.9");
	});

	// Review S1: intersecting a wildcard peer range with a repo-owned
	// supported-range ceiling keeps the pick bounded -- the whole point of
	// the two-range (AND) form. A version the wildcard alone would admit
	// (9.9.9) must be excluded once the second range rejects it.
	it("a wildcard peer range does NOT make the lane unbounded once intersected with a supported-range ceiling", () => {
		const versions = ["0.80.10", "0.85.1", "9.9.9"];
		expect(pickNewestInRange(versions, ["*", ">=0.80.10 <0.86.0"])).toBe(
			"0.85.1",
		);
	});

	it("intersecting two ranges excludes a version either range alone would admit", () => {
		const versions = ["0.84.1", "0.85.9", "0.90.0"];
		// "^0.84.1 || ^0.85.0" alone admits 0.85.9; ">=0.80.10 <0.85.0" alone
		// admits 0.84.1. Neither alone admits both AND excludes 0.90.0 the way
		// their intersection does.
		expect(
			pickNewestInRange(versions, ["^0.84.1 || ^0.85.0", ">=0.80.10 <0.85.5"]),
		).toBe("0.84.1");
	});
});

describe("readPeerRange (#2613)", () => {
	it("reads the declared range for the named package", () => {
		const pkg = { peerDependencies: { demo: "^1.0.0" } };
		expect(readPeerRange(pkg, "demo")).toBe("^1.0.0");
	});

	it("throws when the package has no declared peer range", () => {
		expect(() => readPeerRange({ peerDependencies: {} }, "demo")).toThrow(
			/no peerDependencies/,
		);
	});
});

describe("readSupportedRangeEnv (#2613 review S1)", () => {
	it("reads the configured ceiling", () => {
		expect(
			readSupportedRangeEnv({ PI_HOST_SUPPORTED_RANGE: ">=0.80.10 <0.86.0" }),
		).toBe(">=0.80.10 <0.86.0");
	});

	it("throws when the env var is unset", () => {
		expect(() => readSupportedRangeEnv({})).toThrow(
			/PI_HOST_SUPPORTED_RANGE is required/,
		);
	});

	it("throws when the env var is empty", () => {
		expect(() =>
			readSupportedRangeEnv({ PI_HOST_SUPPORTED_RANGE: "  " }),
		).toThrow(/PI_HOST_SUPPORTED_RANGE is required/);
	});
});

function fixtureRoot(peerRange: string) {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-newest-in-range-"),
	);
	tempDirs.push(root);
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({
			name: "fixture",
			peerDependencies: { "@earendil-works/pi-coding-agent": peerRange },
		}),
	);
	return root;
}

// A stub `npm` on PATH ahead of the real one, so the CLI's `npm view --json`
// call is hermetic (no live registry) while still exercising the real
// execFileSync spawn path end to end. `failTimes` makes the stub fail that
// many times before succeeding (or forever, for the exhaustion case) —
// tracked via a counter file so it survives across the CLI's separate
// retry-attempt spawns.
function stubNpm(
	root: string,
	versionsJson: string,
	opts: { failTimes?: number } = {},
) {
	const binDir = path.join(root, "bin");
	fs.mkdirSync(binDir);
	const npmStub = path.join(binDir, "npm");
	const counterFile = path.join(root, ".npm-stub-calls");
	fs.writeFileSync(counterFile, "0");
	const failTimes = opts.failTimes ?? 0;
	fs.writeFileSync(
		npmStub,
		[
			"#!/usr/bin/env node",
			`const fs = require("fs");`,
			`const counterFile = ${JSON.stringify(counterFile)};`,
			`const n = Number(fs.readFileSync(counterFile, "utf8")) + 1;`,
			`fs.writeFileSync(counterFile, String(n));`,
			`if (n <= ${failTimes}) { process.stderr.write("stub: simulated registry failure\\n"); process.exit(1); }`,
			`process.stdout.write(${JSON.stringify(versionsJson)});`,
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	return { binDir, counterFile };
}

function runCli(
	root: string,
	binDir: string,
	args: string[],
	extraEnv: Record<string, string> = {},
) {
	return execFileSync(process.execPath, [CLI, ...args], {
		cwd: root,
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH}`,
			PI_HOST_SUPPORTED_RANGE: ">=0.80.10 <0.90.0",
			// Instant retries — see the CLI's own comment on this var. Real
			// backoff timing is not this test's subject; the retry COUNT and
			// eventual outcome are.
			RESOLVE_NEWEST_RETRY_BACKOFF_MS: "0,0,0",
			...extraEnv,
		},
		encoding: "utf-8",
	});
}

describe("resolve-newest-in-range-host.mjs CLI (#2613)", () => {
	it("prints the resolved version and writes GITHUB_OUTPUT", () => {
		const root = fixtureRoot("^0.84.1 || ^0.85.0");
		const { binDir } = stubNpm(
			root,
			JSON.stringify(["0.84.1", "0.85.0", "0.85.9", "0.86.0"]),
		);
		const outputFile = path.join(root, "gh-output");
		fs.writeFileSync(outputFile, "");
		const stdout = runCli(root, binDir, ["@earendil-works/pi-coding-agent"], {
			GITHUB_OUTPUT: outputFile,
		});
		expect(stdout.trim()).toBe("0.85.9");
		expect(fs.readFileSync(outputFile, "utf-8")).toBe("version=0.85.9\n");
	});

	// Review S1: the peer range alone ("*") would admit 9.9.9, but the
	// supported-range env ceiling this test sets (>=0.80.10 <0.90.0) must
	// exclude it -- proving the wildcard case is bounded end to end through
	// the real CLI, not just the pure function.
	it("bounds a wildcard peer range by the PI_HOST_SUPPORTED_RANGE ceiling", () => {
		const root = fixtureRoot("*");
		const { binDir } = stubNpm(
			root,
			JSON.stringify(["0.80.10", "0.85.1", "9.9.9"]),
		);
		const stdout = runCli(root, binDir, ["@earendil-works/pi-coding-agent"]);
		expect(stdout.trim()).toBe("0.85.1");
	});

	it("exits 4 with a message when PI_HOST_SUPPORTED_RANGE is unset", () => {
		const root = fixtureRoot("^0.84.1 || ^0.85.0");
		const { binDir } = stubNpm(root, JSON.stringify(["0.85.1"]));
		try {
			execFileSync(process.execPath, [CLI, "@earendil-works/pi-coding-agent"], {
				cwd: root,
				env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
				encoding: "utf-8",
			});
			expect.unreachable("expected the CLI to exit nonzero");
		} catch (err) {
			const e = err as { status?: number; stderr?: string };
			expect(e.status).toBe(4);
			expect(e.stderr).toMatch(/PI_HOST_SUPPORTED_RANGE is required/);
		}
	});

	it("exits 4 with a message when the intersected range matches no published version", () => {
		const root = fixtureRoot("^0.90.0");
		const { binDir } = stubNpm(root, JSON.stringify(["0.84.1", "0.85.1"]));
		try {
			runCli(root, binDir, ["@earendil-works/pi-coding-agent"]);
			expect.unreachable("expected the CLI to exit nonzero");
		} catch (err) {
			const e = err as { status?: number; stderr?: string };
			expect(e.status).toBe(4);
			expect(e.stderr).toMatch(/no published, non-prerelease version/);
		}
	});

	it("exits 2 when the package has no declared peerDependencies range", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-newest-in-range-norange-"),
		);
		tempDirs.push(root);
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ name: "fixture", peerDependencies: {} }),
		);
		const { binDir } = stubNpm(root, JSON.stringify(["0.85.1"]));
		try {
			runCli(root, binDir, ["@earendil-works/pi-coding-agent"]);
			expect.unreachable("expected the CLI to exit nonzero");
		} catch (err) {
			const e = err as { status?: number; stderr?: string };
			expect(e.status).toBe(2);
			expect(e.stderr).toMatch(/no peerDependencies/);
		}
	});

	// Review S3a: a registry hiccup on attempt 1 must not kill the step --
	// the CLI retries and succeeds once the stub stops failing.
	it("retries a failing npm view and succeeds once the registry recovers", () => {
		const root = fixtureRoot("^0.84.1 || ^0.85.0");
		const { binDir } = stubNpm(
			root,
			JSON.stringify(["0.84.1", "0.85.0", "0.85.9"]),
			{ failTimes: 2 },
		);
		const stdout = runCli(root, binDir, ["@earendil-works/pi-coding-agent"]);
		expect(stdout.trim()).toBe("0.85.9");
	});

	// Review S3a: exhausting every retry is a DISTINCT, labelled failure (exit
	// 3, "::error::infra: registry unreachable"), not the generic exit-4
	// "empty match" or exit-2 "bad usage" paths.
	it("exits 3 with a distinct infra label when every retry fails", () => {
		const root = fixtureRoot("^0.84.1 || ^0.85.0");
		const { binDir } = stubNpm(root, JSON.stringify(["0.85.9"]), {
			failTimes: 999,
		});
		try {
			runCli(root, binDir, ["@earendil-works/pi-coding-agent"]);
			expect.unreachable("expected the CLI to exit nonzero");
		} catch (err) {
			const e = err as { status?: number; stderr?: string };
			expect(e.status).toBe(3);
			expect(e.stderr).toMatch(/::error::infra: registry unreachable/);
		}
	});
});
