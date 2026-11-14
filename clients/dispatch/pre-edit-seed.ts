/**
 * #4483: the linter findings a file held before its first edit this session.
 *
 * The delta baseline (`session.baseline.<file>`) exists only after a file's
 * first dispatch, so that dispatch called every finding new and stopped the
 * agent on linter errors it never touched. The `tool_call` of the first
 * classified write or edit runs the file's inline linters over the bytes still
 * on disk (`capturePreEditLinterFindings`, clients/dispatch/integration.ts)
 * and installs their blocking findings here, once. Every later dispatch of
 * the file reports a blocking linter finding that matches one of them as
 * pre-existing instead of as a blocker.
 *
 * Scope (the maintainer, 2026-10-15): linters only. Language servers, type
 * checkers, the edit-range gated runners (ast-grep, tree-sitter) and scanners
 * keep their first-write behaviour, so the seed is never captured from them
 * and never classifies their findings. One exception (#5553): a writer that
 * names no edit span (`PRE_EDIT_SEED_SPANLESS_RUNNER_IDS`) also seeds the two
 * edit-gated lanes, because those lanes read its whole file; their entries
 * classify only a dispatch that read the whole file too (`classifyPreExisting`).
 *
 * Identity: content, not position. A seeded finding matches a current one of
 * the same `foldedFindingIdentity` on a line with the seeded line's text
 * (`lineHash`), anywhere in the file, one current finding per seeded entry
 * (`retainRecordedFindings`, the recorded-blocker carry's matcher). So an
 * insertion above an old error keeps it pre-existing, an error the edit
 * caused at an unchanged line is new (no seeded entry has its identity), and
 * a second occurrence of an old error is new.
 *
 * Lifetime: the record sits beside the delta baseline in the dispatch session
 * facts and is cleared with it at a primary or sequential `session_start`
 * (`resetDispatchBaselines`). The capture only creates it; each dispatch only
 * shrinks it, dropping an entry once a run of its runner that reached a
 * verdict no longer observes it, so a fixed error that comes back blocks.
 */
import { ANY_POSITION, retainRecordedFindings } from "../finding-identity.js";
import { lineHashOf, stampLineHashes } from "../line-alignment.js";
import type { Diagnostic, ModifiedRange } from "./types.js";

/**
 * The dispatch runners whose findings the seed covers: the lanes
 * `tests/clients/dispatch/edit-scope-census.test.ts` classifies as linters.
 * That census fails when the two sets differ.
 */
export const PRE_EDIT_SEED_RUNNER_IDS: ReadonlySet<string> = new Set([
	"actionlint",
	"biome-check-json",
	"credo",
	"detekt",
	"eslint",
	"golangci-lint",
	"hadolint",
	"htmlhint",
	"ktlint",
	"markdownlint",
	"oxlint",
	"psscriptanalyzer",
	"rubocop",
	"ruff-lint",
	"rust-clippy",
	"shellcheck",
	"spellcheck",
	"sqlfluff",
	"stylelint",
	"swiftlint",
	"tflint",
	"vale",
	"yamllint",
]);

/**
 * #5553 r2: the two lanes whose findings a dispatch with an edit span reports
 * only near the touched lines. Their seed entries describe the whole file, so
 * they classify a dispatch that read the whole file and no other
 * (`classifyPreExisting`).
 */
const PRE_EDIT_EDIT_GATED_RUNNER_IDS: ReadonlySet<string> = new Set([
	"ast-grep-napi",
	"tree-sitter",
]);

/**
 * #5553: the lanes a writer with no edit span seeds. A host `edit` carries its
 * touched lines, so the two edit-span-gated lanes (ast-grep, tree-sitter) judge
 * only those lines and need no seed. `ast_grep_replace`, `sed -i`, an
 * unclassified tool and an LSP rename name no span, so those lanes read the
 * whole file and report a blocker the file already held; they join the linters
 * in the seed. Language servers and the other scanners stay out, as for an
 * `edit` (the maintainer, 2026-10-15). `tests/clients/dispatch/edit-scope-census.test.ts`
 * fails when this set differs from the linter lanes plus the span-gated
 * registry lanes.
 */
export const PRE_EDIT_SEED_SPANLESS_RUNNER_IDS: ReadonlySet<string> = new Set([
	...PRE_EDIT_SEED_RUNNER_IDS,
	...PRE_EDIT_EDIT_GATED_RUNNER_IDS,
]);

/** Whether `runnerId`'s findings are seeded for a writer with or without a span. */
export function isPreEditSeedRunner(
	runnerId: string,
	spanless: boolean,
): boolean {
	return spanless
		? PRE_EDIT_SEED_SPANLESS_RUNNER_IDS.has(runnerId)
		: PRE_EDIT_SEED_RUNNER_IDS.has(runnerId);
}

/**
 * Seeded entries kept per file. Past it the rest are not seeded, so they
 * block as they did before the seed (the direction of today's behaviour).
 */
export const MAX_PRE_EDIT_SEED_FINDINGS = 1_000;

/** The session fact holding a file's seed (absolute, normalized path). */
export function preEditSeedFactKey(filePath: string): string {
	return `session.preEdit.${filePath}`;
}

/**
 * The seed a capture installs: its blocking findings from seeded runners,
 * each stamped with the hash of its own line in the captured bytes, bounded.
 */
export function seedFromCapture(
	findings: readonly Diagnostic[],
	content: string,
	spanless = false,
): Diagnostic[] {
	const seeded = findings.filter(
		(d) =>
			d.semantic === "blocking" &&
			d.runnerId !== undefined &&
			isPreEditSeedRunner(d.runnerId, spanless) &&
			d.line !== undefined,
	);
	return stampLineHashes(
		seeded.slice(0, MAX_PRE_EDIT_SEED_FINDINGS),
		content,
		() => true,
	).filter((d) => d.lineHash !== undefined);
}

/** Whether `ranges` together cover lines 1 to `lineCount`. */
function coversEveryLine(
	ranges: readonly ModifiedRange[],
	lineCount: number,
): boolean {
	let next = 1;
	for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
		if (r.start > next) return false;
		next = Math.max(next, r.end + 1);
	}
	return next > lineCount;
}

/**
 * Split `current` (this dispatch's blocking findings) into the ones the seed
 * holds and the rest, and return the seed the next dispatch reads.
 *
 * `answered` is the set of runners that reached a verdict in this dispatch:
 * a seeded entry whose runner did not stays seeded. A matched entry is
 * replaced by its current copy, stamped with its line in `content`.
 *
 * `modifiedRanges` is the dispatch's edit span. A span that leaves lines of
 * `content` out (a host `edit`) makes the edit-gated lanes report only the
 * lines it touched, so the seed's whole-file entries of those lanes cannot
 * tell an inherited finding from an identical one the edit added 30 lines
 * away, and a stale entry (a no-op writer's, a read-only tool's, a line the
 * edit fixed) would excuse it. Such a dispatch neither classifies by them nor
 * keeps them; a later whole-file dispatch is judged without them, as before
 * #5553 (fail closed, #5583 review F1). No span, or one that covers every line
 * (a write's), is a whole-file dispatch: it reports every finding, so the
 * count rule above refuses the extra one.
 */
export function classifyPreExisting(
	seed: readonly Diagnostic[],
	current: readonly Diagnostic[],
	content: string,
	answered: ReadonlySet<string>,
	modifiedRanges?: readonly ModifiedRange[],
): { preExisting: Diagnostic[]; nextSeed: Diagnostic[] } {
	const lines = content.split(/\r?\n/);
	const hashAt = (line: number | undefined): number | undefined => {
		if (line === undefined) return undefined;
		const text = lines[line - 1];
		return text === undefined ? undefined : lineHashOf(text);
	};
	const spanGated =
		modifiedRanges !== undefined &&
		modifiedRanges.length > 0 &&
		!coversEveryLine(modifiedRanges, lines.length);
	const usable = (d: Diagnostic): boolean =>
		!spanGated ||
		d.runnerId === undefined ||
		!PRE_EDIT_EDIT_GATED_RUNNER_IDS.has(d.runnerId);
	const candidates = current.filter(
		(d) =>
			d.runnerId !== undefined &&
			PRE_EDIT_SEED_SPANLESS_RUNNER_IDS.has(d.runnerId),
	);
	const { kept } = retainRecordedFindings(seed.filter(usable), candidates, {
		positionOf: () => ANY_POSITION,
		keepUnobserved: (d) =>
			d.runnerId === undefined || !answered.has(d.runnerId),
		matchesAnywhere: (prior, observed) =>
			prior.lineHash !== undefined && prior.lineHash === hashAt(observed.line),
	});
	const observed = new Set<Diagnostic>(candidates);
	const preExisting = kept.filter((d) => observed.has(d));
	return {
		preExisting,
		nextSeed: stampLineHashes(kept, content, (d) => observed.has(d)),
	};
}
