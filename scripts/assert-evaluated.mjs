#!/usr/bin/env node
/**
 * #4514: the dedicated, non-continue-on-error step behind the nightly's
 * best-effort LSP producers (scripts/lib/assert-evaluated.mjs has the why and
 * the record shape).
 *
 *   node scripts/assert-evaluated.mjs --records <dir> [--docs]
 *       tool-smoke job: each producer's `<dir>/<producer>.json` against its
 *       floor, and against the count in HEAD's committed doc where it has one.
 *       With --docs the same step also judges the docs the producers just
 *       regenerated, so a doc-only loss (five matrix cells gone `unknown`)
 *       reds the job the tracking-issue notifier already reads.
 *   node scripts/assert-evaluated.mjs --docs
 *       tool-smoke-prs job: the regenerated docs in the working tree against
 *       HEAD's, before any refresh PR opens.
 *   node scripts/assert-evaluated.mjs --count <producer>=<n> --floor <m>
 *       a workflow step whose producer is not an LSP script (#4518): the count
 *       the step derived in shell, against a floor the workflow carries next to
 *       it, the way `--min-pass=N` does. An empty or non-numeric `<n>` is a
 *       producer that reported nothing.
 *
 * Exit 0 when every record is ok, 1 when any is not (or HEAD cannot be read: a
 * guard that cannot compare must not read green), 2 on a usage error.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	assertEvaluated,
	EVALUATED_PRODUCERS,
	lostClassifiedCells,
	matrixCells,
	missingRecord,
	readEvaluatedRecord,
} from "./lib/assert-evaluated.mjs";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

/**
 * HEAD's committed text of a doc, or null when HEAD has no such file. A git
 * failure (no repository, an unreadable object store) THROWS: reading it as
 * "no baseline" would turn the drop guard off and let the night pass.
 */
export function gitHeadText(docPath, cwd = process.cwd()) {
	const opts = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
	let listed;
	try {
		listed = gitExecFileSync(
			["ls-tree", "--name-only", "HEAD", "--", docPath],
			opts,
		);
	} catch (e) {
		throw new Error(
			`git could not read HEAD for ${docPath}: ${String(e?.stderr ?? e?.message ?? e).trim()}`,
		);
	}
	if (listed.trim() === "") return null;
	return gitExecFileSync(["show", `HEAD:${docPath}`], opts);
}

function headCount(doc, headText) {
	const text = headText(doc.path);
	return text === null ? null : doc.count(text);
}

/** Records mode: one record per producer. */
export function checkRecords(dir, headText = gitHeadText) {
	return Object.entries(EVALUATED_PRODUCERS).map(([producer, spec]) => {
		// A doc counted in another unit than the record is no baseline for it.
		const previous =
			spec.doc && spec.doc.comparableToRecord !== false
				? headCount(spec.doc, headText)
				: null;
		const evaluated = readEvaluatedRecord(dir, producer);
		if (evaluated === null)
			return missingRecord(producer, spec.floor, previous);
		return assertEvaluated({
			producer,
			evaluated,
			expectedAtLeast: spec.floor,
			previous,
		});
	});
}

/**
 * Count mode: `spec` is `<producer>=<n>`. A count that is absent, empty or not
 * a non-negative integer is a producer that never reported (a step that failed
 * before it could count), never a zero it measured.
 */
export function checkCount(spec, floor) {
	const eq = spec.indexOf("=");
	const producer = eq < 0 ? spec : spec.slice(0, eq);
	const raw = eq < 0 ? "" : spec.slice(eq + 1);
	if (!/^\d+$/.test(raw)) return missingRecord(producer, floor);
	return assertEvaluated({
		producer,
		evaluated: Number(raw),
		expectedAtLeast: floor,
	});
}

/**
 * The per-cell check of a doc whose count margin is too coarse to see a
 * handful of cells go `unknown`: HEAD must justify losses with an expired stamp.
 * Same record shape: `evaluated` is how many of HEAD's classified cells held.
 */
function cellRecord(producer, doc, head, text) {
	const atHead = [...(matrixCells(head) ?? [])].filter(
		([, cell]) => cell !== "" && cell !== "unknown",
	).length;
	if (atHead === 0) return null;
	const lost = lostClassifiedCells(head, text);
	const record = assertEvaluated({
		producer: `${producer}:${doc.path}#cells`,
		evaluated: atHead - lost.length,
		expectedAtLeast: atHead,
	});
	if (lost.length === 0) return record;
	const named = lost.slice(0, 8).join(", ");
	return {
		...record,
		reason: `${lost.length} cell(s) classified at HEAD turned unknown: ${named}${lost.length > 8 ? ", ..." : ""}`,
	};
}

/**
 * Docs mode: one record per committed doc the refresh PR would carry. A doc
 * the regeneration left byte-identical to HEAD carries nothing, so it is not
 * judged: a promotion-only night must not be held by a doc an earlier degraded
 * refresh already merged.
 */
export function checkDocs(root = ".", headText = gitHeadText) {
	return Object.entries(EVALUATED_PRODUCERS)
		.filter(([, spec]) => spec.doc)
		.flatMap(([producer, { doc }]) => {
			const head = headText(doc.path);
			const previous = head === null ? null : doc.count(head);
			let text = null;
			try {
				text = fs.readFileSync(path.resolve(root, doc.path), "utf8");
			} catch {
				// An absent doc reads as no record below.
			}
			if (text !== null && text === head) return [];
			const evaluated = text === null ? null : doc.count(text);
			if (evaluated === null)
				return [missingRecord(`${producer}:${doc.path}`, doc.floor, previous)];
			const records = [
				assertEvaluated({
					producer: `${producer}:${doc.path}`,
					evaluated,
					expectedAtLeast: doc.floor,
					previous,
				}),
			];
			const cells =
				doc.cells && head !== null && cellRecord(producer, doc, head, text);
			if (cells) records.push(cells);
			return records;
		});
}

export function main(argv, headText = gitHeadText, root = ".") {
	const recordsAt = argv.indexOf("--records");
	const wantRecords = recordsAt >= 0 && Boolean(argv[recordsAt + 1]);
	const wantDocs = argv.includes("--docs");
	const countAt = argv.indexOf("--count");
	const floorAt = argv.indexOf("--floor");
	// `--count` with no value (or another flag in its place) is a usage error,
	// never a mode that silently does nothing (#4518 review F-nit).
	const countValue = countAt >= 0 ? argv[countAt + 1] : undefined;
	const countMalformed =
		countAt >= 0 && (countValue === undefined || countValue.startsWith("--"));
	const wantCount = countAt >= 0 && !countMalformed;
	const floor = floorAt >= 0 ? Number(argv[floorAt + 1]) : Number.NaN;
	if (
		countMalformed ||
		(!wantRecords && !wantDocs && !wantCount) ||
		(wantCount && !(Number.isInteger(floor) && floor >= 1))
	) {
		console.error(
			"usage: assert-evaluated.mjs --records <dir> [--docs] | --docs | --count <producer>=<n> --floor <m> (exit 0 ok, 1 below a floor, 2 usage)",
		);
		return 2;
	}
	let records;
	try {
		records = [
			...(wantRecords ? checkRecords(argv[recordsAt + 1], headText) : []),
			...(wantDocs ? checkDocs(root, headText) : []),
			...(wantCount ? [checkCount(argv[countAt + 1], floor)] : []),
		];
	} catch (e) {
		// Fail closed: with no HEAD to compare against, the drop guard is off.
		const reason = String(e?.message ?? e);
		console.error(`::error title=nightly evaluated floor::${reason}`);
		console.log(`✗  assert-evaluated  evaluated floor  0  ${reason}`);
		return 1;
	}
	for (const r of records) console.log(JSON.stringify(r));
	const failed = records.filter((r) => !r.ok);
	for (const r of failed) {
		console.error(
			`::error title=nightly evaluated floor::${r.producer}: ${r.reason}`,
		);
		// The shape smoke-tools.mjs's report() prints for a failing row, so the
		// red-night tracking issue (notify-tool-smoke-red.mjs) lists it.
		console.log(
			`✗  ${r.producer}  evaluated floor  ${r.evaluated}  ${r.reason}`,
		);
	}
	if (process.env.GITHUB_STEP_SUMMARY) {
		const table = records.map(
			(r) =>
				`| ${r.producer} | ${r.evaluated} | ${r.floor} | ${r.prevEvaluated ?? "n/a"} | ${r.ok ? "ok" : r.reason} |`,
		);
		fs.appendFileSync(
			process.env.GITHUB_STEP_SUMMARY,
			`## Nightly evaluated floor\n\n| producer | evaluated | floor | at HEAD | verdict |\n|---|---|---|---|---|\n${table.join("\n")}\n`,
		);
	}
	return failed.length > 0 ? 1 : 0;
}

// Run only when executed directly: tests import checkRecords/checkDocs/main.
if (isMainModule(import.meta.url)) {
	process.exit(main(process.argv.slice(2)));
}
