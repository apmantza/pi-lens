#!/usr/bin/env node
/**
 * Nightly idle-eviction PROMOTION step (#3989).
 *
 * Reads the measurement's `--summary` JSON, advances the per-server
 * consecutive-night memory kept in the `## Capability matrix refresh state`
 * block of docs/lsp-capability-matrix.md (#3401's bookkeeping seam, so the
 * existing docs-refresh PR carries the state forward and the existing seed step
 * restores it each night), and, for every server that now satisfies the rule in
 * scripts/lib/lsp-idle-eviction-promote.mjs, flips its `idleEviction:
 * "unmeasured"` line to `"transparent"` in clients/lsp/server.ts and adds its
 * reason row to tests/config/lsp-idle-eviction-reasons.json, in the working
 * tree. The workflow's second create-pull-request step commits those edits and
 * the generated changelog to `bot/lsp-idle-evict-promote` as a DRAFT PR; it is
 * never merged here.
 * It also emits one user-facing changelog fragment naming the promoted servers.
 *
 *   node scripts/promote-lsp-idle-eviction.mjs --summary <path> [--body <path>]
 *       [--matrix <path>] [--server-src <path>] [--reasons <path>] [--today <YYYY-MM-DD>]
 *
 * Fail closed and best-effort: a missing or unparsable summary clears the night
 * memory (a night that measured nothing is not a consecutive eligible night)
 * and promotes nothing; the script always exits 0. With `GITHUB_OUTPUT` set it
 * writes `promoted=true|false`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	parseRejectedServers,
	planPromotions,
} from "./lib/lsp-idle-eviction-promote.mjs";
import {
	IDLE_EVICTION_KEY,
	parseRefreshState,
	setIdleEvictionState,
} from "./lib/md-matrix.mjs";

/**
 * The servers of closed-unmerged promotion PRs, from the file the workflow
 * wrote (`gh pr list --state closed`). No path given: nothing was rejected. A
 * path that cannot be read is `null` ("unknown"), and the plan promotes nothing.
 */
function readRejected(file) {
	if (!file) return new Set();
	try {
		return parseRejectedServers(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/**
 * One nightly run. Returns the promoted server ids; never throws.
 *
 * @param {{ summaryPath?: string, bodyPath?: string, changelogPath?: string, matrixPath: string, serverPath: string, reasonsPath: string, registryPath: string, rejectedPath?: string, today: string, runUrl?: string | null, log?: (line: string) => void }} opts
 * @returns {string[]}
 */
export function promoteFromSummary(opts) {
	const log = opts.log ?? ((line) => console.error(line));
	try {
		const matrixText = fs.readFileSync(opts.matrixPath, "utf8");
		let rows = null;
		try {
			const parsed = JSON.parse(
				fs.readFileSync(opts.summaryPath ?? "", "utf8"),
			);
			if (Array.isArray(parsed?.rows)) rows = parsed.rows;
		} catch {
			// handled below: no summary is a night that measured nothing.
		}
		if (!rows) {
			log(
				"idle-eviction promotion: no readable measurement summary; clearing the night memory and promoting nothing",
			);
			fs.writeFileSync(opts.matrixPath, setIdleEvictionState(matrixText, {}));
			return [];
		}
		const plan = planPromotions({
			rows,
			prior: parseRefreshState(matrixText)[IDLE_EVICTION_KEY],
			today: opts.today,
			serverSource: fs.readFileSync(opts.serverPath, "utf8"),
			reasonsText: fs.readFileSync(opts.reasonsPath, "utf8"),
			registrySource: fs.readFileSync(opts.registryPath, "utf8"),
			rejected: readRejected(opts.rejectedPath),
			runUrl: opts.runUrl,
		});
		fs.writeFileSync(
			opts.matrixPath,
			setIdleEvictionState(matrixText, plan.state),
		);
		for (const s of plan.skipped)
			log(`idle-eviction promotion: skip ${s.serverId}: ${s.reason}`);
		for (const p of plan.promoted)
			log(
				`idle-eviction promotion: promote ${p.serverId} (rss ${p.minRssMb} MB, cold start ${p.worstColdMs} ms)`,
			);
		if (plan.promoted.length === 0) return [];
		fs.writeFileSync(opts.serverPath, plan.serverSource);
		fs.writeFileSync(opts.reasonsPath, plan.reasonsText);
		fs.writeFileSync(opts.registryPath, plan.registrySource);
		if (opts.bodyPath && plan.body) fs.writeFileSync(opts.bodyPath, plan.body);
		if (opts.changelogPath) {
			const previous = fs.existsSync(opts.changelogPath)
				? fs.readFileSync(opts.changelogPath, "utf8")
				: "";
			const previousIds = [...previous.matchAll(/`([^`]+)`/g)].map(
				([, serverId]) => serverId,
			);
			const serverIds = [
				...new Set([...previousIds, ...plan.promoted.map((p) => p.serverId)]),
			];
			fs.writeFileSync(
				opts.changelogPath,
				`---\nsection: Changed\naudience: user\n---\n\n- Idle eviction is now enabled for ${serverIds.map((serverId) => `\`${serverId}\``).join(", ")} after consecutive safe measurements (refs #3989).\n`,
			);
		}
		return plan.promoted.map((p) => p.serverId);
	} catch (error) {
		log(`idle-eviction promotion: ${error?.message ?? error}`);
		return [];
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const repoRoot = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
	);
	const argv = process.argv.slice(2);
	const flag = (name, fallback) => {
		const at = argv.indexOf(name);
		return at >= 0 ? argv[at + 1] : fallback;
	};
	const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
	const promoted = promoteFromSummary({
		summaryPath: flag("--summary", undefined),
		bodyPath: flag("--body", undefined),
		matrixPath: flag(
			"--matrix",
			path.join(repoRoot, "docs", "lsp-capability-matrix.md"),
		),
		serverPath: flag(
			"--server-src",
			path.join(repoRoot, "clients", "lsp", "server.ts"),
		),
		reasonsPath: flag(
			"--reasons",
			path.join(repoRoot, "tests", "config", "lsp-idle-eviction-reasons.json"),
		),
		registryPath: flag(
			"--registry-test",
			path.join(
				repoRoot,
				"tests",
				"config",
				"lsp-idle-eviction-registry.test.ts",
			),
		),
		changelogPath: path.join(
			repoRoot,
			".changelog",
			"3989-lsp-idle-eviction-promote.md",
		),
		rejectedPath: flag("--rejected", undefined),
		today: flag("--today", new Date().toISOString().slice(0, 10)),
		runUrl:
			GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
				? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
				: null,
	});
	if (process.env.GITHUB_OUTPUT)
		fs.appendFileSync(
			process.env.GITHUB_OUTPUT,
			`promoted=${promoted.length > 0}\n`,
		);
}
