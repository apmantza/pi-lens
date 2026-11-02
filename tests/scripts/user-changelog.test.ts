// #5198: drive the release emitter and pi's actual changelog reader.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import * as rollup from "../../scripts/rollup-changelog.mjs";
const {
	parseChangelog,
}: {
	parseChangelog(file: string): Array<{ patch: number; content: string }>;
} = await import(
	new URL(
		"./utils/changelog.js",
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	).href
);

const roots: string[] = [];
afterEach(() =>
	roots
		.splice(0)
		.forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);
function fixture() {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-user-changelog-"),
	);
	roots.push(root);
	fs.mkdirSync(path.join(root, ".changelog"));
	fs.writeFileSync(
		path.join(root, "CHANGELOG.md"),
		"# Changelog\n\n## [Unreleased]\n\n### Added\n\n- **Unreleased feature** is pending.\n\n" +
			Array.from(
				{ length: 7 },
				(_, i) =>
					`## [1.0.${7 - i}] - 2026-01-01\n\n### Added\n\n- **Public ${7 - i}** [guide](docs/usage.md), [root](/docs/root.md), [anchor](#usage), [external](https://example.com/guide), [cdn](//example.com/a).\n\n### Internal\n\n<details>\n<summary>private</summary>\n\n- secret ${i}\n\n</details>\n\n### Fixed\n\n- **Visible fix** works.\n\n`,
			).join(""),
	);
	for (const audience of ["user", "internal"])
		fs.writeFileSync(
			path.join(root, ".changelog", `${audience}.md`),
			`---\nsection: Added\naudience: ${audience}\n---\n\n- **Pending ${audience}** works.\n`,
		);
	return root;
}
it("emits five public releases with absolute links readable by pi across a version jump", () => {
	const root = fixture();
	rollup.writeUserChangelog({ rootDir: root });
	const file = path.join(root, "CHANGELOG-USER.md");
	const text = fs.readFileSync(file, "utf8");
	expect(text).not.toMatch(
		/secret|<details>|<summary>|### Internal|Pending internal/,
	);
	expect(text).not.toMatch(/Pending|Unreleased/);
	expect(text).not.toContain("### Deprecated");
	expect(text).toContain(
		"https://github.com/apmantza/pi-lens/blob/v1.0.7/docs/usage.md",
	);
	for (const target of ["v1.0.7/docs/root.md", "v1.0.7/CHANGELOG.md#usage"])
		expect(text).toContain(
			`https://github.com/apmantza/pi-lens/blob/${target}`,
		);
	expect(text).toContain("https://example.com/guide");
	expect(text).toContain("https://example.com/a");
	const entries = parseChangelog(file);
	expect(entries.map((entry) => entry.patch)).toEqual([7, 6, 5, 4, 3]);
	expect(
		entries.filter((entry) => entry.patch > 5).map((entry) => entry.patch),
	).toEqual([7, 6]);
	expect(entries[0].content).toContain("Public 7");
	expect(entries[0].content).toContain("Visible fix");
});
it("ignores pending fragments and checks released-file drift", () => {
	const root = fixture();
	rollup.writeUserChangelog({ rootDir: root });
	expect(() => rollup.checkUserChangelog({ rootDir: root })).not.toThrow();
	fs.appendFileSync(
		path.join(root, ".changelog/user.md"),
		"  more user detail\n",
	);
	expect(() => rollup.checkUserChangelog({ rootDir: root })).not.toThrow();
	const source = path.join(root, "CHANGELOG.md");
	fs.writeFileSync(
		source,
		fs.readFileSync(source, "utf8").replace("Public 7", "Released change"),
	);
	expect(() => rollup.checkUserChangelog({ rootDir: root })).toThrow(
		/CHANGELOG-USER.md/,
	);
	rollup.writeUserChangelog({ rootDir: root });
	fs.appendFileSync(path.join(root, "CHANGELOG-USER.md"), "drift\n");
	expect(() => rollup.checkUserChangelog({ rootDir: root })).toThrow(
		/CHANGELOG-USER.md/,
	);
});
it("release rollup refreshes the user file after consuming audience fragments", () => {
	const root = fixture();
	rollup.rollupChangelog("1.0.8", { rootDir: root });
	fs.unlinkSync(path.join(root, "CHANGELOG-USER.md"));
	rollup.rollupChangelog("1.0.8", { rootDir: root });
	const text = fs.readFileSync(path.join(root, "CHANGELOG-USER.md"), "utf8");
	expect(text).toContain("## [1.0.8]");
	expect(text).toContain("Pending user");
	expect(text).not.toContain("Pending internal");
	expect(() => rollup.checkUserChangelog({ rootDir: root })).not.toThrow();
});

// #5198: npm's changelog:check must actually call the emitter's drift check.
it("the check CLI rejects a stale user changelog", async () => {
	const root = fixture();
	rollup.writeUserChangelog({ rootDir: root });
	fs.appendFileSync(path.join(root, "CHANGELOG-USER.md"), "stale\n");
	fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
	for (const file of ["rollup-changelog.mjs", "lib/changelog.mjs"])
		fs.copyFileSync(
			path.resolve("scripts", file),
			path.join(root, "scripts", file),
		);
	const cli = path.join(root, "scripts/rollup-changelog.mjs");
	const argv = process.argv;
	const exitCode = process.exitCode;
	try {
		process.argv = [process.execPath, cli, "--check"];
		process.exitCode = 0;
		await import(cli);
		expect(process.exitCode).toBe(1);
		// The repair command printed by the stale-file error must really refresh it.
		const repairCli = path.join(root, "scripts/rollup-user.mjs");
		fs.copyFileSync(cli, repairCli);
		process.argv = [process.execPath, repairCli, "--user"];
		process.exitCode = 0;
		await import(repairCli);
		expect(process.exitCode).toBe(0);
		expect(fs.readFileSync(path.join(root, "CHANGELOG-USER.md"), "utf8")).toBe(
			rollup.renderUserChangelog({ rootDir: root }),
		);
	} finally {
		process.argv = argv;
		process.exitCode = exitCode;
	}
});

// #5202 F2: Unit tests must read the actual shipped artifact.
it("the shipped user changelog matches the last five released sections", () => {
	expect(() => rollup.checkUserChangelog()).not.toThrow();
	expect(fs.readFileSync("CHANGELOG-USER.md", "utf8")).not.toContain(
		"## [Unreleased]",
	);
});
