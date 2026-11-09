/**
 * Five production sites answered "is this path inside that root" with an
 * inline `startsWith(root + sep)` instead of the containment seams the repo
 * owns (`isSameOrWithin`, `relativeInside`, `isWithinForm`;
 * `docs/invariants/paths-os.md`). The inline form is wrong at a root whose own
 * text ends in the separator: `"/" + "/"` is `"//"`, so nothing sits under the
 * filesystem root. Recurrence this file prevents:
 * `sessionRootConfigForFile` (`clients/lsp/session-roots.ts`) answered "no
 * config" for every file of a session rooted at `/` (a container's WORKDIR),
 * which silently lifted the operator's `lsp.disabledServers` denial, while its
 * sibling `isOutsideAllSessionRoots` in the same file answered "served".
 *
 * Every case drives the production caller of one former inline site. No module
 * is mocked.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetGlobalConfigLocationCache } from "../../clients/config-locations.js";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { selectLivePeerInstances } from "../../clients/instance-registry.js";
import {
	initLSPConfig,
	isServerDisabled,
	resetLSPConfigStateForTests,
} from "../../clients/lsp/config.js";
import { NearestRoot } from "../../clients/lsp/server.js";
import {
	isOutsideAllSessionRoots,
	registerSessionRoot,
	resetSessionRootsForTests,
	sessionRootConfigForFile,
	setSessionRootConfig,
} from "../../clients/lsp/session-roots.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
} from "../../clients/review-graph/builder.js";
import {
	BUNDLED_QUERIES_ROOT,
	computeRuleFilesFingerprint,
} from "../../clients/tree-sitter-query-loader.js";
import { useGlobalConfig } from "../support/global-config.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const FS_ROOT = path.parse(process.cwd()).root;

let env: { tmpDir: string; cleanup: () => void };

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-containment-fold-");
	resetSessionRootsForTests();
	resetLSPConfigStateForTests();
});

afterEach(() => {
	resetGlobalConfigLocationCache();
	resetSessionRootsForTests();
	resetLSPConfigStateForTests();
	clearReviewGraphWorkspaceCache();
	env.cleanup();
});

describe("session-root registry (clients/lsp/session-roots.ts)", () => {
	const setGlobalConfig = useGlobalConfig();

	it("a session rooted at the filesystem root still applies the operator's lsp.disabledServers denial", async () => {
		setGlobalConfig({ lsp: { disabledServers: ["typos"] } });

		await initLSPConfig(FS_ROOT);

		const file = path.join(FS_ROOT, "srv", "app", "notes.md");
		expect(isServerDisabled("typos", file)).toBe(true);
	});

	it("the config lookup and the outside-all-roots gate agree for a session rooted at the filesystem root", () => {
		const config = { marker: "root-config" } as never;
		registerSessionRoot(FS_ROOT);
		setSessionRootConfig(FS_ROOT, config);
		const file = path.join(FS_ROOT, "deep", "file.ts");

		expect(isOutsideAllSessionRoots(file)).toBe(false);
		expect(sessionRootConfigForFile(file)).toBe(config);
	});

	it("a sibling that only shares the root's text prefix is outside, the root itself and its children are inside", () => {
		const config = { marker: "proj-config" } as never;
		const root = path.join(env.tmpDir, "proj");
		registerSessionRoot(root);
		setSessionRootConfig(root, config);

		expect(sessionRootConfigForFile(root)).toBe(config);
		expect(sessionRootConfigForFile(path.join(root, "a.ts"))).toBe(config);
		expect(sessionRootConfigForFile(`${root}-backup/a.ts`)).toBeUndefined();
	});

	it("the deepest registered root's config wins over an enclosing root", () => {
		const outer = { marker: "outer" } as never;
		const inner = { marker: "inner" } as never;
		const outerRoot = path.join(env.tmpDir, "outer");
		const innerRoot = path.join(outerRoot, "inner");
		for (const [root, config] of [
			[outerRoot, outer],
			[innerRoot, inner],
		] as const) {
			registerSessionRoot(root);
			setSessionRootConfig(root, config);
		}

		expect(sessionRootConfigForFile(path.join(innerRoot, "a.ts"))).toBe(inner);
		expect(sessionRootConfigForFile(path.join(outerRoot, "a.ts"))).toBe(outer);
	});
});

describe("live-peer containment (clients/instance-registry.ts)", () => {
	function peerAt(root: string) {
		return {
			pid: process.pid + 1,
			startedAt: new Date().toISOString(),
			projectRoot: root,
			projectRoots: [root],
			lspChildren: [],
			lspChildCount: 0,
			rssBytes: 0,
			heartbeatAt: new Date().toISOString(),
		};
	}
	const peersFor = (peerRoot: string, query: string): number =>
		selectLivePeerInstances(
			[peerAt(peerRoot)],
			query,
			Date.now(),
			() => true,
			"containment",
		).length;

	it("a peer registered above the queried directory, or below it, shares the working tree; a text-prefix sibling does not", () => {
		const repo = path.join(env.tmpDir, "repo");
		const sub = path.join(repo, "clients");
		fs.mkdirSync(sub, { recursive: true });
		fs.mkdirSync(`${repo}-backup`, { recursive: true });

		expect(peersFor(repo, sub)).toBe(1);
		expect(peersFor(sub, repo)).toBe(1);
		expect(peersFor(repo, repo)).toBe(1);
		expect(peersFor(repo, `${repo}-backup`)).toBe(0);
		expect(peersFor(`${repo}-backup`, repo)).toBe(0);
	});
});

describe("bundled tree-sitter query corpus (clients/tree-sitter-query-loader.ts)", () => {
	// `computeRuleFilesFingerprint` reads the BYTES of every file outside the
	// bundled root and only stats the bundled ones. A directory is the probe: a
	// byte read of it throws EISDIR, a stat does not.
	it("a path under the bundled root is stat-only; a path outside it has its bytes read", () => {
		const bundledSubdir = fs
			.readdirSync(BUNDLED_QUERIES_ROOT, { withFileTypes: true })
			.find((entry) => entry.isDirectory());
		expect(bundledSubdir).toBeDefined();
		const inside = path.join(BUNDLED_QUERIES_ROOT, bundledSubdir?.name ?? "");

		expect(() => computeRuleFilesFingerprint([inside])).not.toThrow();
		expect(() =>
			computeRuleFilesFingerprint([BUNDLED_QUERIES_ROOT]),
		).not.toThrow();
		expect(() => computeRuleFilesFingerprint([env.tmpDir])).toThrow(/EISDIR/);
	});
});

describe("C/C++ include resolution (clients/review-graph/builder.ts)", () => {
	// The tree-sitter import pass also writes an `imports` edge per include, and
	// it carries the include's `line`. The edge `resolveCxxInclude` adds has none,
	// so it is the one that answers for the containment check under test.
	async function resolvedIncludeTargets(
		cwd: string,
		file: string,
	): Promise<string[]> {
		clearReviewGraphWorkspaceCache();
		const graph = await buildOrUpdateGraph(cwd, [file], new FactStore());
		return graph.edges
			.filter(
				(edge) =>
					edge.kind === "imports" &&
					(edge.metadata as { line?: number } | undefined)?.line === undefined,
			)
			.map((edge) => path.basename(edge.to));
	}

	it("an include resolves under the project root and an include that climbs out of it does not", async () => {
		const project = path.join(env.tmpDir, "proj");
		fs.mkdirSync(path.join(project, ".git"), { recursive: true });
		createTempFile(project, "inc/foo.h", "int foo(void);\n");
		createTempFile(env.tmpDir, "outside.h", "int outside(void);\n");
		const main = createTempFile(
			project,
			"src/main.c",
			[
				'#include "../inc/foo.h"',
				'#include "../../outside.h"',
				"int main(void) { return foo(); }",
			].join("\n"),
		);

		const targets = await resolvedIncludeTargets(project, main);

		expect(targets).toContain("foo.h");
		expect(targets).not.toContain("outside.h");
	});
});

describe("root walk stop directory (clients/lsp/server.ts NearestRoot)", () => {
	function tree(): { file: string; stop: string; top: string } {
		const top = path.join(env.tmpDir, "walk");
		const stop = path.join(top, "a");
		const file = createTempFile(stop, "b/c/f.txt", "x");
		return { file, stop, top };
	}
	const rel = (base: string, found: string | undefined): string | undefined =>
		found === undefined ? undefined : path.relative(base, found) || ".";

	it("the walk finds a marker at the stop directory and does not climb past it", async () => {
		const { file, stop, top } = tree();
		fs.writeFileSync(path.join(stop, "m.cfg"), "");
		fs.writeFileSync(path.join(top, "m.cfg"), "");
		expect(rel(top, await NearestRoot(["m.cfg"], undefined, stop)(file))).toBe(
			"a",
		);

		fs.rmSync(path.join(stop, "m.cfg"));
		expect(await NearestRoot(["m.cfg"], undefined, stop)(file)).toBeUndefined();
	});

	it("a stop directory that only shares a text prefix with the file's tree ends the walk at once", async () => {
		const { file, top } = tree();
		fs.writeFileSync(path.join(top, "m.cfg"), "");
		const lookalike = path.join(top, "a-backup");
		fs.mkdirSync(lookalike, { recursive: true });

		expect(
			await NearestRoot(["m.cfg"], undefined, lookalike)(file),
		).toBeUndefined();
	});
});
