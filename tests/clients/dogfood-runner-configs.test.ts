import { hasToolConfig } from "../../clients/tool-config-presence.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { findLocalTyposConfig } from "../../clients/typos-config.js";

// This repo's own root config files activate dispatch runner lanes for
// pi-lens's own dogfood sessions (refs #1844): .oxlintrc.json, typos.toml,
// .yamllint, taplo.toml. Each detector below is already covered generically
// with synthetic tmpdir fixtures elsewhere in this file's sibling suite
// (tests/clients/tool-policy.test.ts, tests/clients/typos-config.test.ts);
// this test instead pins that OUR OWN root files are the ones actually
// found, so a rename/move/typo of any of the four breaks a test instead of
// silently going dark for every dogfood session on this repo.
const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

describe("dogfood runner config activation (#1844)", () => {
	it("hasOxlintConfig detects the repo's own .oxlintrc.json", () => {
		expect(hasToolConfig("oxlint", REPO_ROOT)).toBe(true);
	});

	it("findLocalTyposConfig detects the repo's own typos.toml", () => {
		expect(findLocalTyposConfig(REPO_ROOT)).toBe(
			path.join(REPO_ROOT, "typos.toml"),
		);
	});

	it("the yamllint config check detects the repo's own .yamllint", () => {
		expect(hasToolConfig("yamllint", REPO_ROOT)).toBe(true);
	});

	it("hasTaploConfig detects the repo's own taplo.toml", () => {
		expect(hasToolConfig("taplo", REPO_ROOT)).toBe(true);
	});
});
