/**
 * #2505: every NDJSON log sink shares ONE writer (`clients/ndjson-logger.ts`)
 * so a rotation fix lands once, not as N hand-rolled copies that can drift
 * back out of sync (the single-source-of-truth rule). This is the positive
 * half of that guarantee — every module that LOOKS like an ndjson log sink
 * (the established `*-logger.ts` naming convention, plus the small set of
 * known non-suffix producers) actually delegates to `createNdjsonLogger`
 * rather than defining its own private write/rotate path — and the second
 * half of it: delegating is not enough, the delegation has to actually
 * CONFIGURE a bound. `maxBytes` is optional on the writer, so an unbounded
 * sink is a one-word omission away, and three of them (diagnostic-logger,
 * review-graph-logger, sessionstart-logger) shipped exactly that way while
 * this file only asserted the import.
 *
 * The negative half — no `clients/*.ts` file does a raw `fs.appendFile(Sync)`
 * bypassing the shared seam — is already covered by
 * `tests/clients/atomic-write-sweep.test.ts` (`ndjson-logger.ts` is the ONLY
 * reviewed exemption for the append-only-NDJSON shape); this test does not
 * duplicate that scan.
 *
 * The population is DERIVED from disk at test-run time (mechanical, not
 * hand-maintained) so a new `*-logger.ts` module is covered automatically —
 * but a derived population can also go vacuously green if a rename ever
 * drops every file out of the glob (catalog shape 7), so a floor on the
 * derived count guards against that.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { clientSourceFiles, repoRoot } from "../support/atomic-write-scan.js";
import {
	assertNonEmptyScan,
	firstCommentMatch,
	stripSource,
} from "../support/sweep-kit.js";

const CREATE_LOGGER_IMPORT =
	/import\s*\{[^}]*\bcreateNdjsonLogger\b[^}]*\}\s*from\s*["']\.\/ndjson-logger\.js["']/;

export function hasCreateLoggerImport(source: string): boolean {
	return (
		firstCommentMatch(source, CREATE_LOGGER_IMPORT) !== undefined &&
		CREATE_LOGGER_IMPORT.test(stripSource(source, { strings: "keep" }))
	);
}

/** Known ndjson producers that do not match the `*-logger.ts` naming shape. */
const KNOWN_NON_SUFFIX_PRODUCERS = [
	"extension-log.ts",
	"debug-handles.ts",
	"debug-heap.ts",
];

/** One `createNdjsonLogger(...)` call site found under `clients/`. */
interface LoggerCallSite {
	/** Path relative to `clients/`, forward slashes. */
	file: string;
	/** 1-based line of the call. */
	line: number;
	/** The whole call expression, parens balanced. */
	text: string;
}

function relativeToClients(absolute: string): string {
	return path
		.relative(path.join(repoRoot, "clients"), absolute)
		.split(path.sep)
		.join("/");
}

/**
 * Every `createNdjsonLogger(` call in one source file, with its full argument
 * list. Paren-balanced rather than line- or regex-delimited: the option object
 * spans several lines in most sinks and a single line in others, and a regex
 * that only matched one of those shapes would silently under-report the very
 * omission this scan exists to catch.
 */
function loggerCallSites(absolute: string): LoggerCallSite[] {
	const source = stripSource(fs.readFileSync(absolute, "utf8"), {
		strings: "blank",
	});
	const sites: LoggerCallSite[] = [];
	const call = /createNdjsonLogger\s*\(/g;
	let match = call.exec(source);
	while (match !== null) {
		let depth = 0;
		let index = match.index + match[0].length - 1;
		for (; index < source.length; index += 1) {
			const ch = source[index];
			if (ch === "(") depth += 1;
			else if (ch === ")") {
				depth -= 1;
				if (depth === 0) break;
			}
		}
		sites.push({
			file: relativeToClients(absolute),
			line: source.slice(0, match.index).split("\n").length,
			text: source.slice(match.index, index + 1),
		});
		match = call.exec(source);
	}
	return sites;
}

function loggerModules(): string[] {
	return clientSourceFiles()
		.filter((file) => path.basename(file) !== "ndjson-logger.ts")
		.filter((file) => /-logger\.ts$/.test(path.basename(file)));
}

/**
 * Every `clients/` module that actually CALLS `createNdjsonLogger` — the
 * `*-logger.ts` naming population above PLUS the non-suffix producers (#2516,
 * refs #2506/#2511). This is the population the log-dir resolver conformance
 * test below screens, since it is exactly the set of modules that write into
 * one of the two machine-global roots the #2506 split created.
 */
function createLoggerCallerModules(): string[] {
	return clientSourceFiles()
		.filter((file) => path.basename(file) !== "ndjson-logger.ts")
		.filter((file) => hasCreateLoggerImport(fs.readFileSync(file, "utf8")));
}

describe("NDJSON writer conformance (#2505)", () => {
	it("every *-logger.ts module (except ndjson-logger.ts itself) delegates to createNdjsonLogger", () => {
		const population = loggerModules();

		// Floor, not an exact count: a derived population that silently drops
		// to zero (e.g. after a mass rename) would make every assertion below
		// vacuously true. Currently 13 files match; keep some margin below
		// that so an unrelated future removal does not make this test flaky.
		assertNonEmptyScan("clients/*-logger.ts population", population.length, 10);

		const violations = population
			.map((file) => ({
				file: relativeToClients(file),
				source: fs.readFileSync(file, "utf8"),
			}))
			.filter(({ source }) => !hasCreateLoggerImport(source))
			.map(({ file }) => file);

		expect(violations).toEqual([]);
	});

	it("known non-suffix ndjson producers also delegate to createNdjsonLogger", () => {
		const clientsRoot = path.join(repoRoot, "clients");
		for (const name of KNOWN_NON_SUFFIX_PRODUCERS) {
			const source = fs.readFileSync(path.join(clientsRoot, name), "utf8");
			expect(
				hasCreateLoggerImport(source),
				`${name} should import createNdjsonLogger`,
			).toBe(true);
		}
	});

	it("every createNdjsonLogger call site under clients/ configures a maxBytes bound", () => {
		const sites = clientSourceFiles()
			.filter((file) => path.basename(file) !== "ndjson-logger.ts")
			.flatMap((file) => loggerCallSites(file));

		assertNonEmptyScan(
			"clients/ createNdjsonLogger call sites",
			sites.length,
			12,
		);

		const unbounded = sites
			.filter((site) => !/\bmaxBytes\s*:/.test(site.text))
			.map((site) => `${site.file}:${site.line}`);

		// An unbounded sink is the #2505 defect itself: no size check runs on
		// the write path at all, so the file grows until the once-per-process
		// session-start sweep happens to look at it — which, in a long-lived
		// process (the warm MCP server), may be never.
		expect(unbounded).toEqual([]);
	});

	it("every createNdjsonLogger caller resolves its directory through getGlobalPiLensLogDir, never getGlobalPiLensDir (#2516)", () => {
		// #2506 split machine-global state into two resolvers:
		// `getGlobalPiLensDir()` for state a session must KEEP across restarts
		// (installed tools, the instance registry), and
		// `getGlobalPiLensLogDir()` for the log family, which alone gets the
		// per-worktree/tmpdir probe redirect. A new logger wired to the wrong
		// resolver silently loses that redirect and leaks straight into the
		// maintainer's real `~/.pi-lens` the moment it runs as an ad-hoc probe
		// — the exact #2506 shape, one module at a time. The population is
		// DERIVED (every `createNdjsonLogger` caller under `clients/`), so a new
		// logger is covered automatically without a hand-maintained list.
		const population = createLoggerCallerModules();

		assertNonEmptyScan(
			"clients/ createNdjsonLogger caller population",
			population.length,
			12,
		);

		const sources = population.map((file) => ({
			file: relativeToClients(file),
			source: fs.readFileSync(file, "utf8"),
		}));

		const wrongResolver = sources
			.filter(({ source }) =>
				/\bgetGlobalPiLensDir\s*\(/.test(
					stripSource(source, { strings: "blank" }),
				),
			)
			.map(({ file }) => file);
		expect(wrongResolver).toEqual([]);

		// #2516 round 2, F4: banning the WRONG resolver is only half the rule.
		// A logger that hand-rolls `path.join(os.homedir(), ".pi-lens")` — or
		// takes any other route to a log root — names neither resolver and
		// passed the ban above while missing the redirect entirely. Require the
		// RIGHT one positively, so the only way into this population is through
		// the seam that carries the redirect.
		const noResolver = sources
			.filter(
				({ source }) =>
					!/\bgetGlobalPiLensLogDir\s*\(/.test(
						stripSource(source, { strings: "blank" }),
					),
			)
			.map(({ file }) => file);
		expect(noResolver).toEqual([]);
	});

	it("does not count a commented-out logger import", () => {
		expect(
			hasCreateLoggerImport(
				'// import { createNdjsonLogger } from "./ndjson-logger.js"\n',
			),
		).toBe(false);
		expect(
			hasCreateLoggerImport(
				'import { createNdjsonLogger } from "./ndjson-logger.js"\n',
			),
		).toBe(true);
		expect(
			hasCreateLoggerImport(
				"const prose = \"import { createNdjsonLogger } from './ndjson-logger.js'\";\n",
			),
		).toBe(false);
		expect(
			hasCreateLoggerImport(
				"const prose = `import { createNdjsonLogger } from './ndjson-logger.js'`;\n",
			),
		).toBe(false);
	});
});
