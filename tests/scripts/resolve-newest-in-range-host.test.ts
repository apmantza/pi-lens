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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isAcceptableLatestHost,
	readPeerRange,
} from "../../scripts/lib/resolve-newest-in-range-host.mjs";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const CLI = path.join(REPO_ROOT, "scripts/resolve-newest-in-range-host.mjs");
const tempDirs: string[] = [];

// Recurrence: #4088. `execFileSync` copies the child's stderr to THIS process's
// stderr unless `stdio` is given, so the stubbed exhaustion test printed a real
// `::error::infra: registry unreachable` line that GitHub rendered as a
// `##[error]` annotation on a passing job. The CLI still emits the annotation
// (the exit-3 test asserts it on the captured `e.stderr`); no test may re-echo
// it into the host log.
beforeEach(() => {
	vi.spyOn(process.stderr, "write");
});

afterEach(() => {
	const echoed = vi
		.mocked(process.stderr.write)
		.mock.calls.map(([chunk]) => String(chunk))
		.join("");
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	expect(echoed).not.toMatch(/^::(?:error|warning|notice)/m);
});

// Pure acceptance logic — no live registry, no fs, no child_process (#5749).
describe("isAcceptableLatestHost (#5749)", () => {
	const FLOOR = "0.86.1";

	// The wildcard peer range is this repo's real pi-coding-agent peer spec, so
	// the lane's upper end is whatever the registry's `latest` is, with no
	// ceiling in between.
	it("accepts the newest stable release against the wildcard peer range", () => {
		expect(isAcceptableLatestHost("1.6.0", "*", FLOOR)).toBe(true);
		expect(isAcceptableLatestHost("9.9.9", "*", FLOOR)).toBe(true);
	});

	// Recurrence prevented (#5749): "no prereleases" is the acceptance, and a
	// `latest` tag moved onto a prerelease must refuse, never pass. semver
	// already excludes a prerelease from `*`, but admits one when the range
	// carries a prerelease comparator on the same version tuple, so only the
	// second row reaches the explicit check.
	it("refuses a prerelease even when the range admits prereleases", () => {
		expect(isAcceptableLatestHost("1.7.0-beta.1", "*", FLOOR)).toBe(false);
		expect(
			isAcceptableLatestHost("1.7.0-beta.1", ">=1.7.0-beta.0", FLOOR),
		).toBe(false);
	});

	// #5749 review F1: the boundary is inclusive, and a stable version below it
	// is refused even though the peer range alone admits it.
	it("refuses a version below the floor and accepts the floor itself", () => {
		expect(isAcceptableLatestHost("0.1.0", "*", FLOOR)).toBe(false);
		expect(isAcceptableLatestHost("0.86.0", "*", FLOOR)).toBe(false);
		expect(isAcceptableLatestHost("0.86.1", "*", FLOOR)).toBe(true);
	});

	it("refuses a version outside the declared peer range", () => {
		expect(isAcceptableLatestHost("1.6.0", "^1.5.0 || ^0.99.0", FLOOR)).toBe(
			true,
		);
		expect(isAcceptableLatestHost("2.0.0", "^1.5.0 || ^0.99.0", FLOOR)).toBe(
			false,
		);
	});

	// Fail closed on what the gate does not recognize (principles §1): a value
	// that is not a clean semver string is unrecognized, not a pass.
	it.each([undefined, null, 160, "", "v1.6.0", "1.6", "latest", " 1.6.0"])(
		"refuses the unrecognized value %j",
		(value) => {
			expect(isAcceptableLatestHost(value, "*", FLOOR)).toBe(false);
		},
	);
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

const PI = "@earendil-works/pi-coding-agent";

function fixtureRoot(peerRange: string) {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-newest-in-range-"),
	);
	tempDirs.push(root);
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({
			name: "fixture",
			peerDependencies: { [PI]: peerRange },
		}),
	);
	return root;
}

// A stub `npm` on PATH ahead of the real one, so the CLI's `npm view --json`
// call is hermetic (no live registry) while still exercising the real
// execFileSync spawn path end to end. It answers two queries:
//   - `view <pkg> dist-tags --json` -> `distTagsJson`, failing the first
//     `failTimes` calls (or forever) via a counter file that survives across
//     the CLI's separate retry-attempt spawns;
//   - `view <pkg> versions --json`  -> `versionsJson`, always succeeding. The
//     CLI must never lean on it: a lane that falls back to the versions list
//     when the `latest` query fails resolves an older host silently (#5749).
function stubNpm(
	root: string,
	opts: { distTagsJson: string; versionsJson?: string; failTimes?: number },
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
			`const args = process.argv.slice(2);`,
			`if (args.includes("versions")) { process.stdout.write(${JSON.stringify(opts.versionsJson ?? "[]")}); process.exit(0); }`,
			`const counterFile = ${JSON.stringify(counterFile)};`,
			`const n = Number(fs.readFileSync(counterFile, "utf8")) + 1;`,
			`fs.writeFileSync(counterFile, String(n));`,
			`if (n <= ${failTimes}) { process.stderr.write("stub: simulated registry failure\\n"); process.exit(1); }`,
			`process.stdout.write(${JSON.stringify(opts.distTagsJson)});`,
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	return { binDir, counterFile };
}

function runCli(
	root: string,
	binDir: string,
	extraEnv: Record<string, string> = {},
) {
	return execFileSync(process.execPath, [CLI, PI], {
		cwd: root,
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH}`,
			// Instant retries — see the CLI's own comment on this var. Real
			// backoff timing is not this test's subject; the retry COUNT and
			// eventual outcome are.
			RESOLVE_NEWEST_RETRY_BACKOFF_MS: "0,0,0",
			// The workflow's own env value (install-smoke.yml's
			// PI_HOST_FLOOR_VERSION), which GitHub exports to every step.
			PI_HOST_FLOOR_VERSION: "0.86.1",
			...extraEnv,
		},
		encoding: "utf-8",
		stdio: "pipe",
	});
}

function runCliFailing(
	root: string,
	binDir: string,
	extraEnv: Record<string, string> = {},
) {
	try {
		runCli(root, binDir, extraEnv);
	} catch (err) {
		return err as { status?: number; stdout?: string; stderr?: string };
	}
	return expect.unreachable("expected the CLI to exit nonzero");
}

describe("resolve-newest-in-range-host.mjs CLI (#2613, #5749)", () => {
	it("prints the latest dist-tag and writes GITHUB_OUTPUT", () => {
		const root = fixtureRoot("*");
		const { binDir } = stubNpm(root, {
			distTagsJson: JSON.stringify({ latest: "1.6.0" }),
		});
		const outputFile = path.join(root, "gh-output");
		fs.writeFileSync(outputFile, "");
		const stdout = runCli(root, binDir, { GITHUB_OUTPUT: outputFile });
		expect(stdout.trim()).toBe("1.6.0");
		expect(fs.readFileSync(outputFile, "utf-8")).toBe("version=1.6.0\n");
	});

	// Recurrence prevented (#5749): the lane was capped by a hand-kept
	// `PI_HOST_SUPPORTED_RANGE` ceiling (">=0.86.1 <1.6.0") and resolved pi
	// 1.5.2 for two days after pi 1.6.0 shipped. The CLI must not read that
	// variable any more: a ceiling re-added to the workflow env would restore
	// the cap while every other case here stayed green.
	it("is not capped by a leftover PI_HOST_SUPPORTED_RANGE ceiling", () => {
		const root = fixtureRoot("*");
		const { binDir } = stubNpm(root, {
			distTagsJson: JSON.stringify({ latest: "1.6.0" }),
			versionsJson: JSON.stringify(["1.5.1", "1.5.2", "1.6.0"]),
		});
		const stdout = runCli(root, binDir, {
			PI_HOST_SUPPORTED_RANGE: ">=0.86.1 <1.6.0",
		});
		expect(stdout.trim()).toBe("1.6.0");
	});

	// `latest` is the dist-tag, not the highest version in the list: a release
	// the maintainers have not promoted (here 1.7.0) is not the tested host.
	it("resolves the dist-tag, not the highest published version", () => {
		const root = fixtureRoot("*");
		const { binDir } = stubNpm(root, {
			distTagsJson: JSON.stringify({ latest: "1.6.0", next: "1.7.0" }),
			versionsJson: JSON.stringify(["1.5.2", "1.6.0", "1.7.0"]),
		});
		const stdout = runCli(root, binDir);
		expect(stdout.trim()).toBe("1.6.0");
	});

	it("exits 4 when the latest dist-tag is a prerelease", () => {
		const root = fixtureRoot("*");
		const { binDir } = stubNpm(root, {
			distTagsJson: JSON.stringify({ latest: "1.7.0-beta.1" }),
			versionsJson: JSON.stringify(["1.5.2", "1.6.0", "1.7.0-beta.1"]),
		});
		const e = runCliFailing(root, binDir);
		expect(e.status).toBe(4);
		expect(e.stdout).toBe("");
		expect(e.stderr).toMatch(/not a stable release/);
	});

	it("exits 4 when the latest dist-tag falls outside the declared peer range", () => {
		const root = fixtureRoot("^0.99.0 || ^1.5.0");
		const { binDir } = stubNpm(root, {
			distTagsJson: JSON.stringify({ latest: "2.0.0" }),
			versionsJson: JSON.stringify(["1.5.2", "2.0.0"]),
		});
		const e = runCliFailing(root, binDir);
		expect(e.status).toBe(4);
		expect(e.stdout).toBe("");
		expect(e.stderr).toMatch(/peerDependencies range/);
	});

	// Recurrence prevented (#5749 review F1): a stable `latest` below the floor
	// (a mis-tagged or republished old version) passed the stable-and-peer-range
	// check, so the lane installed a host pi-lens does not support and printed it
	// as the newest. The floor is the one value PI_HOST_FLOOR_VERSION, read from
	// the env GitHub exports from the workflow, never a second literal here.
	it("exits 4 naming the floor when the latest dist-tag is below it", () => {
		const root = fixtureRoot("*");
		const { binDir } = stubNpm(root, {
			distTagsJson: JSON.stringify({ latest: "0.1.0" }),
			versionsJson: JSON.stringify(["0.1.0", "0.86.1", "1.6.0"]),
		});
		const outputFile = path.join(root, "gh-output");
		fs.writeFileSync(outputFile, "");
		const e = runCliFailing(root, binDir, { GITHUB_OUTPUT: outputFile });
		expect(e.status).toBe(4);
		expect(e.stdout).toBe("");
		expect(e.stderr).toMatch(/at or above the floor 0\.86\.1/);
		expect(fs.readFileSync(outputFile, "utf-8")).toBe("");
	});

	it("accepts a latest dist-tag exactly at the floor", () => {
		const root = fixtureRoot("*");
		const { binDir } = stubNpm(root, {
			distTagsJson: JSON.stringify({ latest: "0.86.1" }),
		});
		expect(runCli(root, binDir).trim()).toBe("0.86.1");
	});

	it.each(["", "latest", "0.86"])(
		"exits 2 when PI_HOST_FLOOR_VERSION is %j, never resolving without a floor",
		(floor) => {
			const root = fixtureRoot("*");
			const { binDir } = stubNpm(root, {
				distTagsJson: JSON.stringify({ latest: "1.6.0" }),
			});
			const e = runCliFailing(root, binDir, { PI_HOST_FLOOR_VERSION: floor });
			expect(e.status).toBe(2);
			expect(e.stdout).toBe("");
			expect(e.stderr).toMatch(/PI_HOST_FLOOR_VERSION/);
		},
	);

	it("exits 2 when the package has no declared peerDependencies range", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-newest-in-range-norange-"),
		);
		tempDirs.push(root);
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ name: "fixture", peerDependencies: {} }),
		);
		const { binDir } = stubNpm(root, {
			distTagsJson: JSON.stringify({ latest: "1.6.0" }),
		});
		const e = runCliFailing(root, binDir);
		expect(e.status).toBe(2);
		expect(e.stderr).toMatch(/no peerDependencies/);
	});

	// Review S3a: a registry hiccup on attempt 1 must not kill the step --
	// the CLI retries and succeeds once the stub stops failing.
	it("retries a failing npm view and succeeds once the registry recovers", () => {
		const root = fixtureRoot("*");
		const { binDir } = stubNpm(root, {
			distTagsJson: JSON.stringify({ latest: "1.6.0" }),
			failTimes: 2,
		});
		const stdout = runCli(root, binDir);
		expect(stdout.trim()).toBe("1.6.0");
	});

	// #5749 acceptance: a registry failure while resolving `latest` fails the
	// lane CLOSED. The stub keeps answering the versions list (1.5.2 is the
	// newest it names), so a script that fell back to it would exit 0 with an
	// older host: that silent fallback is the recurrence. Exit 3 is the
	// distinct, labelled infra failure; GITHUB_OUTPUT stays empty so the
	// install step cannot read a version.
	it("fails closed with exit 3 when every latest lookup fails, never resolving an older host", () => {
		const root = fixtureRoot("*");
		const { binDir } = stubNpm(root, {
			distTagsJson: JSON.stringify({ latest: "1.6.0" }),
			versionsJson: JSON.stringify(["1.5.1", "1.5.2"]),
			failTimes: 999,
		});
		const outputFile = path.join(root, "gh-output");
		fs.writeFileSync(outputFile, "");
		const e = runCliFailing(root, binDir, { GITHUB_OUTPUT: outputFile });
		expect(e.status).toBe(3);
		expect(e.stdout).toBe("");
		expect(e.stderr).toMatch(/::error::infra: registry unreachable/);
		expect(fs.readFileSync(outputFile, "utf-8")).toBe("");
	});

	// An answer with no `latest` tag is as unusable as no answer: the same
	// labelled exit 3, again with older versions published beside it.
	it("fails closed with exit 3 when the registry answer carries no latest dist-tag", () => {
		const root = fixtureRoot("*");
		const { binDir } = stubNpm(root, {
			distTagsJson: JSON.stringify({ next: "1.7.0-beta.1" }),
			versionsJson: JSON.stringify(["1.5.2", "1.6.0"]),
		});
		const e = runCliFailing(root, binDir);
		expect(e.status).toBe(3);
		expect(e.stdout).toBe("");
		expect(e.stderr).toMatch(/no "latest" dist-tag/);
	});
});
