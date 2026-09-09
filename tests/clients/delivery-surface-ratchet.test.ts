/**
 * #2028/#2029 — delivery-surface adoption ratchet.
 *
 * DELIVERY_SURFACES is the single registry for agent-facing findings/
 * blockers/advisories. `assertNoDeliveryBypass` validates entries IN it,
 * but an emitter that never registers bypasses every gate silently.
 *
 * This ratchet closes that gap: scan clients/ for agent-facing advisory
 * marker emoji (🔴/🛑/🟡) in string/template construction, then require
 * every hit file to appear as a sourceFile in DELIVERY_SURFACES or carry
 * an EXEMPT entry with a reason.
 *
 * Known limitation (documented, accepted floor): the needle matches the
 * emoji CHARACTER in source text; a surface that renders findings without
 * these markers (e.g. plain-text "WARNING:" prefix) is invisible here.
 * The AGENTS.md inventory paragraph is the complementary human check.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DELIVERY_SURFACES } from "../../clients/finding-delivery-gate.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const CLIENTS_DIR = path.join(REPO_ROOT, "clients");

const ADVISORY_MARKERS = /(?:🔴|🛑|🟡)(?![^\n]*color)/;
const SCAN_EXTENSIONS = new Set([".ts"]);

/** Files with emoji that are NOT agent-directed findings delivery. */
const EXEMPT: Record<string, string> = {
	"finding-delivery-gate.ts":
		"the registry itself - contains marker references in descriptions",
	"widget-state.ts":
		"registered as widget-state:footer; emoji in render output",
	"todo-scanner.ts": "classification icon return value, not delivered text",
	"actionable-warnings.ts":
		"advisory text built here but delivered by runtime-turn.ts (registered)",
	"demoted-finding-render.ts":
		"transforms pipeline stop-blocker output; follows that registration",
	"runtime-context.ts":
		"framing wrapper over registered context injections; no own delivery",
	"format-utils.ts":
		"shared emoji lookup table consumed by registered render paths",
};

function collectSourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectSourceFiles(full, out);
		} else if (
			SCAN_EXTENSIONS.has(path.extname(entry.name)) &&
			!entry.name.endsWith(".test.ts") &&
			!entry.name.endsWith(".d.ts")
		) {
			out.push(full);
		}
	}
	return out;
}

function registeredSourceFiles(): Set<string> {
	const files = new Set<string>();
	for (const entry of Object.values(DELIVERY_SURFACES)) {
		const sf = (entry as { file?: string }).file;
		if (sf) files.add(path.basename(sf));
	}
	return files;
}

describe("delivery-surface adoption ratchet (#2028/#2029)", () => {
	it("every advisory-marker file is registered or exempted", () => {
		const registered = registeredSourceFiles();
		const unregistered: string[] = [];

		for (const full of collectSourceFiles(CLIENTS_DIR)) {
			const rel = path.relative(CLIENTS_DIR, full);
			const base = path.basename(rel);
			const content = fs.readFileSync(full, "utf8");
			if (!ADVISORY_MARKERS.test(content)) continue;
			if (registered.has(base) || EXEMPT[base] || EXEMPT[rel]) continue;
			unregistered.push(rel);
		}

		expect(unregistered).toEqual([]);
	});

	it("exempted files still contain their marker (no stale exemptions)", () => {
		// Resolve each exempt key to its actual location (some are nested).
		const allFiles = collectSourceFiles(CLIENTS_DIR);
		for (const base of Object.keys(EXEMPT)) {
			const match = allFiles.find((f) => path.basename(f) === base);
			expect(
				match,
				`exempt file not found under clients/: ${base}`,
			).toBeDefined();
			const content = fs.readFileSync(match!, "utf8");
			expect(
				ADVISORY_MARKERS.test(content),
				`exempt file ${base} no longer matches advisory markers`,
			).toBe(true);
		}
	});

	it("ratchet floor: at least one advisory-marker file detected", () => {
		let count = 0;
		for (const full of collectSourceFiles(CLIENTS_DIR)) {
			if (ADVISORY_MARKERS.test(fs.readFileSync(full, "utf8"))) count++;
		}
		expect(count).toBeGreaterThanOrEqual(3);
	});
});
