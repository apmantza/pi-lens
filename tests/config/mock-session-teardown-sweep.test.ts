import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PI_MOCK_IMPORTERS } from "../support/pi-mock-importers.js";
import { assertNonEmptyScan, stripSource } from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

/**
 * Recurrence prevented (#5146): a test file that emitted `session_start` on the
 * pi double and never ended the session left the `ast-grep lsp` child its
 * `tool_result` spawned alive in the worker. The child outlived its file and
 * reached `tests/index-4632-s7-turn-end-ordering.test.ts`'s orphan sweep, which
 * the #2042 kill guard refused: `kill pid -6885 (SIGKILL)` on PR #5161 shard 5,
 * job 124892873231. 22 importers of the double started sessions that way.
 *
 * The population is `PI_MOCK_IMPORTERS`, the closed list of files allowed to
 * load the double, so a new session-starting test cannot sit outside it. A
 * file in it that starts a session must end it through a form this scan
 * recognizes:
 *
 * - the shared teardown, `endMockSessions` imported from
 *   `tests/support/mock-session-teardown.ts` and called; or
 * - a hand-written `.emit("session_shutdown", ...)` call (the pre-#5146 files
 *   that already ended their sessions).
 *
 * Everything else refuses. A start is any quoted `session_start` literal in
 * code, or an `.emit(` / `getHandlers(` call whose first argument is not a
 * literal (the event name is then unresolved, so the file may start one).
 * Comments are blanked and strings kept: the evidence for a start is a string
 * literal, and a comment that names the helper never satisfies the scan.
 */
const TESTS_ROOT = resolve(import.meta.dirname, "..");

const START_LITERAL = /["'`]session_start["'`]/;
const UNRESOLVED_EVENT =
	/\.emit\(\s*(?![\s"'`])|\bgetHandlers?(?:OrThrow)?\(\s*(?![\s"'`])/;
const SHARED_IMPORT =
	/\bimport\s*\{[^}]*\bendMockSessions\b[^}]*\}\s*from\s*["'][^"']*\/mock-session-teardown\.js["']/;
const SHARED_CALL = /\bendMockSessions\s*\(/;
const HAND_SHUTDOWN = /\.emit\(\s*["'`]session_shutdown["'`]/;

/** Whether `source` may start a session on the double. */
export function startsSession(source: string): boolean {
	const code = stripSource(source, { strings: "keep" });
	return START_LITERAL.test(code) || UNRESOLVED_EVENT.test(code);
}

/** Whether `source` ends its sessions through a form the scan recognizes. */
export function endsSessions(source: string): boolean {
	const code = stripSource(source, { strings: "keep" });
	// The call is read from code with strings blanked, so a quoted
	// `endMockSessions(` never counts; the import path needs its string.
	const calls = stripSource(source, { strings: "blank" });
	return (
		(SHARED_IMPORT.test(code) && SHARED_CALL.test(calls)) ||
		HAND_SHUTDOWN.test(code)
	);
}

describe("every importer of the pi double that starts a session ends it (#5146)", () => {
	const files = Object.keys(PI_MOCK_IMPORTERS).map((key) => ({
		key,
		source: readFileSync(resolve(TESTS_ROOT, key), "utf8"),
	}));

	it(
		"ends every session through the shared teardown or a session_shutdown emit",
		() => {
			assertNonEmptyScan("pi-mock importers", files.length, 40);
			const starters = files.filter(({ source }) => startsSession(source));
			// A scan that matched no starter would pass on nothing.
			assertNonEmptyScan("importers that start a session", starters.length, 20);
			const leaking = starters
				.filter(({ source }) => !endsSessions(source))
				.map(
					({ key }) =>
						`tests/${key}: starts a session and does not end it; call endMockSessions from tests/support/mock-session-teardown.ts first in its afterEach (#5146)`,
				);
			expect(leaking).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	const IMPORT =
		'import { endMockSessions } from "./support/mock-session-teardown.js";\n';

	describe("the scan reads code, not prose", () => {
		it.each([
			["a quoted literal", 'await pi.emit("session_start", e, ctx);\n'],
			["a template literal", "await pi.emit(`session_start`, e, ctx);\n"],
			[
				"an aliased emit",
				'const go = pi.emit;\nawait go("session_start", e, ctx);\n',
			],
			[
				"a name held in another binding",
				'const evt = "session_start";\nawait pi.emit(evt, e, ctx);\n',
			],
			[
				"a name built at run time",
				'const evt = ["session", "start"].join("_");\nawait pi.emit(evt, e, ctx);\n',
			],
			[
				"a destructured emit",
				'const { emit } = pi;\nawait emit("session_start", e, ctx);\n',
			],
			[
				"a direct handler call",
				'await pi.getHandlers("session_start")[0](e, ctx);\n',
			],
			[
				"a handler picked by a variable",
				"await pi.getHandlerOrThrow(name)(e, ctx);\n",
			],
		])("starts a session through %s", (_name, source) => {
			expect(startsSession(source)).toBe(true);
		});

		it.each([
			["a comment", '// pi.emit("session_start", e, ctx)\n'],
			["a block comment", '/* await pi.emit("session_start") */\n'],
			["an emit of another event", 'await pi.emit("tool_result", e, ctx);\n'],
		])("does not start a session through %s", (_name, source) => {
			expect(startsSession(source)).toBe(false);
		});

		it.each([
			[
				"an import and a call",
				`${IMPORT}afterEach(async () => { await endMockSessions(); });\n`,
			],
			[
				"a hand-written shutdown emit",
				'await pi.emit("session_shutdown", { reason: "quit" }, ctx);\n',
			],
		])("recognizes %s as an end", (_name, source) => {
			expect(endsSessions(source)).toBe(true);
		});

		it.each([
			[
				"a comment naming the helper",
				`// ${IMPORT.trim()}\n// endMockSessions()\n`,
			],
			["an import with no call", IMPORT],
			["a call with no import", "await endMockSessions();\n"],
			[
				"a call quoted in a string",
				`${IMPORT}const s = "endMockSessions()";\n`,
			],
			[
				"a local function of the same name",
				"async function endMockSessions() {}\nawait endMockSessions();\n",
			],
			[
				"the helper imported under an alias",
				'import { endMockSessions as end } from "./support/mock-session-teardown.js";\nawait end();\n',
			],
			[
				"a helper from another module",
				'import { endMockSessions } from "./support/other.js";\nawait endMockSessions();\n',
			],
			[
				"a shutdown named only in a comment",
				'// pi.emit("session_shutdown")\n',
			],
			[
				"a shutdown named only in a test title",
				'it("emits session_shutdown", () => {});\n',
			],
			[
				"a shutdown handler read but never emitted",
				'const h = pi.getHandlers("session_shutdown");\n',
			],
		])("does not recognize %s as an end", (_name, source) => {
			expect(endsSessions(source)).toBe(false);
		});
	});
});
