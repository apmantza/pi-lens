#!/usr/bin/env node
/**
 * Shared tracking-issue CLI for nightly workflow alerts.
 *
 * Usage:
 *   node scripts/upsert-tracking-issue.mjs --title TITLE --label LABEL \
 *     --body-file BODY [--comment TEXT] [--close-when-clean] [--clean]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { upsertTrackingIssue } from "./lib/drift-issue.mjs";

function valueAfter(argv, flag) {
	const index = argv.indexOf(flag);
	if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("--")) {
		throw new Error(`${flag} requires a value`);
	}
	return argv[index + 1];
}

function gh(args) {
	return execFileSync("gh", args, { encoding: "utf8" });
}

function main(argv = process.argv.slice(2), ghRunner = gh) {
	const title = valueAfter(argv, "--title");
	const label = valueAfter(argv, "--label");
	const bodyFile = argv.includes("--body-file")
		? valueAfter(argv, "--body-file")
		: undefined;
	const clean = argv.includes("--clean");
	const closeWhenClean = argv.includes("--close-when-clean");
	const comment = argv.includes("--comment")
		? valueAfter(argv, "--comment")
		: undefined;
	if (!clean && !bodyFile) {
		throw new Error("--body-file is required unless --clean is set");
	}
	if (bodyFile) readFileSync(bodyFile, "utf8");
	const action = upsertTrackingIssue({
		title,
		label,
		bodyFile,
		body: bodyFile ?? "",
		clean,
		closeWhenClean,
		comment,
		gh: ghRunner,
	});
	console.log(`[upsert-tracking-issue] ${action.action} ${title}`);
	return action;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		main();
	} catch (error) {
		console.error(`[upsert-tracking-issue] failed: ${error?.message ?? error}`);
		process.exitCode = 1;
	}
}

export { main };
