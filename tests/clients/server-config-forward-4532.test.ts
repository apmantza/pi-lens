/**
 * #4532 gap 12 and gap 3: the out-of-band look forwards the config files a
 * language server reads once, reads Python `.pyi` stubs as declaration files,
 * and stamps a Python venv's `site-packages` directories as an install.
 *
 * Recurrence (gap 12): a `pyrightconfig.json` with `extraPaths` created after
 * pyright answered left the importer's "could not be resolved" finding in
 * place for the server's life (20 polls over 11.9 s), because the look
 * forwarded only `.d.ts` files and no event ever named the config. Recurrence
 * (gap 3 stubs): a `.pyi` stub added or edited outside pi was not a declaration
 * file to the look, so pyright kept the bytes of the stub it had read.
 * Recurrence (gap 3 installs): a `pip install` into a project `.venv` that
 * keeps no lockfile wrote no file the stamp listed, so nothing published, no
 * server restarted, and pyright kept the cached missing import for the
 * server's life (real pyright 1.1.414: stale through 40 calls over 20.3 s;
 * the same install behind a published change cleared on call 1).
 *
 * The language server is the host boundary (a service double that records the
 * events the subscriber asks it to send); the real LSP routing of a config
 * name to its server is driven in `smoke-tools-born-after-start.test.ts`. The
 * detector, the publisher, the diagnostics-cache clock and the latency sink are
 * real.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import {
	type DiskChange,
	subscribeDiskChange,
} from "../../clients/disk-changes.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import {
	getLSPService,
	resetLSPService,
} from "../../clients/lsp/capabilities.js";
import {
	resetWorkspaceDiagnosticsCacheSession,
	workspaceFileCreatedAtFor,
} from "../../clients/lsp/workspace-diagnostics-session.js";
import { LSPService } from "../../clients/lsp/index.js";
import { lookForOutOfBandChanges } from "../../clients/out-of-band-changes.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import { readNdjsonRows } from "../support/ndjson-rows.js";

let tmp: string;
let notified: Array<{ filePath: string; type: number }>;
let restarted: string[];
let runtime: RuntimeCoordinator;
const cleanups: Array<() => void> = [];

const cacheRefusedAt = () =>
	workspaceFileCreatedAtFor(
		() => true,
		() => true,
	);

function recordPublishes(): DiskChange[] {
	const seen: DiskChange[] = [];
	cleanups.push(
		subscribeDiskChange("4532-g12-observes-publish", (change) => {
			seen.push(change);
		}),
	);
	return seen;
}

/** One look after `change`, against the baseline the first look recorded. */
async function lookAfter(change: () => void): Promise<DiskChange[]> {
	await lookForOutOfBandChanges(tmp, "tool_result", runtime);
	change();
	const seen = recordPublishes();
	await lookForOutOfBandChanges(tmp, "tool_result", runtime);
	return seen;
}

beforeEach(async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4532-g12-"));
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = tmp;
	resetDegradationLedger();
	resetWorkspaceDiagnosticsCacheSession(0);
	notified = [];
	restarted = [];
	await installLspServiceDouble({
		restartPrimaryClientsUnder: async (root: string) => {
			restarted.push(root);
			return [root];
		},
		notifyOutOfBandFileChanges: (
			events: ReadonlyArray<{ filePath: string; type: number }>,
		) => {
			notified.push(...events);
		},
	});
	getLSPService();
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	resetLSPService();
	fs.rmSync(tmp, { recursive: true, force: true });
});

// Recurrence (#5501): `Cargo.toml` and `go.mod` were not on the list, so a
// manifest fixed after rust-analyzer's workspace failed to load never reached
// it (every touch read `server-load-failed` until restart), and a `go.mod`
// raised from go 1.17 to 1.21 left gopls's "requires go1.18" finding in place
// through six touches. Both servers were measured; see server-config-files.ts.
describe.each(["pyrightconfig.json", "pyproject.toml", "Cargo.toml", "go.mod"])(
	"a %s changed outside pi-lens",
	(name) => {
		const config = () => path.join(tmp, name);

		it("is forwarded as Created when born after the baseline look", async () => {
			const seen = await lookAfter(() => fs.writeFileSync(config(), "{}\n"));
			expect(seen).toHaveLength(1);
			expect(seen[0].sources).toEqual(["config"]);
			expect(seen[0].pathChanges).toEqual([
				{ filePath: config(), type: "created" },
			]);
			expect(notified).toEqual([{ filePath: config(), type: 1 }]);
			// A config changes the analysis of every file under its root.
			expect(seen[0].paths).toBe("unknown");
			expect(cacheRefusedAt()).toBe(seen[0].at);
			// A config is not an install: no server restarts for it.
			expect(restarted).toEqual([]);
		});

		it("is forwarded as Changed when edited and as Deleted when removed", async () => {
			fs.writeFileSync(config(), '{"a":1}\n');
			await lookForOutOfBandChanges(tmp, "tool_result", runtime);
			fs.writeFileSync(config(), '{"a":22}\n');
			await lookForOutOfBandChanges(tmp, "tool_result", runtime);
			fs.rmSync(config());
			await lookForOutOfBandChanges(tmp, "tool_result", runtime);
			expect(notified).toEqual([
				{ filePath: config(), type: 2 },
				{ filePath: config(), type: 3 },
			]);
		});

		it("is only recorded, not forwarded, by the root's first look", async () => {
			fs.writeFileSync(config(), "{}\n");
			await lookForOutOfBandChanges(tmp, "tool_result", runtime);
			expect(notified).toEqual([]);
		});
	},
);

describe("a file that is not on the closed config list", () => {
	// Recurrence: a gate that enumerates names it knows to be bad passes the
	// next spelling. Only the listed basenames, spelled exactly, are forwarded:
	// typescript-language-server was measured to pick up a late tsconfig.json by
	// itself, so it is not listed.
	it.each([
		"tsconfig.json",
		"jsconfig.json",
		"package.json",
		"setup.py",
		"PyProject.toml",
		// Spelled as the servers do not read them (#5501): the list is exact and
		// case-sensitive, and the lock/sum/work companions are unmeasured.
		"cargo.toml",
		"Cargo.toml.orig",
		"Go.mod",
		"go.work",
		"pyrightconfig.json.bak",
		"my-pyrightconfig.json",
	])("%s publishes nothing", async (name) => {
		const seen = await lookAfter(() =>
			fs.writeFileSync(path.join(tmp, name), "{}\n"),
		);
		expect(seen).toEqual([]);
		expect(notified).toEqual([]);
	});

	it("is not looked for below the root (the look stats the root only)", async () => {
		fs.mkdirSync(path.join(tmp, "sub"));
		const seen = await lookAfter(() =>
			fs.writeFileSync(path.join(tmp, "sub", "pyrightconfig.json"), "{}\n"),
		);
		expect(seen).toEqual([]);
	});
});

describe("a Python stub (.pyi) changed outside pi-lens (#4532 gap 3b)", () => {
	const stub = () => path.join(tmp, "stubs", "dep.pyi");

	it("is forwarded as Created, Changed and Deleted like a .d.ts", async () => {
		fs.mkdirSync(path.dirname(stub()));
		await lookForOutOfBandChanges(tmp, "tool_result", runtime);
		fs.writeFileSync(stub(), "VALUE: int\n");
		await lookForOutOfBandChanges(tmp, "tool_result", runtime);
		fs.writeFileSync(stub(), "VALUE: int\nOTHER: str\n");
		await lookForOutOfBandChanges(tmp, "tool_result", runtime);
		fs.rmSync(stub());
		await lookForOutOfBandChanges(tmp, "tool_result", runtime);
		expect(notified).toEqual([
			{ filePath: stub(), type: 1 },
			{ filePath: stub(), type: 2 },
			{ filePath: stub(), type: 3 },
		]);
	});

	it("is not forwarded from an excluded directory (.venv stays unwalked)", async () => {
		fs.mkdirSync(path.join(tmp, ".venv", "lib"), { recursive: true });
		const seen = await lookAfter(() =>
			fs.writeFileSync(path.join(tmp, ".venv", "lib", "dep.pyi"), "X: int\n"),
		);
		expect(seen).toEqual([]);
	});

	it("does not forward an ordinary .py file", async () => {
		const seen = await lookAfter(() =>
			fs.writeFileSync(path.join(tmp, "mod.py"), "X = 1\n"),
		);
		expect(seen).toEqual([]);
	});
});

/**
 * #4532 gap 3: a `pip install` into a project `.venv` that keeps no lockfile.
 *
 * The reported workspace: a `pyproject.toml` and a local `.venv`, no
 * `requirements.txt`/`poetry.lock`/`uv.lock` anywhere, and the install run from
 * outside pi-lens. The lockfile and `node_modules` stamp was blind to it, so
 * nothing published, no primary client restarted, and pyright kept the
 * `Import "x" could not be resolved` it had cached for its whole life (real
 * pyright 1.1.414: stale through 40 calls over 20.3 s; the same install behind
 * a published change cleared on call 1).
 *
 * The stamp is one directory stat per `site-packages` and no listing of its
 * contents, so these cases drive real directories: `pip install` adds the
 * package's directory and its `.dist-info` entry, which is what moves the
 * directory's own mtime, inode or size.
 */
describe("a pip install into a lockfile-less venv (#4532 gap 3)", () => {
	const sitePackages = (venv = ".venv", version = "python3.12") =>
		path.join(tmp, venv, "lib", version, "site-packages");

	/** What `pip install alpha-pkg` writes into a venv on this platform. */
	const pipInstall = (site: string, name = "alpha_pkg") => {
		fs.mkdirSync(path.join(site, name), { recursive: true });
		fs.writeFileSync(path.join(site, name, "__init__.py"), "VALUE = 1\n");
		fs.mkdirSync(path.join(site, `${name}-1.0.dist-info`), { recursive: true });
	};

	it("publishes an install that restarts the root and refuses every cache entry", async () => {
		fs.writeFileSync(
			path.join(tmp, "pyproject.toml"),
			'[project]\nname = "ws"\nversion = "0.1.0"\n',
		);
		const site = sitePackages();
		fs.mkdirSync(site, { recursive: true });
		const seen = await lookAfter(() => pipInstall(site));
		expect(seen).toHaveLength(1);
		expect(seen[0].sources).toEqual(["install"]);
		// An install cannot be enumerated, so the cache refuses everything scanned
		// before it rather than only the venv's own path.
		expect(seen[0].paths).toBe("unknown");
		expect(restarted).toEqual([normalizeMapKey(tmp)]);
		expect(cacheRefusedAt()).toBe(seen[0].at);
		// No config changed, so nothing goes out as a watched-files event.
		expect(notified).toEqual([]);
	});

	it("sees the same install in a venv named `venv`", async () => {
		const site = sitePackages("venv", "python3.13");
		fs.mkdirSync(site, { recursive: true });
		const seen = await lookAfter(() => pipInstall(site));
		expect(seen.map((change) => change.sources)).toEqual([["install"]]);
	});

	it("sees an install in the Windows venv layout (`Lib/site-packages`)", async () => {
		// The layout is directory-shaped data, not host behaviour: a POSIX host
		// creating it is exactly what a Windows checkout looks like here, and the
		// stamp must read both without a platform branch.
		const site = path.join(tmp, ".venv", "Lib", "site-packages");
		fs.mkdirSync(site, { recursive: true });
		const seen = await lookAfter(() => pipInstall(site));
		expect(seen.map((change) => change.sources)).toEqual([["install"]]);
	});

	it("publishes a venv install that landed after its client spawned (first look)", async () => {
		const site = sitePackages();
		pipInstall(site);
		// The client spawned before the install: the venv's `site-packages` is
		// fresher than that epoch, so the root's first look publishes it instead of
		// recording it as a baseline the server already read.
		const seen = recordPublishes();
		await lookForOutOfBandChanges(tmp, "tool_call", runtime, {
			since: Date.now() - 10_000,
		});
		expect(seen.map((change) => change.sources)).toEqual([["install"]]);
		expect(restarted).toEqual([normalizeMapKey(tmp)]);
	});

	it("stamps the interpreter directory past stray files in `lib`", async () => {
		// Recurrence (review 5009 F1): `lib` holds non-directory entries beside the
		// interpreter directory, and slicing the ordinal-sorted listing BEFORE the
		// type guard let four stray files spend the cap, so the venv's only
		// interpreter directory was never stamped and an install there published
		// nothing. The cap bounds the stats, not the candidates.
		const site = sitePackages();
		fs.mkdirSync(site, { recursive: true });
		for (const stray of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
			fs.writeFileSync(path.join(tmp, ".venv", "lib", stray), "");
		}
		const seen = await lookAfter(() => pipInstall(site));
		expect(seen.map((change) => change.sources)).toEqual([["install"]]);
	});

	it("sees an install in the second interpreter directory", async () => {
		// The cap's own value, pinned (review 5009 F1): a venv holds one
		// interpreter directory per version, so the second sorts inside the bound
		// and an install into it must publish. The cap's policy is "a real venv
		// fits"; the case reds the moment the bound drops below two.
		fs.mkdirSync(sitePackages(".venv", "python3.11"), { recursive: true });
		const site = sitePackages(".venv", "python3.12");
		fs.mkdirSync(site, { recursive: true });
		const seen = await lookAfter(() => pipInstall(site));
		expect(seen.map((change) => change.sources)).toEqual([["install"]]);
	});

	it("records a venv install older than the first look's client epoch", async () => {
		pipInstall(sitePackages());
		const seen = recordPublishes();
		await lookForOutOfBandChanges(tmp, "tool_call", runtime, {
			since: Date.now() + 60_000,
		});
		expect(seen).toEqual([]);
	});

	it("publishes nothing for a write inside an existing package", async () => {
		// The bound the stamp's cost buys: only an entry of `site-packages` itself
		// is stamped, so a `__pycache__` write inside an installed package moves no
		// stamp. Pip's own reinstall removes and re-adds the entry, which does.
		const site = sitePackages();
		pipInstall(site, "beta_pkg");
		const seen = await lookAfter(() =>
			fs.mkdirSync(path.join(site, "beta_pkg", "__pycache__"), {
				recursive: true,
			}),
		);
		expect(seen).toEqual([]);
	});

	it("adds nothing to a look when the root keeps no venv", async () => {
		const seen = await lookAfter(() =>
			fs.writeFileSync(path.join(tmp, "mod.py"), "X = 1\n"),
		);
		expect(seen).toEqual([]);
	});
});

describe("a config name reaches the servers of its extension too (#4532 gap 12, F1)", () => {
	// Recurrence: the config route REPLACED the extension route, so a
	// `pyproject.toml` event reached pyright and no longer the TOML server, and
	// a `pyrightconfig.json` event reached pyright and no longer the JSON server
	// or the auxiliaries (format clients, opengrep, ast-grep, typos) that read
	// the file by extension. Real `LSPService` routing; the clients are the host
	// boundary (they record the events they are sent).
	function deliveredTo(file: string): string[] {
		const service = new LSPService();
		const delivered: string[] = [];
		const internal = service as unknown as {
			state: { clients: Map<string, unknown> };
		};
		for (const id of [
			"python",
			"toml",
			"json",
			"opengrep",
			"ast-grep",
			"typos",
			"typescript",
		]) {
			internal.state.clients.set(`${id}:${tmp}`, {
				isAlive: () => true,
				notify: {
					watchedFileChange: (changed: string, type: number) => {
						if (changed === file && type === 2) delivered.push(id);
					},
					flushWatched: () => undefined,
				},
			});
		}
		service.notifyOutOfBandFileChanges([{ filePath: file, type: 2 }]);
		return delivered.sort();
	}

	it("pyproject.toml reaches python and toml", () => {
		expect(deliveredTo(path.join(tmp, "pyproject.toml"))).toEqual([
			"python",
			"toml",
		]);
	});

	it("pyrightconfig.json reaches python, json and the json auxiliaries once each", () => {
		expect(deliveredTo(path.join(tmp, "pyrightconfig.json"))).toEqual([
			"ast-grep",
			"json",
			"opengrep",
			"python",
			"typos",
		]);
	});
});

describe("an unlistable root keeps the config baseline", () => {
	// Recurrence guard for the baseline: reading an unlistable root as "no
	// config files" would publish every config as Created once it lists again.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"publishes no config change when the root lists again unchanged",
		async () => {
			fs.writeFileSync(path.join(tmp, "pyrightconfig.json"), "{}\n");
			await lookForOutOfBandChanges(tmp, "tool_result", runtime);
			fs.chmodSync(tmp, 0o000);
			try {
				await lookForOutOfBandChanges(tmp, "tool_result", runtime);
			} finally {
				fs.chmodSync(tmp, 0o755);
			}
			const seen = recordPublishes();
			await lookForOutOfBandChanges(tmp, "tool_result", runtime);
			expect(seen.flatMap((change) => change.sources)).not.toContain("config");
			expect(notified).toEqual([]);
		},
	);
});

describe("the look's record", () => {
	it("names the forwarded config files once per look", async () => {
		const saved = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		try {
			await lookAfter(() => {
				fs.writeFileSync(path.join(tmp, "pyrightconfig.json"), "{}\n");
				fs.writeFileSync(path.join(tmp, "pyproject.toml"), "\n");
			});
			await flushLatencyLog();
			const { rows: all, skipped } = readNdjsonRows<{
				phase?: string;
				filePath?: string;
				result?: string;
				metadata?: { configs?: string[] };
			}>(getLatencyLogPath());
			expect(skipped).toBe(0);
			const rows = all.filter(
				(row) => row.phase === "lsp_out_of_band_change" && row.filePath === tmp,
			);
			expect(rows).toHaveLength(1);
			expect(rows[0].result).toBe("config");
			expect(rows[0].metadata?.configs).toEqual([
				"created:pyrightconfig.json",
				"created:pyproject.toml",
			]);
		} finally {
			if (saved === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = saved;
		}
	});
});
