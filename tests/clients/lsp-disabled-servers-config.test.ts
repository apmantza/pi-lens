/**
 * `lsp.disabledServers` names no server (#5141), the deny-list sibling of
 * `dispatch.disabledRunners` (#5010).
 *
 * Recurrence: `lsp.disabledServers: ["pyrefy"]`, a misspelled id, reached the
 * deny set unchecked and matched no server, with no notice. The user who wrote
 * it believed a server was off, and it kept running. The loader now drops an id
 * that is neither a built-in server nor declared under `lsp.servers.<id>`, and
 * reports one `PILENS_CFG_0005` notice per distinct unknown id.
 *
 * Every case drives the production funnel: real config files on disk, real
 * `loadLSPConfig`, and the registry's own deny set (`registerLSPConfig`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MIGRATION_RECORDS } from "../../clients/config-core/records.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	loadLSPConfig,
	registerLSPConfig,
	resetLSPConfigStateForTests,
	resetLSPConfigWarnCache,
} from "../../clients/lsp/config.js";
import { wireUserNotifier } from "../../clients/user-notify.js";
import { useConfigPath } from "../support/global-config.js";
import { removeTempDirSync } from "./test-utils.js";

const setConfigPath = useConfigPath();

const notified: Array<{ message: string }> = [];
const tempRoots: string[] = [];

const CUSTOM_SERVER = {
	name: "My Shell",
	extensions: [".zsh"],
	command: "mysh-lsp",
	args: ["--stdio"],
};

const UNKNOWN_REASON = (id: string): string =>
	`lsp.disabledServers entry "${id}" is not a recognized LSP server id; dropped`;

beforeEach(async () => {
	const trust = await import("../../clients/project-trust.js");
	trust.setProjectTrustState("trusted");
	notified.length = 0;
	resetLSPConfigStateForTests();
	resetLSPConfigWarnCache();
	resetDegradationLedger();
	wireUserNotifier(() => (message) => {
		notified.push({ message });
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
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
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-disabled-srv-"));
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

/** Pin the global tier to the fixture home; returns the env restore. */
function pinHome(home: string): () => void {
	vi.stubEnv("PI_LENS_HOME", path.join(home, ".pi-lens"));
	setConfigPath(path.join(home, ".pi-lens", "config.json"));
	return () => vi.unstubAllEnvs();
}

const denying = (ids: unknown[]): Record<string, unknown> => ({
	lsp: { disabledServers: ids },
});

describe("lsp.disabledServers names no server (#5141)", () => {
	it("prints one PILENS_CFG_0005 notice per unknown id and drops it from the deny set", async () => {
		const { home, projectDir } = makeLayout({
			project: {
				".pi-lens.json": denying(["pyrefy", "typescript", "nope"]),
			},
		});
		const restore = pinHome(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			// The unknown ids are gone from the deny set; the known one stays.
			expect(cfg.disabledServers).toEqual(["typescript"]);
			// One notice per unknown id, each carrying the stable code.
			expect(notified).toHaveLength(2);
			expect(notified[0]?.message).toContain("[PILENS_CFG_0005]");
			expect(notified[0]?.message).toContain(UNKNOWN_REASON("pyrefy"));
			expect(notified[1]?.message).toContain("[PILENS_CFG_0005]");
			expect(notified[1]?.message).toContain(UNKNOWN_REASON("nope"));
			// The durable half: each notice is also a `config-ignored` ledger row
			// whose subject names that member's own array index.
			const ledger = getDegradationSummary().find(
				(g) => g.kind === "config-ignored",
			);
			expect(
				ledger?.latestReasons.some((e) =>
					e.subject.includes("/lsp/disabledServers/0"),
				),
			).toBe(true);
			expect(
				ledger?.latestReasons.some((e) =>
					e.subject.includes("/lsp/disabledServers/2"),
				),
			).toBe(true);
			// Bounded by the process-lifetime latch: a second load of the same
			// file repeats neither notice.
			await loadLSPConfig(projectDir, home);
			expect(notified).toHaveLength(2);
		} finally {
			restore();
		}
	});

	it("noticed once for a repeated unknown id", async () => {
		const { home, projectDir } = makeLayout({
			project: { ".pi-lens.json": denying(["pyrefy", "pyrefy", "typescript"]) },
		});
		const restore = pinHome(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			expect(cfg.disabledServers).toEqual(["typescript"]);
			expect(notified).toHaveLength(1);
			expect(notified[0]?.message).toContain(UNKNOWN_REASON("pyrefy"));
			// The durable half: one ledger row per distinct id, not one per
			// occurrence. The resolver's deny union folds the repeated member
			// (`resolveArrayDeny`), so the two entries are one member and one row.
			const rowsForPyrefy =
				getDegradationSummary()
					.find((g) => g.kind === "config-ignored")
					?.latestReasons.filter((e) => e.reason.includes('"pyrefy"')) ?? [];
			expect(rowsForPyrefy).toHaveLength(1);
		} finally {
			restore();
		}
	});

	it("keeps a non-string member as it was and never throws on it", async () => {
		// The schema does not type the items of `lsp.disabledServers`, so a number
		// reaches the projection. The unknown-id path would hand it to
		// `boundedKeyLabel`, which only takes a string; the non-string arm is what
		// keeps a stray number from crashing the load.
		const { home, projectDir } = makeLayout({
			project: { ".pi-lens.json": denying([42, "typescript"]) },
		});
		const restore = pinHome(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			expect(cfg.disabledServers).toEqual([42, "typescript"]);
			expect(notified).toHaveLength(0);
		} finally {
			restore();
		}
	});

	it("keeps a known built-in id's denial unchanged", async () => {
		const { home, projectDir } = makeLayout({
			project: { ".pi-lens.json": denying(["typescript"]) },
		});
		const restore = pinHome(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			expect(cfg.disabledServers).toEqual(["typescript"]);
			expect(registerLSPConfig(cfg).disabledServerIds.has("typescript")).toBe(
				true,
			);
			expect(notified).toHaveLength(0);
		} finally {
			restore();
		}
	});

	it("prints nothing new for a config with only valid ids", async () => {
		const ids = ["typescript", "python-jedi", "opengrep", "typos"];
		const { home, projectDir } = makeLayout({
			project: { ".pi-lens.json": denying(ids) },
		});
		const restore = pinHome(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			expect(cfg.disabledServers).toEqual(ids);
			expect(notified).toHaveLength(0);
		} finally {
			restore();
		}
	});

	it("keeps a denied custom server declared under lsp.servers as a valid id", async () => {
		const { home, projectDir } = makeLayout({
			project: {
				".pi-lens.json": {
					lsp: {
						servers: { mysh: CUSTOM_SERVER },
						disabledServers: ["mysh"],
					},
				},
			},
		});
		const restore = pinHome(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			expect(cfg.disabledServers).toEqual(["mysh"]);
			expect(registerLSPConfig(cfg).disabledServerIds.has("mysh")).toBe(true);
			expect(notified).toHaveLength(0);
		} finally {
			restore();
		}
	});

	it("keeps a denied custom server declared in another tier as a valid id", async () => {
		const { home, projectDir } = makeLayout({
			home: {
				"config.json": { lsp: { servers: { mysh: CUSTOM_SERVER } } },
			},
			project: { ".pi-lens.json": denying(["mysh"]) },
		});
		const restore = pinHome(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			expect(cfg.disabledServers).toEqual(["mysh"]);
			expect(notified).toHaveLength(0);
		} finally {
			restore();
		}
	});

	it("validates the deprecated root spelling of the key too", async () => {
		const { home, projectDir } = makeLayout({
			project: { ".pi-lens.json": { disabledServers: ["pyrefy"] } },
		});
		const restore = pinHome(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			expect(cfg.disabledServers).toEqual([]);
			expect(
				notified.some((n) => n.message.includes(UNKNOWN_REASON("pyrefy"))),
			).toBe(true);
		} finally {
			restore();
		}
	});

	it("bounds the notices for a pasted list and says how many it suppressed", async () => {
		const ids = Array.from(
			{ length: MAX_MIGRATION_RECORDS + 5 },
			(_, index) => `nope-${index}`,
		);
		const { home, projectDir } = makeLayout({
			project: { ".pi-lens.json": denying(ids) },
		});
		const restore = pinHome(home);
		try {
			const cfg = await loadLSPConfig(projectDir, home);
			expect(cfg.disabledServers).toEqual([]);
			expect(notified.length).toBeLessThanOrEqual(MAX_MIGRATION_RECORDS);
			expect(
				notified.some((n) =>
					n.message.includes("further config notices were suppressed"),
				),
			).toBe(true);
		} finally {
			restore();
		}
	});
});
