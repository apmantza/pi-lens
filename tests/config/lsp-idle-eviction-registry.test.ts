/**
 * #3622 recurrence guard: idle eviction used a hand-maintained key-prefix
 * spelling list, so a newly registered server could silently stay resident.
 * The registry now declares the policy and this checked table explains every
 * measured opt-in; unmeasured remains resident until evidence exists.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LSP_SERVERS } from "../../clients/lsp/server.js";

type IdleEviction = "transparent" | "resident" | "unmeasured";
type RegistryEntry = { id: string; idleEviction?: IdleEviction };

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const reasons = JSON.parse(
	readFileSync(
		path.join(repoRoot, "tests/config/lsp-idle-eviction-reasons.json"),
		"utf8",
	),
) as Record<string, string>;

export function idleEvictionRegistryIssues(
	servers: readonly RegistryEntry[],
	reasonTable: Record<string, string>,
): string[] {
	const issues: string[] = [];
	const ids = new Set<string>();
	for (const server of servers) {
		ids.add(server.id);
		if (!server.idleEviction) {
			issues.push(`${server.id}: missing idleEviction declaration`);
			continue;
		}
		if (
			server.idleEviction !== "transparent" &&
			server.idleEviction !== "resident" &&
			server.idleEviction !== "unmeasured"
		) {
			issues.push(`${server.id}: invalid idleEviction value`);
		}
		if (
			server.idleEviction !== "unmeasured" &&
			(!reasonTable[server.id] || reasonTable[server.id].trim() === "")
		) {
			issues.push(`${server.id}: non-unmeasured policy lacks a reason`);
		}
	}
	for (const [id, reason] of Object.entries(reasonTable)) {
		if (!ids.has(id)) issues.push(`${id}: reason names an absent server`);
		if (reason.trim() === "") issues.push(`${id}: reason is empty`);
	}
	return issues;
}

describe("LSP idle-eviction registry (#3622)", () => {
	it("declares and explains every policy without orphan reasons", () => {
		expect(idleEvictionRegistryIssues(LSP_SERVERS, reasons)).toEqual([]);
		expect(LSP_SERVERS.length).toBeGreaterThan(40);
	});

	it("keeps both missing-declaration and missing-reason boundaries red", () => {
		expect(
			idleEvictionRegistryIssues(
				[
					{ id: "new-server" },
					{ id: "measured-server", idleEviction: "transparent" },
				],
				{},
			),
		).toEqual([
			"new-server: missing idleEviction declaration",
			"measured-server: non-unmeasured policy lacks a reason",
		]);
	});

	it("keeps reason rows tied to registered ids", () => {
		expect(
			idleEvictionRegistryIssues(
				[{ id: "registered", idleEviction: "unmeasured" }],
				{ orphan: "stale reason" },
			),
		).toContain("orphan: reason names an absent server");
	});
});
