import * as fs from "node:fs";
import * as path from "node:path";
import { expect, it } from "vitest";
import {
	explainServersForFile,
	getServersForFileWithConfig,
} from "../../../clients/lsp/config.js";
import { setupTestEnvironment } from "../test-utils.js";

const bashSelected = (file: string): boolean =>
	getServersForFileWithConfig(file).some((server) => server.id === "bash");

// #3969 narrowed Bash's extensions, but zsh still reached it through .sh/.bash.
it("keeps zsh out of Bash LSP and rechecks the current bytes", () => {
	const env = setupTestEnvironment("pi-lens-bash-dialect-");
	try {
		for (const extension of ["sh", "bash"]) {
			const file = path.join(env.tmpDir, `script.${extension}`);
			for (const [content, selected] of [
				["#!/bin/sh\necho ok\n", true],
				["#!/usr/bin/env zsh\nautoload -Uz compinit\n", false],
				["#!/usr/bin/env -S zsh -f\nautoload -Uz compinit\n", false],
				["#!/bin/zsh\nautoload -Uz compinit\n", false],
				["# shellcheck shell=zsh\nautoload -Uz compinit\n", false],
				["#!/usr/bin/env zsh\n# shellcheck shell=bash\necho ok\n", true],
				["echo ok\n", true],
			] as const) {
				fs.writeFileSync(file, content);
				expect(
					bashSelected(file),
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

// F1 (maintainer decision, #5230 r2): the filter is zsh-only. #3968 AC1 leaves
// the LSP lane otherwise unchanged, so every other dialect keeps master's
// behaviour. Recurrence: the round-1 head dropped these ten off the Bash LSP
// through the ShellCheck runner's categorical dialect set (symbols, navigation
// and completion lost for files ShellCheck merely cannot lint).
it("keeps every non-zsh dialect on the Bash LSP", () => {
	const env = setupTestEnvironment("pi-lens-bash-dialect-nonzsh-");
	try {
		const file = path.join(env.tmpDir, "script.sh");
		const dropped: string[] = [];
		const reasons: string[] = [];
		for (const shebang of [
			"#!/bin/ash",
			"#!/bin/ksh93",
			"#!/bin/mksh",
			"#!/usr/bin/env nix-shell",
			"#!/usr/bin/env -i bash",
			"#!/usr/bin/env FOO=1 bash",
			"#!/usr/bin/python3",
			"#!/usr/bin/bash.real",
			"#!/usr/bin/rc",
			"#!/bin/zshell-not-zsh",
		]) {
			fs.writeFileSync(file, `${shebang}\necho ok\n`);
			if (!bashSelected(file)) dropped.push(shebang);
			const reason = explainServersForFile(file).find(
				({ server }) => server.id === "bash",
			)?.reason;
			if (reason !== "selected") reasons.push(`${shebang}: ${reason}`);
		}
		expect(dropped).toEqual([]);
		expect(reasons).toEqual([]);
	} finally {
		env.cleanup();
	}
});

// F2 (#5230 r1): pins the 4 KB read bound and the fail-open arms.
// Recurrences: dropping `subarray(0, bytesRead)` turns `#!/bin/sh` with no
// newline into `sh\0\0...`; widening the bound reads a late directive the
// resolver must ignore; a missing .sh must keep today's fail-open selection.
it("bounds the dialect sniff and fails open on short, late or missing input", () => {
	const env = setupTestEnvironment("pi-lens-bash-dialect-sniff-");
	try {
		const file = path.join(env.tmpDir, "script.sh");
		// Short file without a trailing newline: a stale buffer tail must not
		// leak into the interpreter name. NUL padding after "#!/bin/zsh" would
		// make the dialect "zsh\0..." and slip past a zsh-only gate.
		fs.writeFileSync(file, "#!/bin/zsh");
		expect(bashSelected(file), "no-newline zsh shebang").toBe(false);
		// A zsh directive past the 4096-byte sniff window is never read.
		fs.writeFileSync(
			file,
			`${"# padding padding padding padding\n".repeat(200)}# shellcheck shell=zsh\necho ok\n`,
		);
		expect(
			fs.statSync(file).size > 4096,
			"fixture exceeds the sniff window",
		).toBe(true);
		expect(bashSelected(file), "directive after 4096 bytes").toBe(true);
		// A missing file fails open to the bash default.
		expect(bashSelected(path.join(env.tmpDir, "missing.sh")), "missing").toBe(
			true,
		);
	} finally {
		env.cleanup();
	}
});
