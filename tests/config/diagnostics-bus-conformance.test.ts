import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../support/module-instance-scan.js";
import {
	assertNonEmptyScan,
	escapeRegExp,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const EVENT = "pilens:diagnostics";

type BusSurfaceEntry = {
	file: string;
	why: string;
};

// This is the reviewable contract. The diagnostics event is broadcast-only on
// this tree, so the empty subscriber list is intentional and must stay live.
const PUBLISHERS: BusSurfaceEntry[] = [
	{
		file: "clients/pipeline.ts",
		why: "final per-file diagnostic state after a write batch completes",
	},
];

const SUBSCRIBERS: BusSurfaceEntry[] = [];

function sourceFiles(): string[] {
	const roots = ["clients", "tools", "mcp", "scripts"];
	const files = roots.flatMap((root) =>
		listSourceFiles(path.join(repoRoot, root), {
			extensions: [".ts"],
			skipDeclarations: false,
		}),
	);
	files.push(path.join(repoRoot, "index.ts"));
	const result = [...new Set(files)]
		.map((file) => relativePosix(repoRoot, file))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	assertNonEmptyScan("pilens:diagnostics bus source scan", result.length);
	return result;
}

function read(file: string): string {
	return fs.readFileSync(path.join(repoRoot, file), "utf8");
}

function busPublisherFiles(
	files: string[],
	sources: Map<string, string>,
): string[] {
	return files
		.filter((file) => file !== "clients/diagnostics-publish.ts")
		.filter((file) => {
			const source = stripSource(sources.get(file) ?? "");
			const importSource = stripSource(sources.get(file) ?? "", {
				strings: "keep",
			});
			const directCall = /(?<![\w$.])publishDiagnostics\s*\(/.test(source);
			const seamImport =
				/import\s*\{[^}]*\bpublishDiagnostics\b[^}]*\}\s*from\s*["'][^"']*diagnostics-publish(?:\.js)?["']/.test(
					importSource,
				);
			return directCall || seamImport;
		});
}

function busSubscriberFiles(
	files: string[],
	sources: Map<string, string>,
): string[] {
	return files.filter((file) => {
		const source = stripSource(sources.get(file) ?? "", { strings: "keep" });
		const bindings = new Set<string>();
		const definition =
			/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["']pilens:diagnostics["']/g;
		let match: RegExpExecArray | null;
		while ((match = definition.exec(source))) bindings.add(match[1]);
		const busImport =
			/import\s*\{([^}]*)\}\s*from\s*["'][^"']*diagnostics-publish(?:\.js)?["']/g;
		while ((match = busImport.exec(source))) {
			for (const specifier of match[1].split(",")) {
				const eventImport =
					/^\s*BUS_DIAGNOSTICS_EVENT\b(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(
						specifier,
					);
				if (eventImport)
					bindings.add(eventImport[1] ?? "BUS_DIAGNOSTICS_EVENT");
			}
		}
		const eventArgument = `(?:["']${EVENT}["']|${
			[...bindings].map(escapeRegExp).join("|") || "(?!)"
		})`;
		return new RegExp(`\\.on\\s*\\(\\s*${eventArgument}(?=\\s*[,)])`).test(
			source,
		);
	});
}

describe("pilens:diagnostics bus surface (#2079)", () => {
	it("keeps the event constant and declared publisher list in conformance", () => {
		const files = sourceFiles();
		const sources = new Map(files.map((file) => [file, read(file)]));
		const eventFiles = files.filter((file) => read(file).includes(EVENT));
		expect(eventFiles).toContain("clients/diagnostics-publish.ts");

		const actual = busPublisherFiles(files, sources).sort((a, b) =>
			a < b ? -1 : a > b ? 1 : 0,
		);
		expect(actual, "new publisher: update PUBLISHERS and AGENTS.md").toEqual(
			PUBLISHERS.map((entry) => entry.file).sort((a, b) =>
				a < b ? -1 : a > b ? 1 : 0,
			),
		);
	});

	it("keeps the event subscriber list in conformance", () => {
		const files = sourceFiles();
		const sources = new Map(files.map((file) => [file, read(file)]));
		const actual = busSubscriberFiles(files, sources).sort((a, b) =>
			a < b ? -1 : a > b ? 1 : 0,
		);
		expect(actual, "new subscriber: update SUBSCRIBERS and AGENTS.md").toEqual(
			SUBSCRIBERS.map((entry) => entry.file).sort((a, b) =>
				a < b ? -1 : a > b ? 1 : 0,
			),
		);
	});

	it("ignores comments and recognizes direct, aliased, and literal subscribers", () => {
		const files = ["comment.ts", "alias.ts", "imported.ts", "literal.ts"];
		const sources = new Map([
			["comment.ts", "// publishDiagnostics({}); bus.on(EVENT, handler);"],
			[
				"alias.ts",
				'import { publishDiagnostics as emitDiagnostics } from "./diagnostics-publish.js"; emitDiagnostics({});',
			],
			[
				"imported.ts",
				'import { BUS_DIAGNOSTICS_EVENT as DIAGS } from "./diagnostics-publish.js"; bus.on(DIAGS, handler);',
			],
			["literal.ts", 'bus.on("pilens:diagnostics", handler);'],
		]);
		expect(busPublisherFiles(files, sources)).toEqual(["alias.ts"]);
		expect(busSubscriberFiles(files, sources)).toEqual([
			"imported.ts",
			"literal.ts",
		]);
	});

	it("requires every declaration to explain why the bus applies", () => {
		const docs = read("AGENTS.md");
		for (const entry of [...PUBLISHERS, ...SUBSCRIBERS]) {
			expect(entry.why.length, `${entry.file} needs a reason`).toBeGreaterThan(
				20,
			);
			expect(docs, `${entry.file} is missing from AGENTS.md`).toContain(
				entry.file,
			);
		}
	});
});
