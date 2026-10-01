// flake-shape: real-process-spawn — the subject IS the script's actual stdout
// bytes (whether the delimiter is a real newline vs. a real space), which
// only a real child process invocation can prove; an in-process stub of
// `supply-host-provided-deps.mjs` would just re-assert whatever delimiter
// the test author typed, not what the script actually prints (#2586 review
// F1).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOST_PROVIDED_RUNTIME_PACKAGES } from "../../scripts/lib/host-provided-deps.mjs";

// #2586 review F1: `.github/workflows/ci.yml` reads `--install-args`'s
// stdout with a newline-only loop reading `node "$SUPPLY" --install-args`,
// which splits ONLY on newlines. `peerDependencies["@earendil-works/pi-tui"]`
// is an OR-form semver range ("^0.84.1 || ^0.85.0", #2586) that itself
// contains a space — the old space-joined `--install-args` output let a
// naive word-split (bash's default IFS, or the `read -ra ... <<< "$(...)"`
// this replaced) explode that single `name@range` entry into THREE argv
// tokens, so `npm install ... "${HOST_PKGS[@]}"` failed with
// `npm ERR! notarget No matching version found for undefined@^0.85.0`
// (reproduced verbatim against this exact tree before the fix). This test
// pins the actual property every caller depends on: the output splits on
// NEWLINES ONLY into exactly one token per runtime package, regardless of
// whether a package's range itself contains a space.
const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const scriptPath = path.join(root, "scripts", "supply-host-provided-deps.mjs");

function runInstallArgs(script = scriptPath, cwd = root): string {
	return execFileSync(process.execPath, [script, "--install-args"], {
		cwd,
		encoding: "utf8",
	});
}

describe("supply-host-provided-deps.mjs --install-args (#2586 review F1)", () => {
	it("lists at least one runtime package to guard", () => {
		// Guards the guard: an emptied HOST_PROVIDED_RUNTIME_PACKAGES would make
		// the token-count assertion below vacuously pass.
		expect(HOST_PROVIDED_RUNTIME_PACKAGES.length).toBeGreaterThan(0);
	});

	it("splits into exactly one token per runtime package with newline-delimited workflow input", () => {
		const output = runInstallArgs();
		// Mirrors the workflow loop: split on newlines only, drop the trailing empty
		// entry a final newline would otherwise introduce.
		const tokens = output.split("\n").filter((line) => line.length > 0);
		expect(
			tokens.length,
			`expected exactly ${HOST_PROVIDED_RUNTIME_PACKAGES.length} newline-delimited entries, got: ${JSON.stringify(tokens)}`,
		).toBe(HOST_PROVIDED_RUNTIME_PACKAGES.length);
	});

	it("preserves a range's internal space as ONE token, not split further", () => {
		// The regression this guards: a peer range containing a space (an OR-form
		// semver range) must survive as a single argv entry once split on
		// newlines -- proving the delimiter choice, not just the count, is
		// correct (a coincidental count match wouldn't catch a shuffled split).
		// pi-lens's own pi-tui peer is "*" since #3805, so the spaced range is a
		// fixture: a scratch root holding copies of the script and a manifest
		// that carries one. The script resolves its root from its own location.
		const tui = "@earendil-works/pi-tui";
		const range = "^0.84.1 || ^0.85.0";
		const fixtureRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-supply-spaced-range-"),
		);
		try {
			fs.mkdirSync(path.join(fixtureRoot, "scripts", "lib"), {
				recursive: true,
			});
			for (const rel of [
				"supply-host-provided-deps.mjs",
				path.join("lib", "host-provided-deps.mjs"),
			]) {
				fs.copyFileSync(
					path.join(root, "scripts", rel),
					path.join(fixtureRoot, "scripts", rel),
				);
			}
			const peers = Object.fromEntries(
				HOST_PROVIDED_RUNTIME_PACKAGES.map((name) => [
					name,
					name === tui ? range : "*",
				]),
			);
			fs.writeFileSync(
				path.join(fixtureRoot, "package.json"),
				JSON.stringify({ peerDependencies: peers }),
			);
			const output = runInstallArgs(
				path.join(fixtureRoot, "scripts", "supply-host-provided-deps.mjs"),
				fixtureRoot,
			);
			const tokens = output.split("\n").filter((line) => line.length > 0);
			expect(tokens).toContain(`${tui}@${range}`);
		} finally {
			fs.rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});
});
