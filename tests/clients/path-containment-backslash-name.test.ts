/**
 * A backslash in a POSIX file name is a name character, so containment must not
 * fold it into a separator.
 *
 * Recurrence guarded (measured on master ab4bec579 through classifyAnalysisRoot):
 * isUnderDir and isWithinIdentity read the sibling directory "<root>\evil" as
 * "<root>/evil", so a file in a directory next to the session root classified as
 * "session", while isSameOrWithin, isWithinPathForm (#4876 review r2 F1) and
 * relativeInside answered "outside". The family disagreed on one input, and the
 * main containment seam was the wrong half. Shapes 2 and 35: the value's SHAPE
 * selects the fold, never the host.
 *
 * Real: classifyAnalysisRoot (the production caller), isUnderDir,
 * isWithinIdentity and the three predicates they must agree with, over real
 * directories whose names hold a backslash. Only a POSIX name can hold one, so
 * the cells skip on win32 (lane: Unit tests Linux; Windows cannot create the
 * directory).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyAnalysisRoot } from "../../clients/analysis-root.js";
import { isWithinPathForm } from "../../clients/file-utils.js";
import { isSameOrWithin } from "../../clients/lsp/server.js";
import {
	isUnderDir,
	isWithinIdentity,
	relativeInside,
} from "../../clients/path-utils.js";
import { setupTestEnvironment } from "./test-utils.js";

const posixOnly = process.platform === "win32";

let env: { tmpDir: string; cleanup: () => void };
let session: string;
let sibling: string;
let siblingFile: string;
let childFile: string;

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-bslash-name-");
	session = path.join(env.tmpDir, "proj");
	// A real directory whose NAME is proj\evil: a sibling of proj, not a child.
	sibling = path.join(env.tmpDir, "proj\\evil");
	fs.mkdirSync(path.join(session, ".git"), { recursive: true });
	fs.mkdirSync(path.join(sibling, ".git"), { recursive: true });
	siblingFile = path.join(sibling, "a.ts");
	childFile = path.join(session, "b.ts");
	fs.writeFileSync(siblingFile, "export const a = 1;\n");
	fs.writeFileSync(childFile, "export const b = 1;\n");
});

afterEach(() => env.cleanup());

describe.skipIf(posixOnly)(
	"containment reads a POSIX backslash as a name",
	() => {
		it("the three sibling predicates read the sibling as outside", () => {
			// The agreement the seam must keep: these answered correctly before the fix.
			expect(isSameOrWithin(session, siblingFile)).toBe(false);
			expect(isWithinPathForm(siblingFile, session)).toBe(false);
			expect(relativeInside(session, siblingFile)).toBeUndefined();
		});

		it("isUnderDir reads a sibling directory named proj\\evil as outside proj", () => {
			expect(isUnderDir(siblingFile, session)).toBe(false);
			expect(isUnderDir(sibling, session)).toBe(false);
		});

		it("isWithinIdentity reads a sibling directory named proj\\evil as outside proj", () => {
			expect(isWithinIdentity(siblingFile, session)).toBe(false);
		});

		it("classifyAnalysisRoot does not call a file in the sibling a session file", () => {
			const outside = classifyAnalysisRoot(siblingFile, session);
			expect(outside.mode).not.toBe("session");
			expect(outside.root).not.toBe(session);
			// The control: a real child of the session is still the session's.
			expect(classifyAnalysisRoot(childFile, session)).toEqual({
				mode: "session",
				root: session,
			});
		});

		it("a backslash inside the root's own tree still counts as inside", () => {
			const odd = path.join(session, "sub\\name");
			fs.mkdirSync(odd, { recursive: true });
			const oddFile = path.join(odd, "c.ts");
			fs.writeFileSync(oddFile, "export const c = 1;\n");
			expect(isUnderDir(oddFile, session)).toBe(true);
			expect(isWithinIdentity(oddFile, session)).toBe(true);
			expect(classifyAnalysisRoot(oddFile, session).mode).toBe("session");
		});

		it("a root whose own name holds a backslash contains its children and not its folded twin", () => {
			const oddRoot = path.join(env.tmpDir, "pro\\j");
			fs.mkdirSync(oddRoot, { recursive: true });
			const inside = path.join(oddRoot, "a.ts");
			fs.writeFileSync(inside, "export {};\n");
			const folded = path.join(env.tmpDir, "pro", "j", "a.ts");
			expect(isUnderDir(inside, oddRoot)).toBe(true);
			expect(isUnderDir(folded, oddRoot)).toBe(false);
			expect(isWithinIdentity(folded, oddRoot)).toBe(false);
		});

		it("a root spelled through a link still contains a file under a backslash name", () => {
			// The identity axis stays on for a backslash name: a key under a session
			// rooted at a link meets the root there, as it does for every other name.
			const odd = path.join(session, "sub\\name");
			fs.mkdirSync(odd, { recursive: true });
			const oddFile = path.join(odd, "c.ts");
			fs.writeFileSync(oddFile, "export const c = 1;\n");
			const alias = path.join(env.tmpDir, "alias");
			fs.symlinkSync(session, alias, "dir");
			expect(isUnderDir(oddFile, alias)).toBe(true);
			expect(isWithinIdentity(oddFile, alias)).toBe(true);
		});

		it("a Windows-shaped spelling still folds its separators on a POSIX host", () => {
			// Shape 35: the fold follows the value's shape, so the win32 arm keeps its
			// semantics on every lane.
			expect(isUnderDir("C:\\repo\\src\\a.ts", "C:\\repo")).toBe(true);
			expect(isUnderDir("c:\\REPO\\src\\a.ts", "C:/repo")).toBe(true);
			expect(isUnderDir("C:\\repository\\a.ts", "C:\\repo")).toBe(false);
		});
	},
);
