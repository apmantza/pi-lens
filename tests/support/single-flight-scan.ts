/**
 * Ratchet scan for hand-rolled at-most-one-in-flight state — #1753.
 *
 * `clients/single-flight.ts` owns the four guards that the ten hand-rolled
 * copies kept getting wrong (#1690, #1674, #1687, #1722). A primitive nobody
 * reaches for is a primitive that decays, so this scan makes the NEXT copy
 * argue for itself: any new module-level or class-field declaration whose name
 * contains `inFlight` fails until it is either built on the primitive or listed
 * with a reason.
 *
 * It is a ratchet, not a migration. Everything the scan finds today is listed;
 * the list is the burn-down backlog, and each entry says why it is still there.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
	clientSourceFiles,
	clientsRelative,
	stripCommentsAndStrings,
} from "./session-state-scan.js";

/** One `inFlight`-named declaration the scan found. */
export interface InFlightDeclaration {
	/** `clients/`-relative posix path. */
	file: string;
	/** The declared identifier. */
	symbol: string;
	/** 1-based line number in the original source. */
	line: number;
	/** `file:symbol` — the key exemptions are written against. */
	key: string;
}

/**
 * Declarations this scan can see, and the three it cannot.
 *
 * IN, three forms:
 *
 * 1. module-level `const`/`let`/`var` at column 0;
 * 2. class fields carrying an accessibility, `readonly`, `static` or `abstract`
 *    modifier, at any indent;
 * 3. modifier-less class fields — both `#private` ones, which the `#` makes
 *    unambiguous, and plain ones carrying a TYPE ANNOTATION. Review round 1
 *    caught this gap: `probeInFlight: Promise<void> | null = null;` is the
 *    migrated sites' exact field minus the word `private`, and the first
 *    version of this regex sailed straight past it.
 *
 * OUT, stated rather than papered over:
 *
 * 1. state closed over inside a factory function (`createChecker`'s
 *    `inFlightByCwd` in `runner-helpers.ts`) — indistinguishable from a plain
 *    function local by shape alone, and flagging every local named `inFlight`
 *    would make the ratchet noise rather than signal;
 * 2. in-flight state whose name does not contain `inFlight`
 *    (`refreshRepullRunning` in `lsp/client.ts` is exactly that, which is part
 *    of why #1687 went unnoticed);
 * 3. a modifier-less, UNANNOTATED class field (`inFlight = new Map();` with no
 *    `private` and no type). By shape that is identical to a bare assignment to
 *    a closure variable — `ensureInFlight = null;` at
 *    `dispatch/runners/utils/toolchain-availability.ts:139` is exactly that —
 *    and this scan chooses the false negative over flagging every
 *    clear-in-finally in the repo.
 *
 * All three are FALSE NEGATIVES. The ratchet still catches the common case,
 * which is the copy someone writes by pattern-matching a sibling client.
 *
 * FALSE POSITIVES are the safe direction, which is why they are not enumerated:
 * they announce themselves. The widened regex also matches things that are not
 * declarations at all — object-literal properties and parameter annotations —
 * so `lsp/index.ts`'s `inFlight` matches both at its interface member (:204)
 * and at its object-literal initializer (:1198). Both collapse to one
 * `file:symbol` key, and any such match simply demands an exemption that a
 * person then writes or dismisses. A false negative is silent and ships the
 * next copy of the bug; a false positive costs one line and a moment's thought.
 */
/**
 * Three alternatives, in the order the doc comment lists them: a module-level
 * binding, a modified class field, and a modifier-less class field that is
 * either `#private` or type-annotated.
 */
const DECLARATION = new RegExp(
	[
		"^(?:",
		/*  1 */ "(?:export\\s+)?(?:const|let|var)\\s+#?",
		"|",
		/*  2 */ "[\\t ]+(?:(?:private|protected|public|static|readonly|abstract)\\s+)+#?",
		"|",
		/* 3a */ "[\\t ]+#",
		")([\\w$]*[iI]nFlight[\\w$]*)\\s*[:=]",
		/* 3b */ "|^[\\t ]+([\\w$]*[iI]nFlight[\\w$]*)\\s*(?:\\?\\s*)?:(?!:)",
	].join(""),
	"gm",
);

/** Find every `inFlight`-named module-state declaration in one source text. */
export function findInFlightDeclarations(
	file: string,
	source: string,
): InFlightDeclaration[] {
	// Comments and strings are blanked first, length-preserving, so a doc
	// comment that merely NAMES a field cannot be read as a declaration of it —
	// the same false-positive mode `session-state-scan.ts` documents.
	const stripped = stripCommentsAndStrings(source);
	const found: InFlightDeclaration[] = [];
	DECLARATION.lastIndex = 0;
	for (;;) {
		const match = DECLARATION.exec(stripped);
		if (match === null) break;
		// Group 1 is the modified/module form, group 2 the annotated
		// modifier-less field. Exactly one of them participates per match.
		const symbol = match[1] ?? match[2];
		found.push({
			file,
			symbol,
			line: stripped.slice(0, match.index).split("\n").length,
			key: `${file}:${symbol}`,
		});
	}
	return found;
}

/** The module that owns the primitive, which is exempt by definition. */
const PRIMITIVE_MODULE = "single-flight.ts";

/** Scan every `clients/` source for hand-rolled in-flight declarations. */
export function scanInFlightDeclarations(): InFlightDeclaration[] {
	return clientSourceFiles()
		.map((absolute) => ({
			file: clientsRelative(absolute),
			source: fs.readFileSync(absolute, "utf8"),
		}))
		.filter(({ file }) => path.posix.basename(file) !== PRIMITIVE_MODULE)
		.flatMap(({ file, source }) => findInFlightDeclarations(file, source));
}
