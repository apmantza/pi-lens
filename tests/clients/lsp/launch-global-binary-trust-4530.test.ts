/**
 * #4530: the LSP launcher's global binary lookups honour project trust.
 *
 * `launchLSP` resolves a bare server name through PATH and the package
 * managers' global bin dirs, and the server it starts resolves its own
 * runtime through the same PATH. Under pi trust `unknown`, none of that may
 * land inside the project, and project configuration may not redirect the
 * global lookup; a trusted project behaves as before. Each case launches a
 * real child; the project fixtures are shell scripts that leave a marker when
 * they run. Recurrence guarded: a lookup outside the project-local refusal
 * (#4248, #4515) still starting project code.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	type LSPProcess,
	launchLSP,
	stopLSP,
} from "../../../clients/lsp/launch.js";
import { resolveAndLaunch } from "../../../clients/lsp/server.js";
import { _resetPackageManagerCache } from "../../../clients/package-manager.js";
import { SpawnFailureError } from "../../../clients/safe-spawn.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import { removeTempDirSync } from "../test-utils.js";

const SERVER = "pi-lens-4530-fixture-server";
/** A server name nothing installs: the launcher resolves it to no file at all. */
const MISSING_SERVER = "pi-lens-4530-fixture-not-installed";
const originalCwd = process.cwd();
const originalPath = process.env.PATH;
const originalPrefix = process.env.npm_config_prefix;
const dirs: string[] = [];
const launched: LSPProcess[] = [];

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function makeProject() {
	const root = tempDir("pi-lens-4530-launch-");
	fs.writeFileSync(path.join(root, "package.json"), "{}\n");
	const marker = path.join(root, "executed.marker");
	return {
		root,
		marker,
		ran: (): boolean => fs.existsSync(marker),
	};
}

/** A shell fixture that records that it ran, then stays up like a server. */
function plant(file: string, marker: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexec sleep 5\n`,
		{ mode: 0o755 },
	);
	return file;
}

async function launch(
	command: string,
	cwd: string,
): Promise<LSPProcess | Error> {
	try {
		const proc = await launchLSP(command, ["--stdio"], { cwd });
		launched.push(proc);
		return proc;
	} catch (error) {
		return error as Error;
	}
}

beforeEach(() => {
	delete process.env.npm_config_prefix;
	resetProjectTrust();
	resetDegradationLedger();
	_resetPackageManagerCache();
});

afterEach(async () => {
	while (launched.length) await stopLSP(launched.pop() as LSPProcess);
	process.chdir(originalCwd);
	process.env.PATH = originalPath;
	if (originalPrefix === undefined) delete process.env.npm_config_prefix;
	else process.env.npm_config_prefix = originalPrefix;
	resetProjectTrust();
	_resetPackageManagerCache();
	while (dirs.length) removeTempDirSync(dirs.pop() as string);
});

// lane: Linux and macOS lsp-spawn-heavy shard; the fixtures are POSIX shell scripts.
describe.skipIf(process.platform === "win32")(
	"launchLSP global lookups honour project trust (#4530)",
	() => {
		it("never resolves a bare server name through a PATH entry inside the project", async () => {
			const project = makeProject();
			const direnvBin = path.join(project.root, "bin");
			plant(path.join(direnvBin, SERVER), project.marker);
			process.env.PATH = [direnvBin, originalPath].join(path.delimiter);
			setProjectTrustState("unknown");

			const result = await launch(SERVER, project.root);

			expect(result).toBeInstanceOf(Error);
			expect(project.ran()).toBe(false);
		});

		it("never launches a server that project configuration placed in the global lookup", async () => {
			const project = makeProject();
			const prefix = path.join(project.root, "tools-prefix");
			plant(path.join(prefix, "bin", SERVER), project.marker);
			fs.writeFileSync(path.join(project.root, ".npmrc"), `prefix=${prefix}\n`);
			process.chdir(project.root);
			setProjectTrustState("unknown");

			const result = await launch(SERVER, project.root);

			expect(result).toBeInstanceOf(Error);
			expect(project.ran()).toBe(false);
		});

		it("starts the server's runtime from outside the project", async () => {
			const project = makeProject();
			plant(
				path.join(project.root, "node_modules", ".bin", "node"),
				project.marker,
			);
			const outside = tempDir("pi-lens-4530-launch-outside-");
			const server = path.join(outside, SERVER);
			fs.writeFileSync(
				server,
				"#!/usr/bin/env node\nsetTimeout(() => {}, 5000);\n",
				{ mode: 0o755 },
			);
			process.env.PATH = [
				path.join(project.root, "node_modules", ".bin"),
				outside,
				path.dirname(process.execPath),
				originalPath,
			].join(path.delimiter);
			setProjectTrustState("unknown");

			const result = await launch(SERVER, project.root);

			expect(result).not.toBeInstanceOf(Error);
			expect(project.ran()).toBe(false);
		});

		it.each(["node_modules/.bin", "bin", "node_modules/pkg/bin", "."])(
			"never launches a server whose real target is inside project %s",
			async (targetDir) => {
				const project = makeProject();
				// The project's own dependency tree holds the binary...
				const planted = plant(
					path.join(project.root, targetDir, SERVER),
					project.marker,
				);
				// ...and an outside PATH directory holds a link that names it.
				const outside = tempDir("pi-lens-4530-launch-link-");
				const link = path.join(outside, SERVER);
				fs.symlinkSync(planted, link);
				process.env.PATH = [outside, originalPath].join(path.delimiter);
				setProjectTrustState("unknown");

				// A bare name, so the launcher resolves it through PATH.
				const result = await launch(SERVER, project.root);

				expect(result).toBeInstanceOf(Error);
				expect(project.ran()).toBe(false);
				const rows = getDegradationSummary()
					.filter((group) => group.kind === "lsp-registry-decision")
					.flatMap((group) => group.latestReasons);
				expect(rows).toEqual([
					expect.objectContaining({
						subject: expect.stringContaining("project-local-binary:"),
						reason: expect.stringContaining(
							"requires trusted session ownership",
						),
					}),
				]);
			},
		);

		it("omits an emptied launch PATH when node is project-local (#4566 F5)", async () => {
			const project = makeProject();
			const outside = tempDir("pi-lens-4530-empty-launch-");
			const server = path.join(outside, SERVER);
			fs.writeFileSync(server, "#!/usr/bin/env pi-lens-4530-runtime\n", {
				mode: 0o755,
			});
			plant(path.join(project.root, "pi-lens-4530-runtime"), project.marker);
			const savedExecPath = process.execPath;
			try {
				process.execPath = path.join(project.root, "bin", "node");
				process.env.PATH = project.root;
				setProjectTrustState("unknown");
				const result = await launch(server, project.root);
				expect(result).toBeInstanceOf(Error);
				expect(project.ran()).toBe(false);
			} finally {
				process.execPath = savedExecPath;
			}
		});

		it("still launches a server from a project PATH entry for a trusted project", async () => {
			const project = makeProject();
			const direnvBin = path.join(project.root, "bin");
			plant(path.join(direnvBin, SERVER), project.marker);
			process.env.PATH = [direnvBin, originalPath].join(path.delimiter);
			setProjectTrustState("trusted");

			const result = await launch(SERVER, project.root);

			expect(result).not.toBeInstanceOf(Error);
			expect(project.ran()).toBe(true);
		});

		// #4566 round 11: a bare name that resolved to nothing is ABSENT, not
		// project-reaching. Resolving the unresolved name against the project made
		// every uninstalled server a trust refusal, which also skipped pi-lens's own
		// managed install. Recurrence guarded: an absence reported as a refusal.
		it("reports an uninstalled bare server name as tool-not-found, not a trust refusal", async () => {
			const project = makeProject();
			// The served root is the session's own root, so resolving the bare name
			// against `process.cwd()` lands inside the project.
			process.chdir(project.root);
			setProjectTrustState("unknown");

			const result = await launch(MISSING_SERVER, project.root);

			expect(result).toBeInstanceOf(SpawnFailureError);
			expect((result as SpawnFailureError).kind).toBe("tool-not-found");
			// The resolver's turn at a missing server, not the launcher's refusal:
			// no trust row, and no throw out of the production launch route.
			expect(
				getDegradationSummary().filter(
					(group) => group.kind === "lsp-registry-decision",
				),
			).toEqual([]);
			const resolved = await resolveAndLaunch(
				{
					candidates: [MISSING_SERVER],
					args: ["--stdio"],
					cwd: project.root,
				},
				false,
			);
			expect(resolved).toBeUndefined();
		});
	},
);
