import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LEAN_ROOT_MARKERS } from "../../clients/file-kinds.js";
import { LeanServer } from "../../clients/lsp/server.js";
import { resolveLanguageRootForFile } from "../../clients/language-profile.js";
import { removeTempDirSync } from "./test-utils.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("Lean Lake root markers", () => {
	it.each(LEAN_ROOT_MARKERS)(
		"anchors both root resolvers at %s",
		async (marker) => {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lean-root-"));
			dirs.push(tmp);
			const workspace = path.join(tmp, "workspace");
			const project = path.join(workspace, "nested");
			const file = path.join(project, "src", "Main.lean");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(path.join(project, marker), "");
			fs.writeFileSync(file, "#check Nat\n");

			await expect(LeanServer.root(file)).resolves.toBe(project);
			expect(resolveLanguageRootForFile(file, workspace)).toBe(project);
		},
	);
});
