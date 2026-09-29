import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LSPClientInfo } from "../../../clients/lsp/client.js";
import { LSPService } from "../../../clients/lsp/index.js";
import type { LSPServerInfo } from "../../../clients/lsp/server.js";
import {
	initLSPConfig,
	resetLSPConfigStateForTests,
} from "../../../clients/lsp/config.js";
import {
	enforceLspRootCeiling,
	_getPosixCaseSensitivityCacheSizeForTests,
	isSameOrWithin,
	resetLSPCaseSensitivityState,
} from "../../../clients/lsp/server.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	isOutsideAllSessionRoots,
	registerSessionRoot,
	shouldInitializeSessionRoot,
} from "../../../clients/lsp/session-roots.js";
import { removeTempDirSync } from "../test-utils.js";

process.env.PI_LENS_TEST_MODE = "1";

type RootPolicyHarness = {
	state: {
		clients: Map<string, LSPClientInfo>;
		inFlight: Map<string, Promise<unknown>>;
	};
	resolveServerRoot(
		server: LSPServerInfo,
		filePath: string,
	): Promise<string | undefined>;
};

const dirs: string[] = [];

function hasCaseSensitiveFilesystem(): boolean {
	const probe = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-case-fs-"));
	try {
		const upper = path.join(probe, "Project");
		const lower = path.join(probe, "project");
		fs.mkdirSync(upper);
		try {
			fs.mkdirSync(lower);
		} catch {
			return false;
		}
		return fs.realpathSync(upper) !== fs.realpathSync(lower);
	} finally {
		removeTempDirSync(probe);
	}
}

const CASE_SENSITIVE_FILESYSTEM = hasCaseSensitiveFilesystem();

afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	vi.restoreAllMocks();
	resetLSPConfigStateForTests();
});

function fakeClient(root: string): LSPClientInfo {
	return { root, isAlive: () => true } as unknown as LSPClientInfo;
}

function markerServer(id: string): LSPServerInfo {
	return {
		id,
		name: id,
		extensions: [".md"],
		idleEviction: "unmeasured",
		root: async (file) => path.dirname(file),
		spawn: async () => undefined,
	};
}

describe("LSP per-server nested-root coalescing (#1373)", () => {
	it("attaches a nested marker directory to an existing ancestor client", async () => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-coalesce-"));
		dirs.push(project);
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(project);
		const nested = path.join(project, ".github", "workflows");
		fs.mkdirSync(nested, { recursive: true });

		const service = new LSPService() as unknown as RootPolicyHarness;
		const server = markerServer("yaml");
		service.state.clients.set(
			`yaml:${normalizeMapKey(project)}`,
			fakeClient(project),
		);

		await expect(
			service.resolveServerRoot(server, path.join(nested, "ci.yml")),
		).resolves.toBe(project);
		expect(service.state.clients.size).toBe(1);
		cwdSpy.mockRestore();
	});

	it("preserves a true nested project with its own manifest", async () => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-boundary-"));
		dirs.push(project);
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(project);
		const nested = path.join(project, "packages", "docs");
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(nested, "package.json"), "{}\n");

		const service = new LSPService() as unknown as RootPolicyHarness;
		const server = markerServer("marksman");
		service.state.clients.set(
			`marksman:${normalizeMapKey(project)}`,
			fakeClient(project),
		);

		await expect(
			service.resolveServerRoot(server, path.join(nested, "README.md")),
		).resolves.toBe(nested);
		cwdSpy.mockRestore();
	});

	it("declines a file outside every registered session root", async () => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-session-"));
		const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-foreign-"));
		dirs.push(project, foreign);
		resetLSPConfigStateForTests();
		await initLSPConfig(project);
		const service = new LSPService() as unknown as RootPolicyHarness;
		const server = {
			...markerServer("typescript"),
			root: async () => foreign,
		};

		await expect(
			service.resolveServerRoot(server, path.join(foreign, "app.ts")),
		).resolves.toBeUndefined();
	});

	// #2052 fix round 1 (F2). The decline gate used to read a single
	// last-writer-wins session-cwd latch, so initializing a SECOND project
	// silently made the FIRST project's files foreign. The registry keeps every
	// initialized root live.
	it("serves a file under an earlier session root after a second root initializes", async () => {
		const projectA = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-multi-a-"));
		const projectB = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-multi-b-"));
		dirs.push(projectA, projectB);
		resetLSPConfigStateForTests();
		await initLSPConfig(projectA);
		await initLSPConfig(projectB);

		const service = new LSPService() as unknown as RootPolicyHarness;
		const server = {
			...markerServer("typescript"),
			root: async () => projectA,
		};

		// projectA initialized FIRST and projectB LAST; projectA must still serve.
		await expect(
			service.resolveServerRoot(server, path.join(projectA, "a.ts")),
		).resolves.toBe(projectA);
	});

	// #2052 R1: the registry cap must not make an old root permanently foreign.
	it("allows an evicted root to be registered again", () => {
		resetLSPConfigStateForTests();
		const roots = [
			...Array.from({ length: 129 }, (_, index) =>
				path.join(os.tmpdir(), `pi-lens-eviction-${index}`),
			),
		];
		const readyRoots = new Set<string>();
		for (const root of roots) {
			registerSessionRoot(root);
			readyRoots.add(path.resolve(root));
		}
		expect(isOutsideAllSessionRoots(roots[0]!)).toBe(true);
		const firstRootStillServed =
			shouldInitializeSessionRoot(roots[0]!, readyRoots) === true;
		expect(
			firstRootStillServed,
			`firstRootStillServed=${firstRootStillServed}`,
		).toBe(true);
		registerSessionRoot(roots[0]!);
		expect(isOutsideAllSessionRoots(path.join(roots[0]!, "app.ts"))).toBe(
			false,
		);
		expect(isOutsideAllSessionRoots(path.join(roots[0]!, "app.ts"))).toBe(
			false,
		);
	});

	it("matches the case behavior of the fixture filesystem", () => {
		const probe = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-case-probe-"));
		try {
			const actualCaseInsensitive = fs.existsSync(
				path.join(path.dirname(probe), path.basename(probe).toUpperCase()),
			);
			const actualRoot = path.join(probe, "Project");
			fs.mkdirSync(path.join(actualRoot, "src"), { recursive: true });
			const aliasedRoot = path.join(probe, "project");
			expect(
				isSameOrWithin(actualRoot, path.join(aliasedRoot, "src", "app.ts")),
			).toBe(actualCaseInsensitive);
			expect(
				isSameOrWithin(actualRoot, path.join(actualRoot, "src", "app.ts")),
			).toBe(true);
		} finally {
			removeTempDirSync(probe);
		}
	});

	it.skipIf(!CASE_SENSITIVE_FILESYSTEM)(
		"does not coalesce distinct case-variant directories",
		() => {
			const base = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-case-distinct-"),
			);
			dirs.push(base);
			const actualRoot = path.join(base, "Project");
			const distinctRoot = path.join(base, "project");
			fs.mkdirSync(path.join(actualRoot, "src"), { recursive: true });
			fs.mkdirSync(path.join(distinctRoot, "src"), { recursive: true });

			// On a case-sensitive filesystem, the sibling's existence proves that
			// it is a different directory, not that the filesystem folds case.
			expect(
				isSameOrWithin(actualRoot, path.join(distinctRoot, "src", "app.ts")),
			).toBe(false);
		},
	);

	it("honors an injected case-insensitive probe", () => {
		const root = "/pi-lens-case-forced/Project";
		const caseInsensitiveProbe = vi.fn(() => true);
		expect(
			isSameOrWithin(root, "/pi-lens-case-forced/project/src/app.ts", {
				caseInsensitiveProbe,
			}),
		).toBe(true);
		expect(caseInsensitiveProbe).toHaveBeenCalledWith(path.resolve(root));
	});

	it("honors an injected case-sensitive probe", () => {
		const root = "/pi-lens-case-outcome/Project";
		const caseInsensitiveProbe = vi.fn(() => false);
		const result = isSameOrWithin(
			root,
			"/pi-lens-case-outcome/project/src/app.ts",
			{ caseInsensitiveProbe },
		);
		expect(result).toBe(CASE_SENSITIVE_FILESYSTEM ? false : true);
		expect(caseInsensitiveProbe).toHaveBeenCalledOnce();
	});

	it("clears the case-sensitivity probe cache at the session reset", () => {
		const root = "/pi-lens-case-reset/Project";
		isSameOrWithin(root, `${root}/src/app.ts`, {
			caseInsensitiveProbe: () => false,
		});
		expect(_getPosixCaseSensitivityCacheSizeForTests()).toBeGreaterThan(0);
		resetLSPCaseSensitivityState();
		expect(_getPosixCaseSensitivityCacheSizeForTests()).toBe(0);
	});

	// #2052 fix round 1 (F1). An EMPTY registry means initLSPConfig never ran.
	// Declining then would let process.cwd() gate a refusal for callers that
	// never declared a session at all.
	it("declines nothing when no session root is registered", async () => {
		const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-noreg-"));
		dirs.push(foreign);
		resetLSPConfigStateForTests();

		const service = new LSPService() as unknown as RootPolicyHarness;
		const server = {
			...markerServer("typescript"),
			root: async () => foreign,
		};

		await expect(
			service.resolveServerRoot(server, path.join(foreign, "app.ts")),
		).resolves.toBe(foreign);
	});

	it("coalesces a config-only TypeScript root with an already-hosted ancestor", async () => {
		const project = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ts-config-coalesce-"),
		);
		dirs.push(project);
		vi.spyOn(process, "cwd").mockReturnValue(project);
		const nested = path.join(project, "packages", "configured");
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(nested, "tsconfig.json"), "{}\n");

		const service = new LSPService() as unknown as RootPolicyHarness;
		const server = markerServer("typescript");
		service.state.clients.set(
			`typescript:${normalizeMapKey(project)}`,
			fakeClient(project),
		);
		await expect(
			service.resolveServerRoot(server, path.join(nested, "app.ts")),
		).resolves.toBe(project);
	});

	it("parses Windows-shaped ceiling paths with win32 semantics on every host", () => {
		expect(
			enforceLspRootCeiling(
				"C:\\repo",
				"C:\\repo\\session",
				"C:\\repo\\session\\src\\app.ts",
			),
		).toBe("C:\\repo\\session");
	});

	it("coalesces drive-letter and path-case aliases to the hosted client", async () => {
		vi.spyOn(process, "cwd").mockReturnValue("C:\\Repo");
		const service = new LSPService() as unknown as RootPolicyHarness;
		const server: LSPServerInfo = {
			...markerServer("typescript"),
			root: async () => "c:\\REPO\\nested",
		};
		service.state.clients.set(
			`typescript:${normalizeMapKey("C:\\Repo")}`,
			fakeClient("C:\\Repo"),
		);
		await expect(
			service.resolveServerRoot(server, "c:\\repo\\nested\\app.ts"),
		).resolves.toBe("C:\\Repo");
	});

	it("preserves a nested Git project without a manifest", async () => {
		const project = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-git-boundary-"),
		);
		dirs.push(project);
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(project);
		const nested = path.join(project, "vendor", "child-repo");
		fs.mkdirSync(path.join(nested, ".git"), { recursive: true });

		const service = new LSPService() as unknown as RootPolicyHarness;
		const server = markerServer("marksman");
		service.state.clients.set(
			`marksman:${normalizeMapKey(project)}`,
			fakeClient(project),
		);

		await expect(
			service.resolveServerRoot(server, path.join(nested, "README.md")),
		).resolves.toBe(nested);
		cwdSpy.mockRestore();
	});

	it("collapses the observed nested-marker fixture below ceiling pressure", async () => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pressure-"));
		dirs.push(project);
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(project);
		const shapes = [
			...Array.from({ length: 5 }, (_, i) => `skills/pi-lens-${i}`),
			...Array.from(
				{ length: 7 },
				(_, i) => `rules/coderabbit/rules/lang-${i}/security`,
			),
			".github",
			".github/workflows",
			...Array.from({ length: 5 }, (_, i) => `cases/${i}/workspace`),
		];
		for (const relative of shapes) {
			fs.mkdirSync(path.join(project, relative), { recursive: true });
		}

		const service = new LSPService() as unknown as RootPolicyHarness;
		const roots = new Set<string>();
		for (const id of ["yaml", "marksman"]) {
			const server = markerServer(id);
			const projectKey = `${id}:${normalizeMapKey(project)}`;
			service.state.clients.set(projectKey, fakeClient(project));
			roots.add(projectKey);
			for (const relative of shapes) {
				const root = await service.resolveServerRoot(
					server,
					path.join(
						project,
						relative,
						`fixture.${id === "yaml" ? "yml" : "md"}`,
					),
				);
				roots.add(`${id}:${normalizeMapKey(root!)}`);
			}
		}

		expect(roots.size).toBe(2);
		expect(service.state.clients.size).toBe(2);
		cwdSpy.mockRestore();
	});
});
