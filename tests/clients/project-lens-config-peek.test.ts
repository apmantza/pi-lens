/**
 * `peekPiLensProjectConfig` reads what `loadPiLensProjectConfig` reads and
 * reports nothing, and leaves every report it withheld to the next loud load
 * (#5739, #2427 rule 2).
 *
 * Recurrence this guards: `effective_config` must not warn the user while it
 * answers, and must not consume the once-a-session notice either. The first
 * read of a chain fills the discovery cache, and the fill used to report a
 * legacy document it could not read at that moment, so a quiet read that filled
 * the cache first would have swallowed the report for the session's own loader.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadPiLensProjectConfig,
	peekPiLensProjectConfig,
	resetProjectLensConfigCache,
} from "../../clients/project-lens-config.js";
import { resetIgnoredConfigWarnCache } from "../../clients/config-warn.js";
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import {
	resetUserNotifier,
	wireUserNotifier,
} from "../../clients/user-notify.js";
import { useConfigPath } from "../support/global-config.js";
import { removeTempDirSync } from "./test-utils.js";

const setConfigPath = useConfigPath();

/** What the host's notifier received: the seam a user sees (config-notice-codes). */
const notices: string[] = [];

let home: string;
let repo: string;

function write(relative: string, text: string): void {
	const target = path.join(home, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, text);
}

beforeEach(() => {
	home = fs.realpathSync.native(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-peek-")),
	);
	repo = path.join(home, "repo");
	setConfigPath(path.join(home, ".pi-lens", "config.json"));
	write("repo/.git/HEAD", "ref: refs/heads/main");
	notices.length = 0;
	wireUserNotifier(() => (message) => {
		notices.push(message);
	});
	resetProjectLensConfigCache();
	resetIgnoredConfigWarnCache();
	resetDegradationLedger();
});

afterEach(() => {
	resetUserNotifier();
	resetIgnoredConfigWarnCache();
	resetDegradationLedger();
	resetProjectLensConfigCache();
	removeTempDirSync(home);
});

describe("peekPiLensProjectConfig (#5739)", () => {
	it("returns what the loud read returns and says nothing for a legacy document", () => {
		write("repo/.pi-lens.json", JSON.stringify({ autofix: { enabled: true } }));
		write(
			"repo/pi-lens.json",
			JSON.stringify({ tools: { module_report: { enabled: false } } }),
		);

		const quiet = peekPiLensProjectConfig(repo);
		expect(notices).toEqual([]);

		const loud = loadPiLensProjectConfig(repo);
		expect(quiet.raw).toEqual(loud.raw);
		expect(quiet.autofix?.enabled).toBe(true);
		// The notice the quiet read withheld is still the loud read's to send.
		expect(notices.join("\n")).toContain("deprecated");
	});

	it("leaves an unreadable legacy document's report to the next loud read, though the quiet read filled the cache", () => {
		write("repo/.pi-lens.json", JSON.stringify({ autofix: { enabled: true } }));
		write("repo/pi-lens.json", "{ not json");

		peekPiLensProjectConfig(repo);
		expect(notices).toEqual([]);

		loadPiLensProjectConfig(repo);
		expect(notices.join("\n")).toContain("pi-lens.json");
	});

	it("leaves an unreadable canonical document's report to the next loud read in a layered chain", () => {
		write("repo/.pi-lens.json", JSON.stringify({ autofix: { enabled: true } }));
		write("repo/pkg/.pi-lens.json", "{ not json");

		peekPiLensProjectConfig(path.join(repo, "pkg"));
		expect(notices).toEqual([]);

		loadPiLensProjectConfig(path.join(repo, "pkg"));
		expect(notices.join("\n")).toContain("pkg/.pi-lens.json");
	});
});
