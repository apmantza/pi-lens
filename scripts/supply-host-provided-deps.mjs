#!/usr/bin/env node
/**
 * Print what a CI smoke check needs in order to load the compiled entry outside
 * pi. #1926.
 *
 * pi supplies `typebox` and `@earendil-works/pi-tui` from its own runtime, so
 * pi-lens declares them as optional peers and no install vendors them. A CI step
 * that runs a bare `node dist/index.js` is not pi, so nothing resolves those
 * specifiers and the entry throws before it can prove anything. Such a step must
 * install them first, exactly as pi provides them.
 *
 * Two modes, both reading the same list so no workflow hardcodes a package name:
 *
 *   --install-args   the runtime packages plus their required ranges, ready to
 *                    pass to `npm install`. Only the VALUE-imported ones: the
 *                    type-only host SDK must never be installed (MAX_PATH).
 *   --allow-pattern  an ERE alternation of the TYPE-ONLY host packages, for the
 *                    smoke step's missing-module grep. Only the type-only ones,
 *                    deliberately: every caller supplies the runtime ones first,
 *                    so a runtime host package still missing at load IS a
 *                    failure and the grep must catch it. Allowing the whole
 *                    host-provided set would make that step unable to fail —
 *                    bare node would always die at the first host import and the
 *                    allowlist would always match. The step's purpose is to fail
 *                    on an unresolved dependency; it caught the minimatch class
 *                    once.
 *
 * USAGE
 *   HOST_PKGS=()
 *   while IFS= read -r pkg; do
 *     [ -n "$pkg" ] && HOST_PKGS+=("$pkg")
 *   done < <(node scripts/supply-host-provided-deps.mjs --install-args)
 *   npm install --no-save "${HOST_PKGS[@]}"
 *   PATTERN=$(node scripts/supply-host-provided-deps.mjs --allow-pattern)
 *
 * `--install-args` prints one `name@range` per LINE (never space-joined): a
 * peer range can itself contain a space (an OR-form semver range like
 * "^0.84.1 || ^0.85.0"), so a caller must split on newlines only. Use the
 * portable `while IFS= read -r` loop above, never `read -ra ... <<< "$(...)"`
 * or a bare unquoted `$(...)` expansion (both word-split on the range's
 * internal space too and hand npm a broken extra argv token, #2586 review
 * F1) — and never bash 4+'s `mapfile -t` either: it does not exist on
 * macOS's shipped bash 3.2 (Apple has not updated bash past the GPLv2
 * license cutoff), so `mapfile` on a macOS runner fails with
 * `mapfile: command not found` (#2586 review round 3).
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	HOST_PROVIDED_RUNTIME_PACKAGES,
	HOST_PROVIDED_TYPE_ONLY_PACKAGES,
} from "./lib/host-provided-deps.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];

if (mode === "--allow-pattern") {
	console.log(HOST_PROVIDED_TYPE_ONLY_PACKAGES.join("|"));
	process.exit(0);
}

if (mode !== "--install-args") {
	console.error(
		"[supply] usage: supply-host-provided-deps.mjs --install-args|--allow-pattern",
	);
	process.exit(2);
}

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const ranges = pkg.peerDependencies ?? {};
const missing = HOST_PROVIDED_RUNTIME_PACKAGES.filter(
	(name) => !Object.hasOwn(ranges, name),
);
if (missing.length > 0) {
	// A runtime host-provided package with no peer range means the declaration
	// drifted from this list; installing an unpinned copy would hide that.
	console.error(
		`[supply] no peerDependencies range for: ${missing.join(", ")} — ` +
			"declare each host-provided package as an optional peer (#1926).",
	);
	process.exit(1);
}

// Newline-delimited, not space-joined: a peer range itself can contain a
// space (e.g. an OR-form semver range like "^0.84.1 || ^0.85.0", #2586
// review F1), and every caller splits this output back into argv entries.
// Space-joining would let such a range's internal space explode into extra
// tokens under a naive word-split; a newline can never appear inside a
// single `name@range` entry, so splitting on it only ever recovers exactly
// one token per package.
console.log(
	HOST_PROVIDED_RUNTIME_PACKAGES.map((name) => `${name}@${ranges[name]}`).join(
		"\n",
	),
);
