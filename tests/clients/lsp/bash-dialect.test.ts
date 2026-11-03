import * as fs from "node:fs";
import * as path from "node:path";
import { expect, it } from "vitest";
import {
	explainServersForFile,
	getServersForFileWithConfig,
} from "../../../clients/lsp/config.js";
import { setupTestEnvironment } from "../test-utils.js";

// #3969 narrowed Bash's extensions, but zsh still reached it through .sh/.bash.
it("keeps unsupported dialects out of Bash LSP and rechecks the current bytes", () => {
	const env = setupTestEnvironment("pi-lens-bash-dialect-");
	try {
		for (const extension of ["sh", "bash"]) {
			const file = path.join(env.tmpDir, `script.${extension}`);
			for (const [content, selected] of [
				["#!/bin/sh\necho ok\n", true],
				["#!/usr/bin/env zsh\nautoload -Uz compinit\n", false],
				["# shellcheck shell=zsh\nautoload -Uz compinit\n", false],
				["#!/usr/bin/env zsh\n# shellcheck shell=bash\necho ok\n", true],
				["echo ok\n", true],
			] as const) {
				fs.writeFileSync(file, content);
				expect(
					getServersForFileWithConfig(file).some(
						(server) => server.id === "bash",
					),
					`${extension}: ${content.split("\n")[0]}`,
				).toBe(selected);
				expect(
					explainServersForFile(file).find(({ server }) => server.id === "bash")
						?.reason,
				).toBe(selected ? "selected" : "path-filter");
			}
		}
	} finally {
		env.cleanup();
	}
});
