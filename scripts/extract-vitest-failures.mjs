#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { normalizeVitestOutput } from "./lib/vitest-summary.mjs";

const MAX_FAILURE_OUTPUT_LENGTH = 12_000;

/** Return the Vitest failure blocks, preserving bounded diagnostic details. */
export function extractVitestFailureBlock(output) {
	const lines = normalizeVitestOutput(String(output)).split("\n");
	const starts = lines.flatMap((line, index) =>
		/^\s*FAIL\b/.test(line) ? [index] : [],
	);
	if (!starts.length) return "";
	const blocks = starts.map((start, blockIndex) => {
		const nextStart = starts[blockIndex + 1] ?? lines.length;
		const summary = lines.findIndex(
			(line, index) =>
				index > start && index < nextStart && /^\s*Test Files\b/.test(line),
		);
		return lines
			.slice(start, summary < 0 ? nextStart : summary)
			.join("\n")
			.trim();
	});
	const rendered = [];
	let length = 0;
	for (const [index, block] of blocks.entries()) {
		const separatorLength = rendered.length ? 2 : 0;
		const remainingBlocks = blocks.length - index;
		const truncation = `(${remainingBlocks} more failures truncated)`;
		const minimumLength = separatorLength + truncation.length;
		if (length + minimumLength > MAX_FAILURE_OUTPUT_LENGTH) {
			rendered.push(truncation);
			break;
		}
		const available =
			MAX_FAILURE_OUTPUT_LENGTH -
			length -
			separatorLength -
			truncation.length -
			1;
		if (block.length > available) {
			rendered.push(`${block.slice(0, available).trimEnd()}\n${truncation}`);
			break;
		}
		rendered.push(block);
		length += separatorLength + block.length;
	}
	return rendered.join("\n\n").trim();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const input = process.argv[2];
	if (!input) throw new Error("usage: extract-vitest-failures.mjs <log>");
	const block = extractVitestFailureBlock(readFileSync(input, "utf8"));
	if (block) process.stdout.write(`${block}\n`);
}
