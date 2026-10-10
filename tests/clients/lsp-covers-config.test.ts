/**
 * `lsp.servers.<id>.covers` — the config-declared runner-ownership claim
 * (#3968, the stacked config PR).
 *
 * Everything drives the PRODUCTION funnel: real config files on disk, real
 * `loadLSPConfig` (the one funnel every caller reaches) and real
 * `effectiveConfig`. The runner-side half of the deferral is proven in
 * `tests/clients/dispatch/runners/shell-dialect-fold.test.ts`'s
 * custom-covers arm (real `dispatchForFile`, red-first); this file pins the
 * config half it consumes — claim shape, fail-closed validation, merge
 * semantics, redaction, provenance — so a claim the loader would drop can
 * never silently reach (or cease reaching) the seam.
 *
 * The runner-id identity is projected from the REAL registry entrance
 * (`RunnerRegistry.register` via `registerDefaultRunners`) every test, and
 * the fail-open arm (identity unpopulated) is the only place that resets it
 * — named and re-armed inside that test.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireUserNotifier } from "../../clients/user-notify.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { RunnerRegistry } from "../../clients/dispatch/dispatcher.js";
import {
	resetRunnerIdentityForTests,
	runnerIdentityPopulated,
} from "../../clients/dispatch/known-runner-ids.js";
import { registerDefaultRunners } from "../../clients/dispatch/runners/index.js";
import {
	effectiveConfig,
	type EffectiveConfigView,
	type EffectiveFileView,
} from "../../clients/effective-config.js";
import {
	loadLSPConfig,
	registerLSPConfig,
	resetLSPConfigStateForTests,
	resetLSPConfigWarnCache,
} from "../../clients/lsp/config.js";
import { removeTempDirSync } from "./test-utils.js";

// Capture, never discard: the loader's records must reach the sinks, and a
// test that throws the notices away cannot tell a suppressed one from an
// absent one (#2427 review round 2, F6's direction).
const loggedExtension = vi.hoisted(() => ({ entries: [] as string[] }));
vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: { message: string }) => {
			loggedExtension.entries.push(entry.message);
		},
	};
});

const notified: Array<{ message: string }> = [];

const CUSTOM_SERVER = {
	name: "My Shell",
	extensions: [".zsh", ".sh"],
	command: "mysh-lsp",
	args: ["--stdio"],
	env: { MYSH_FLAG: "1" },
};

const tempRoots: string[] = [];

beforeEach(async () => {
	const trust = await import("../../clients/project-trust.js");
	trust.setProjectTrustState("trusted");
});

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) removeTempDirSync(root);
	}
});

/** The fake-home tier layout: home goes under `.pi-lens/`, project under `proj/`. */
interface Layout {
	readonly home?: Record<string, unknown>;
	readonly project?: Record<string, unknown>;
}

function makeLayout(layout: Layout): { home: string; projectDir: string } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-covers-"));
	tempRoots.push(home);
	for (const [relative, content] of [
		...Object.entries(layout.home ?? {}).map(
			([rel, value]) => [`.pi-lens/${rel}`, value] as const,
		),
		...Object.entries(layout.project ?? {}).map(
			([rel, value]) => [`proj/${rel}`, value] as const,
		),
	]) {
		const target = path.join(home, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, JSON.stringify(content, null, 2));
	}
	return { home, projectDir: path.join(home, "proj") };
}

/** Ensure the covers-identity looks like a warmed production process. */
function populateRunnerIdentity(): void {
	resetRunnerIdentityForTests();
	registerDefaultRunners(new RunnerRegistry());
	expect(runnerIdentityPopulated()).toBe(true);
}

/** Pin the global tier to the fixture home; returns the env restore. */
function homeEnvFor(home: string): { restore: () => void } {
	const previousHome = process.env.PI_LENS_HOME;
	const previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
	process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
	process.env.PI_LENS_CONFIG_PATH = path.join(home, ".pi-lens", "config.json");
	return {
		restore: () => {
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			if (previousConfigPath === undefined) {
				delete process.env.PI_LENS_CONFIG_PATH;
			} else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
		},
	};
}

beforeEach(() => {
	notified.length = 0;
	loggedExtension.entries.length = 0;
	resetLSPConfigStateForTests();
	resetLSPConfigWarnCache();
	resetDegradationLedger();
	populateRunnerIdentity();
	wireUserNotifier(() => (message) => {
		notified.push({ message });
	});
});

describe("lsp.servers.<id>.covers — the config-declared claim (#3968)", () => {
	const coversConfig = (
		extra: Record<string, unknown> = {},
	): Record<string, unknown> => ({
		lsp: { servers: { mysh: { ...CUSTOM_SERVER, ...extra } } },
	});

	it("carries a valid claim through the projection into the registered server", async () => {
		const { home, projectDir } = makeLayout({
			project: { ".pi-lens.json": coversConfig({ covers: ["shellcheck"] }) },
		});
		const homeEnv = homeEnvFor(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			expect(cfg.servers?.mysh?.covers).toEqual(["shellcheck"]);
			const registered = registerLSPConfig(cfg).customServers;
			expect(registered).toHaveLength(1);
			expect(registered[0]?.id).toBe("mysh");
			expect(registered[0]?.covers).toEqual(["shellcheck"]);
		} finally {
			homeEnv.restore();
		}
	});

	it("drops an unknown runner-id member with a visible PILENS_CFG_0005 record; the server still registers", async () => {
		const { home, projectDir } = makeLayout({
			project: { ".pi-lens.json": coversConfig({ covers: ["shellchek"] }) },
		});
		const homeEnv = homeEnvFor(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			// The claim is gone from the projection…
			expect(cfg.servers?.mysh?.covers).toBeUndefined();
			expect(cfg.servers?.mysh?.name).toBe("My Shell");
			// …and the server still registers (its LSP lane is independent).
			const registered = registerLSPConfig(cfg).customServers;
			expect(registered).toHaveLength(1);
			expect(registered[0]?.covers).toBeUndefined();
			// The record names the claim and carries the stable code a user
			// matches on; the offending member value is never quoted back.
			expect(notified).toHaveLength(1);
			expect(notified[0]?.message).toContain(
				"lsp.servers.mysh.covers declares member(s) that are not recognized dispatch runner ids",
			);
			expect(notified[0]?.message).toContain("[PILENS_CFG_0005]");
			expect(notified[0]?.message).toContain("registers with no covers claim");
			expect(notified[0]?.message).not.toContain("shellchek");
			// The durable half: the ledger row names the file and the pointer
			// (`latestReasons` is the summary's bounded projection).
			const group = getDegradationSummary().find(
				(g) => g.kind === "config-ignored",
			);
			expect(
				group?.latestReasons.some((e) => e.subject.includes("covers")),
			).toBe(true);
			// Bounded: the process-lifetime latch, per (file, key, reason) —
			// a second load of the same broken claim warns once at most.
			await loadLSPConfig(projectDir, home);
			expect(notified).toHaveLength(1);
		} finally {
			homeEnv.restore();
		}
	});

	it("drops unknown members individually and keeps the recognized ones", async () => {
		const { home, projectDir } = makeLayout({
			project: {
				".pi-lens.json": coversConfig({
					covers: ["shellcheck", "shellchek", "shfmt"],
				}),
			},
		});
		const homeEnv = homeEnvFor(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			expect(cfg.servers?.mysh?.covers).toEqual(["shellcheck", "shfmt"]);
			expect(notified[0]?.message).toContain("1 of 3 member(s) dropped");
			expect(notified[0]?.message).toContain(
				"registers with the remaining covers claim",
			);
		} finally {
			homeEnv.restore();
		}
	});

	it("a non-array covers is dropped by the published schema at the leaf pointer", async () => {
		const { home, projectDir } = makeLayout({
			project: { ".pi-lens.json": coversConfig({ covers: "shellcheck" }) },
		});
		const homeEnv = homeEnvFor(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			expect(cfg.servers?.mysh).toBeDefined();
			expect(cfg.servers?.mysh?.covers).toBeUndefined();
			const row = notified.find((n) =>
				/expected an array, got string/.test(n.message),
			);
			expect(row?.message).toContain("[PILENS_CFG_0005]");
			// Nothing quoted back from the file's contents.
			expect(row?.message.split("\n").join(" ")).not.toContain("shellcheck");
		} finally {
			homeEnv.restore();
		}
	});

	it("drops a non-string member and keeps the string members", async () => {
		const { home, projectDir } = makeLayout({
			project: {
				".pi-lens.json": {
					lsp: {
						servers: {
							mysh: {
								name: "My Shell",
								extensions: [".zsh"],
								command: "mysh-lsp",
								covers: ["shellcheck", 42],
							},
						},
					},
				},
			},
		});
		const homeEnv = homeEnvFor(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			expect(cfg.servers?.mysh?.covers).toEqual(["shellcheck"]);
			expect(
				notified.some((n) => /expected string, got number/.test(n.message)),
			).toBe(true);
		} finally {
			homeEnv.restore();
		}
	});

	it("an empty array configures no claim and records nothing", async () => {
		const { home, projectDir } = makeLayout({
			project: { ".pi-lens.json": coversConfig({ covers: [] }) },
		});
		const homeEnv = homeEnvFor(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			expect(cfg.servers?.mysh?.covers).toEqual([]);
			const registered = registerLSPConfig(cfg).customServers;
			expect(registered[0]?.covers).toEqual([]);
			expect(notified).toHaveLength(0);
			expect(getDegradationSummary()).toHaveLength(0);
		} finally {
			homeEnv.restore();
		}
	});

	it("the nearest tier supplies the whole covers array — no cross-tier union", async () => {
		const { home, projectDir } = makeLayout({
			home: {
				"config.json": coversConfig({ covers: ["shellcheck", "shfmt"] }),
			},
			project: { ".pi-lens.json": coversConfig({ covers: ["shfmt"] }) },
		});
		const homeEnv = homeEnvFor(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			expect(cfg.servers?.mysh?.covers).toEqual(["shfmt"]);
		} finally {
			homeEnv.restore();
		}
	});

	it("a nearer tier that omits covers keeps the farther tier's claim (objects merge field-wise)", async () => {
		const { home, projectDir } = makeLayout({
			home: { "config.json": coversConfig({ covers: ["shellcheck"] }) },
			project: {
				".pi-lens.json": {
					lsp: {
						servers: {
							mysh: {
								name: "Renamed",
								extensions: [".zsh"],
								command: "mysh-lsp",
								args: ["--stdio"],
							},
						},
					},
				},
			},
		});
		const homeEnv = homeEnvFor(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			expect(cfg.servers?.mysh?.name).toBe("Renamed");
			expect(cfg.servers?.mysh?.covers).toEqual(["shellcheck"]);
		} finally {
			homeEnv.restore();
		}
	});

	it("a nearer tier clears the claim with an empty array", async () => {
		const { home, projectDir } = makeLayout({
			home: { "config.json": coversConfig({ covers: ["shellcheck"] }) },
			project: { ".pi-lens.json": coversConfig({ covers: [] }) },
		});
		const homeEnv = homeEnvFor(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			expect(cfg.servers?.mysh?.covers).toEqual([]);
		} finally {
			homeEnv.restore();
		}
	});

	it("a claim is accepted, not refused, when no runner registry has populated the process — and the skip is recorded", async () => {
		const { home, projectDir } = makeLayout({
			project: { ".pi-lens.json": coversConfig({ covers: ["shellcheck"] }) },
		});
		const homeEnv = homeEnvFor(home);
		// The fail-open arm: the identity this process would have if no
		// registry had been built yet (the first pi session's loadLSPConfig
		// racing the fire-and-forget dispatch warm-up). beforeEach populated
		// the identity; this test re-opens it for the run and beforeEach of
		// the NEXT test re-populates.
		resetRunnerIdentityForTests();
		expect(runnerIdentityPopulated()).toBe(false);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			expect(cfg.servers?.mysh?.covers).toEqual(["shellcheck"]);
			expect(notified).toHaveLength(0);
			const group = getDegradationSummary().find(
				(g) => g.kind === "lsp-covers-unvalidated",
			);
			expect(group?.latestReasons).toHaveLength(1);
			expect(group?.latestReasons[0]?.subject).toContain(
				"/lsp/servers/mysh/covers",
			);
		} finally {
			homeEnv.restore();
		}
	});

	it("effective_config renders the claim and its provenance", async () => {
		const { home, projectDir } = makeLayout({
			project: {
				".pi-lens.json": coversConfig({ covers: ["shellcheck"] }),
				"shell/zshrc.zsh": "F=1\necho $F\n",
			},
		});
		const homeEnv = homeEnvFor(home);
		try {
			const view = (await effectiveConfig({
				cwd: projectDir,
				homeDir: home,
				redact: true,
				file: path.join(projectDir, "shell/zshrc.zsh"),
			})) as EffectiveConfigView;
			const file = view.file as EffectiveFileView;
			const mine = file.servers.find((s) => s.id === "mysh");
			expect(mine?.selected).toBe(true);
			expect(mine?.spec).toMatchObject({
				command: "mysh-lsp",
				argvCount: 2,
				envNames: ["MYSH_FLAG"],
				covers: ["shellcheck"],
			});
			// The covers leaf's provenance: the pointer answers tier and file,
			// so the view can say WHICH config decided the claim.
			const coverLeaf = view.provenance.find(
				(e) => e.key === "/lsp/servers/mysh/covers",
			);
			expect(coverLeaf?.tier).toBe("project");
			expect(coverLeaf?.file).toContain("proj/.pi-lens.json");
		} finally {
			homeEnv.restore();
		}
	});

	it("the redacted spec never renders env values or argv contents beside the claim", async () => {
		const { home, projectDir } = makeLayout({
			project: {
				".pi-lens.json": coversConfig({
					covers: ["shellcheck"],
					env: { MYSH_TOKEN: "s3cr3t" },
					args: ["--stdio", "--flag", "value"],
				}),
				"shell/run.sh": "echo hi\n",
			},
		});
		const homeEnv = homeEnvFor(home);
		try {
			const view = (await effectiveConfig({
				cwd: projectDir,
				homeDir: home,
				redact: true,
				file: path.join(projectDir, "shell/run.sh"),
			})) as EffectiveConfigView;
			const file = view.file as EffectiveFileView;
			const rendered = JSON.stringify(
				file.servers.find((s) => s.id === "mysh") ?? {},
			);
			expect(rendered).toContain('"covers":["shellcheck"]');
			expect(rendered).not.toContain("s3cr3t");
			expect(rendered).not.toContain("--stdio");
			expect(rendered).not.toContain("--flag");
		} finally {
			homeEnv.restore();
		}
	});

	it("the registration projects the custom command onto the server info (the covers-claim gate source, #3968 F2)", async () => {
		const { home, projectDir } = makeLayout({
			project: { ".pi-lens.json": coversConfig({ covers: ["shellcheck"] }) },
		});
		const homeEnv = homeEnvFor(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			const registered = registerLSPConfig(cfg).customServers;
			expect(registered[0]?.command).toBe("mysh-lsp");
		} finally {
			homeEnv.restore();
		}
	});

	it("an id colliding with a builtin server registers as a custom row with no covers claim (the F2 collision surface)", async () => {
		// The F2 defect shape at the registration edge: `lsp.servers.bash` is
		// a CUSTOM row that happens to share the builtin bash row's id. It
		// must register with `custom: true` and NO covers claim — the facts
		// the builtin table holds for id `bash` belong to the builtin row,
		// and the seam reads claim provenance from the row itself.
		const { home, projectDir } = makeLayout({
			project: {
				".pi-lens.json": {
					lsp: {
						servers: {
							bash: {
								name: "foreign shell server",
								extensions: [".zsh"],
								command: "my-shell-lsp",
							},
						},
					},
				},
			},
		});
		const homeEnv = homeEnvFor(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			const registered = registerLSPConfig(cfg).customServers;
			expect(registered).toHaveLength(1);
			expect(registered[0]?.id).toBe("bash");
			expect(registered[0]?.custom).toBe(true);
			expect(registered[0]?.command).toBe("my-shell-lsp");
			expect(registered[0]?.covers).toBeUndefined();
		} finally {
			homeEnv.restore();
		}
	});
});
