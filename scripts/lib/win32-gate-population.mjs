import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { BoundedSet } from "../../clients/bounded-cache.js";
import { walkFiles } from "./walk-files.mjs";

const TESTS_ROOT = "tests";
const TEST_FILE = /\.test\.ts$/;
const GATE_PATTERN =
	/(?:it|describe)\.(?:skipIf|runIf)\(\s*process\.platform\s*(?:!==|===)\s*["']\s*["']\s*\)/g;

// Shrink-only admissions for tests whose filesystem contract needs a real
// Windows host but is not expressed as a process.platform gate. Each row must
// have a matching `// lane: windows-vitest` header in its test file and a
// reason in the PR that introduced it (#3277).
export const WINDOWS_LANE_ADMISSIONS = Object.freeze([
	Object.freeze({
		file: "tests/clients/dispatch/runners/go-vet.test.ts",
		reason:
			"#3277: go-vet path identity uses the host filesystem's case-folding answer; the safe-spawn boundary is mocked, so no Go binary is required.",
	}),
	Object.freeze({
		file: "tests/clients/dispatch/runners/reported-path-attribution.test.ts",
		reason:
			"#3278 (+#3285, gleam-check): the eleven members' case-variant cells assert the host filesystem's own case-folding answer, and for the nine members whose tool echoes our argv that arm is the only lane where the case direction reds; every boundary mocked is a process boundary, so no toolchain is required.",
	}),
	Object.freeze({
		file: "tests/clients/ruff-client-reported-path.test.ts",
		reason:
			"#3286: ruff-client's case-variant cell asserts the host filesystem's own case-folding answer, and ruff echoes the absolute argv we hand it, so a real Windows host is the only lane where that direction can attach; safe-spawn is the only mock, so no ruff binary is required.",
	}),
	Object.freeze({
		file: "tests/clients/runtime-tool-result.test.ts",
		reason:
			"#3294: workspace-edit changed-file attribution asserts the host filesystem's own case-folding answer through handleToolResult; all pipeline and LSP boundaries are in-process, so no external toolchain is required.",
	}),
]);

function blankSource(source) {
	const output = source.split("");
	let quote;
	let lineComment = false;
	let blockComment = false;
	for (let index = 0; index < output.length; index++) {
		const current = output[index];
		const next = output[index + 1];
		if (lineComment) {
			if (current === "\n") lineComment = false;
			else output[index] = " ";
			continue;
		}
		if (blockComment) {
			if (current === "*" && next === "/") {
				output[index] = " ";
				output[++index] = " ";
				blockComment = false;
			} else if (current !== "\n") output[index] = " ";
			continue;
		}
		if (quote) {
			if (current === "\\") {
				output[index] = " ";
				if (index + 1 < output.length && output[index + 1] !== "\n")
					output[++index] = " ";
			} else if (current === quote) quote = undefined;
			else if (current !== "\n") output[index] = " ";
			continue;
		}
		if (current === "/" && next === "/") {
			output[index++] = " ";
			output[index] = " ";
			lineComment = true;
		} else if (current === "/" && next === "*") {
			output[index++] = " ";
			output[index] = " ";
			blockComment = true;
		} else if (["'", '"', "`"].includes(current)) quote = current;
	}
	return output.join("");
}

function sourceFiles(root) {
	return walkFiles(
		join(root, TESTS_ROOT),
		(entry) => entry.isFile() && TEST_FILE.test(entry.name),
		(directory) => recordVanishedPath(directory, "its descent"),
	);
}

/**
 * Paths this process already warned about, so one vanished file is one
 * warning however many times the population is rebuilt (`findWin32Gates` is
 * called twice by `getWin32LaneFiles` alone). Matches the TypeScript seam's
 * once-per-distinct-path rule; bounded for the same reason it is there.
 *
 * Backed by the same {@link BoundedSet} the TypeScript seam uses (imported
 * from the build output, since `scripts/` cannot import from `tests/` but
 * can import from `clients/` — see `scripts/lib/astgrep-self-scan.mjs` for
 * precedent) rather than a hand-rolled `Set` with its own eviction: a second,
 * divergent eviction policy here (#3104 review F6 found this copy warning
 * once per OCCURRENCE instead of once per distinct path; a later hand-rolled
 * `clear()`-on-overflow policy would have been a second divergence of the
 * same shape) is exactly the drift a shared bounded-collection primitive
 * exists to prevent.
 */
export const VANISHED_PATH_RECORD_CAP = 256;
const vanishedBetweenWalkAndRead = new BoundedSet(VANISHED_PATH_RECORD_CAP);

/** Test seam: the cap is only observable through many recorded paths. */
export function recordedVanishedPathCount() {
	return vanishedBetweenWalkAndRead.size;
}

/**
 * Read a file this module's own walk just produced, tolerating the file
 * vanishing between the walk and the read (#3082): a concurrently running
 * test that creates a source file under `tests/` and removes it again makes
 * this read throw ENOENT in whichever walker was mid-enumeration. `undefined`
 * means "no longer part of the population" — a gone file has no gates.
 *
 * The TypeScript-side seam for the same rule is `readWalkedFile` in
 * tests/support/sweep-kit.ts, which every other walker in the repo now uses;
 * scripts/ cannot import from tests/, so this one repeats it rather than
 * inverting the layering. Behaviour is IDENTICAL, including the
 * once-per-distinct-path record and its bound (both now backed by the same
 * {@link BoundedSet}, oldest-first eviction) and the channel: a raw
 * `process.stderr.write`, not `console.warn` (#3107) — Vitest's default
 * reporter (every `npm test` script uses it) intercepts a worker's
 * `console.warn` and can drop it entirely on a passing run, so this line
 * would never reach CI's job log through `console.warn`.
 */
export function readWalkedFile(absolute) {
	try {
		return readFileSync(absolute, "utf8");
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		recordVanishedPath(absolute, "the read");
		return undefined;
	}
}

function recordVanishedPath(absolute, phase) {
	if (vanishedBetweenWalkAndRead.has(absolute)) return;
	vanishedBetweenWalkAndRead.add(absolute);
	process.stderr.write(
		`[win32-gate-population] ${absolute} vanished between the walk and ${phase}; skipped (#3082)\n`,
	);
}

function isWindowsOnlyGate(match, rawSpan) {
	if (!/["']win32["']/.test(rawSpan)) return false;
	return (
		(match.includes("skipIf") && match.includes("!==")) ||
		(match.includes("runIf") && match.includes("==="))
	);
}

export function findWin32Gates(cwd = process.cwd()) {
	const root = resolve(cwd);
	const gates = [];
	for (const absolute of sourceFiles(root)) {
		if (absolute.startsWith(join(root, TESTS_ROOT, "fixtures") + sep)) continue;
		const raw = readWalkedFile(absolute);
		if (raw === undefined) continue;
		for (const match of blankSource(raw).matchAll(GATE_PATTERN)) {
			const offset = match.index ?? 0;
			if (
				!isWindowsOnlyGate(
					match[0],
					raw.slice(offset, offset + match[0].length),
				)
			)
				continue;
			gates.push({
				file: relative(root, absolute).replaceAll("\\", "/"),
				line: raw.slice(0, offset).split("\n").length,
			});
		}
	}
	return gates;
}

export function getWin32GateFiles(cwd = process.cwd()) {
	return [...new Set(findWin32Gates(cwd).map((gate) => gate.file))].sort();
}

export function getWin32LaneFiles(cwd = process.cwd()) {
	const root = resolve(cwd);
	const files = new Set(getWin32GateFiles(root));
	for (const admission of WINDOWS_LANE_ADMISSIONS) files.add(admission.file);
	for (const absolute of sourceFiles(root)) {
		const file = relative(root, absolute).replaceAll("\\", "/");
		if (file.startsWith("tests/config/")) files.add(file);
	}
	if (existsSync(join(root, "tests/clients/tool-cwd.test.ts")))
		files.add("tests/clients/tool-cwd.test.ts");
	return [...files].sort();
}

function main() {
	const args = process.argv.slice(2);
	const root = process.cwd();
	const files = getWin32LaneFiles(root);
	if (files.length === 0) throw new Error("win32-gate population is empty");
	if (args.includes("--summary")) {
		const listIndex = args.indexOf("--executed-file-list");
		const listPath = listIndex >= 0 ? args[listIndex + 1] : undefined;
		const executedFiles = listPath
			? readFileSync(resolve(root, listPath), "utf8")
					.split(/\r?\n/)
					.filter(Boolean)
			: files;
		const executed = new Set(executedFiles);
		const testsExecuted = findWin32Gates(root).filter((gate) =>
			executed.has(gate.file),
		).length;
		console.log(
			`win32-gate population: ${executed.size} files, ${testsExecuted} tests executed`,
		);
	} else if (args.includes("--files")) console.log(files.join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main();
