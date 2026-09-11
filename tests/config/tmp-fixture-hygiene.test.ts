import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

// Tmp-fixture hygiene governance (#2912). The setup hook in
// tests/support/vitest-setup.ts contains every temp dir a test creates by
// pointing TMPDIR/TMP/TEMP at a per-file private root, then removes that root
// in afterAll and reds the file on leftovers. That containment holds only
// when every mkdtemp site derives its parent from os.tmpdir()/tmpdir() at
// call time. This sweep pins the sites that would escape it.

const MKTEMP_CALLEE = /\bmkdtempSync\s*\(|\bmkdtemp\s*\(/g;
const TMPDIR_SOURCE = /\bos\.tmpdir\s*\(\s*\)|[^a-zA-Z]tmpdir\s*\(\s*\)/;
const TMPDIR_ENV_SOURCE = /process\.env\.TMPDIR/;
// Repo-rooted parents never enter /tmp, so the private-TMPDIR containment
// question does not apply to them. They are repo pollution of a different
// class (tracked-but-ignored `.probe-*` dirs), not tmpfs inodes.
const REPO_ROOTED_SOURCE =
	/\bREPO_ROOT\b|process\.cwd\s*\(\s*\)|\brepositoryRoot\b|\brepoRoot\b/;
// The sanctioned scratch seam (scripts/lib/scratch-dir.mjs) owns its
// lifecycle (owner.pid + sweepScratchDirs); sites under it are not strays.
const SCRATCH_SEAM_SOURCE = /\bSCRATCH_DIR_ROOT\b/;
const HARDCODED_TMP = /(["'`])\/tmp\//;

function scanMkdtempSites(): { file: string; line: number; text: string }[] {
	const roots = [path.join(REPO_ROOT, "tests"), path.join(REPO_ROOT, "scripts")];
	const sites: { file: string; line: number; text: string }[] = [];
	let fileCount = 0;
	for (const root of roots) {
		for (const file of listSourceFiles(root, { extensions: [".ts", ".mjs"] })) {
			fileCount += 1;
			const raw = fs.readFileSync(file, "utf8");
			const code = stripSource(raw);
			const lines = code.split("\n");
			for (const [index, line] of lines.entries()) {
				MKTEMP_CALLEE.lastIndex = 0;
				if (!MKTEMP_CALLEE.test(line)) continue;
				sites.push({
					file: path.relative(REPO_ROOT, file).replace(/\\/g, "/"),
					line: index + 1,
					text: line.trim().slice(0, 160),
				});
			}
		}
	}
	assertNonEmptyScan("mkdtemp population", sites.length, 50);
	assertNonEmptyScan("mkdtemp file population", fileCount, 100);
	return sites;
}

describe("tmp-fixture-hygiene", () => {
	it("routes every tests/ and scripts/ mkdtemp parent through a contained root", () => {
		const escapees = scanMkdtempSites().filter((site) => {
			const file = path.join(REPO_ROOT, site.file);
			const raw = fs.readFileSync(file, "utf8");
			const rawLines = raw.split("\n");
			// Multi-line calls carry path.join(os.tmpdir(), ...) on the
			// following lines; read the call window, not the call line.
			const window = rawLines.slice(site.line - 1, site.line + 2).join("\n");
			if (HARDCODED_TMP.test(window)) return true;
			if (TMPDIR_SOURCE.test(window)) return false;
			if (TMPDIR_ENV_SOURCE.test(window)) return false;
			if (REPO_ROOTED_SOURCE.test(window)) return false;
			if (SCRATCH_SEAM_SOURCE.test(window)) return false;
			// claimScratchDir IS the seam: it takes the caller's root.
			if (site.file === "scripts/lib/scratch-dir.mjs") return false;
			// One-hop const: a child of a tmpdir-derived `const root`.
			const parentId = window.match(
				/mkdtempSync\(\s*path\.join\(\s*([A-Za-z_$][\w$]*)\s*,/,
			)?.[1];
			if (parentId) {
				const decl = new RegExp(
					`const ${parentId} = [^;]*mkdtemp[^;]*tmpdir\\s*\\(`,
					"s",
				);
				if (decl.test(raw)) return false;
			}
			return true;
		});
		expect(
			escapees.map(
				(site) => `${site.file}:${site.line}: ${site.text}`,
			),
		).toEqual([]);
	});

	it("registers the tmp-hygiene setup hook in every vitest project", () => {
		const config = fs.readFileSync(
			path.join(REPO_ROOT, "vitest.config.ts"),
			"utf8",
		);
		expect(config).toContain("./tests/support/vitest-setup.ts");
		const setup = fs.readFileSync(
			path.join(REPO_ROOT, "tests/support/vitest-setup.ts"),
			"utf8",
		);
		expect(setup).toContain("[tmp-hygiene]");
	});

	it("contains mkdtemp dirs inside the private root", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-hygiene-self-"));
		try {
			expect(dir.startsWith(`${os.tmpdir()}${path.sep}`)).toBe(true);
			expect(path.basename(path.dirname(dir))).toMatch(
				/^pi-lens-test-file-/,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still flags a hardcoded /tmp parent as outside containment", () => {
		const outside = `/tmp/pi-lens-hygiene-outside-${process.pid}`;
		expect(outside.startsWith(`${os.tmpdir()}${path.sep}`)).toBe(false);
	});

	it("holds every tmp-leak admission to a reason, an issue, and a real file", () => {
		const setup = fs.readFileSync(
			path.join(REPO_ROOT, "tests/support/vitest-setup.ts"),
			"utf8",
		);
		const block =
			setup.match(/const TMP_LEAK_ADMISSIONS[^;]*;/s)?.[0] ?? "";
		const entries = [...block.matchAll(/file:\s*"([^"]+)"[\s\S]*?reason:\s*"([^"]+)"[\s\S]*?issue:\s*"([^"]+)"/g)];
		for (const [, file, reason, issue] of entries) {
			expect(reason.length).toBeGreaterThan(20);
			expect(issue).toMatch(/^#\d+$/);
			if (file !== "*") {
				expect(fs.existsSync(path.join(REPO_ROOT, file))).toBe(true);
			}
		}
	});
});
