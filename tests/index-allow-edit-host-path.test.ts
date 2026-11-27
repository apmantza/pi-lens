/**
 * `/lens-allow-edit <path>` resolves the path the way pi opens it (shape 74).
 *
 * RECURRENCE GUARDED: the command resolved its argument with a bare
 * `path.resolve(cwd, raw)`. A user who typed `@src/shared.ts` or
 * `~/proj/src/shared.ts` armed the one-time exemption for `<cwd>/@src/...` or
 * `<cwd>/~/...`, a path that cannot exist, and the model's next edit of the
 * real file was still refused "Edit without read". The `tool_call` seam keys
 * the same file through `resolveToolCallFilePath` (#4576, #4577).
 *
 * Tier 2 (#4632): the BUILT extension in a real pi `AgentSession`; the command
 * is delivered as a prompt and the edit is the model's own tool call.
 *
 * Lane: ubuntu Unit tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { pinFixtureHome } from "./clients/test-utils.js";
import {
	CLEAN_FILE,
	endTurn,
	step,
	toolResults,
} from "./support/pi-session-commit-gate.js";
import {
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

const EDIT_WITHOUT_READ = "Edit without read";

describe("/lens-allow-edit path spelling (shape 74)", () => {
	it.each([
		["src/shared.ts", "a relative path"],
		["./src/shared.ts", "a dot-relative path"],
		["@src/shared.ts", "an @-prefixed path"],
		["~/proj/src/shared.ts", "a home-relative path"],
	])(
		"arms the exemption for the path %s (%s)",
		{ timeout: 60_000 },
		async (spelling) => {
			const { home } = pinFixtureHome("allow-edit-host-path");
			const proj = path.join(home, "proj");
			fs.mkdirSync(path.join(proj, "src"), { recursive: true });
			fs.writeFileSync(path.join(proj, "src", "seed.ts"), CLEAN_FILE);
			const shared = path.join(proj, "src", "shared.ts");
			fs.writeFileSync(shared, "export function shared() {\n\treturn 1;\n}\n");
			const session = await startPiSession({
				root: fixture.root,
				cwd: proj,
				responses: [
					step(
						fauxToolCall("edit", {
							path: "src/shared.ts",
							edits: [{ oldText: "return 1;", newText: "return 2;" }],
						}),
						"editing",
					),
					endTurn("edited"),
				],
			});
			await session.prompt(`/lens-allow-edit ${spelling}`);
			await session.prompt("edit it");
			const last = session.requests.at(-1) ?? [];
			expect(toolResults(last, "edit")[0]?.text ?? "").not.toContain(
				EDIT_WITHOUT_READ,
			);
			expect(fs.readFileSync(shared, "utf8")).toContain("return 2;");
			expect(session.errors).toEqual([]);
			await session.dispose();
		},
	);

	it(
		"keys the exemption to the file a curly-quote spelling names, as the edit's own call does",
		{ timeout: 60_000 },
		async () => {
			// RECURRENCE GUARDED (shape 74, #5494 review F4): the file on disk is
			// `shared\u2019s.ts` (U+2019). The user types the straight apostrophe,
			// which names no file, so the command's resolution must take the
			// ladder's curly-quote variant to key the file the edit names. Plain
			// `resolveHostToolPath` keys the naive `shared's.ts`, the edit's
			// `shared\u2019s.ts` never matches, and the edit is refused "Edit without
			// read". pi's own edit tool does not run the ladder: the straight
			// spelling reads ENOENT there, so the edit names the on-disk file.
			const { home } = pinFixtureHome("allow-edit-host-path");
			const proj = path.join(home, "proj");
			fs.mkdirSync(path.join(proj, "src"), { recursive: true });
			fs.writeFileSync(path.join(proj, "src", "seed.ts"), CLEAN_FILE);
			const curly = path.join(proj, "src", "shared\u2019s.ts");
			fs.writeFileSync(curly, "export function shared() {\n\treturn 1;\n}\n");
			const session = await startPiSession({
				root: fixture.root,
				cwd: proj,
				responses: [
					step(
						fauxToolCall("edit", {
							path: "src/shared\u2019s.ts",
							edits: [{ oldText: "return 1;", newText: "return 2;" }],
						}),
						"editing",
					),
					endTurn("edited"),
				],
			});
			await session.prompt("/lens-allow-edit src/shared's.ts");
			await session.prompt("edit it");
			const last = session.requests.at(-1) ?? [];
			expect(toolResults(last, "edit")[0]?.text ?? "").not.toContain(
				EDIT_WITHOUT_READ,
			);
			expect(fs.readFileSync(curly, "utf8")).toContain("return 2;");
			expect(session.errors).toEqual([]);
			await session.dispose();
		},
	);

	it(
		"arms nothing and fails nothing when the command names no path",
		{ timeout: 60_000 },
		async () => {
			// RECURRENCE GUARDED: the usage branch moved from `!rawTarget` onto the
			// resolver's own answer; a path-less command must still end there
			// instead of reading `.path` off an absent resolution.
			const { home } = pinFixtureHome("allow-edit-host-path");
			const proj = path.join(home, "proj");
			fs.mkdirSync(path.join(proj, "src"), { recursive: true });
			fs.writeFileSync(path.join(proj, "src", "seed.ts"), CLEAN_FILE);
			const shared = path.join(proj, "src", "shared.ts");
			fs.writeFileSync(shared, "export function shared() {\n\treturn 1;\n}\n");
			const session = await startPiSession({
				root: fixture.root,
				cwd: proj,
				responses: [
					step(
						fauxToolCall("edit", {
							path: "src/shared.ts",
							edits: [{ oldText: "return 1;", newText: "return 2;" }],
						}),
						"editing",
					),
					endTurn("edited"),
				],
			});
			await session.prompt("/lens-allow-edit");
			await session.prompt("edit it");
			const last = session.requests.at(-1) ?? [];
			expect(toolResults(last, "edit")[0]?.text ?? "").toContain(
				EDIT_WITHOUT_READ,
			);
			expect(fs.readFileSync(shared, "utf8")).toContain("return 1;");
			expect(session.errors).toEqual([]);
			await session.dispose();
		},
	);
});
