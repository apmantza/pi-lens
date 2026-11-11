/**
 * #5466 — `ts-react-antipatterns` fires only in React context (a module that
 * imports a React/React-like hook source, or contains JSX). Exercised through
 * the REAL runner (real client + real query loader + the `has_react_context`
 * post-filter) so the loader and cache path is under test, not just
 * `runQueryOnFile`. The one-line `modifiedRanges` keeps the runner under its
 * entity-extraction threshold, so the review-graph enrichment never runs and
 * needs no mock; without `blockingOnly` the range does not filter findings.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import treeSitterRunner from "../../../../clients/dispatch/runners/tree-sitter.js";
import { getSharedTreeSitterClient } from "../../../../clients/tree-sitter-shared.js";
import { TreeSitterQueryLoader } from "../../../../clients/tree-sitter-query-loader.js";
import { loadWebTreeSitter } from "../../../../clients/deps/web-tree-sitter.js";
import {
	flushTreeSitterLog,
	getTreeSitterLogPath,
	type TreeSitterLogEntry,
} from "../../../../clients/tree-sitter-logger.js";
import { readNdjsonRows } from "../../../support/ndjson-rows.js";

import {
	assertGrammarAvailable,
	firedRuleIds,
	makeRealRunnerEnv,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

let env: RealRunnerEnv;
afterAll(() => env?.cleanup());

async function rulesFor(
	relPath: string,
	content: string,
): Promise<Set<string>> {
	const { ctx } = env.addFile(relPath, content);
	return firedRuleIds(await treeSitterRunner.run(ctx));
}

const REACT_LOOP_SRC =
	'import { useState } from "react";\nfor (const item of items) {\n  setCount(count + 1);\n}\n';
const PLAIN_LOOP_SRC = "for (const item of items) {\n  setRows(rows + 1);\n}\n";
const MULTI_LOOP_SRC = Array.from(
	{ length: 12 },
	(_, index) => `for (const item${index} of items) { setCount(count + 1); }`,
).join("\n");

async function getReactRule() {
	const loader = new TreeSitterQueryLoader();
	const queries = await loader.loadQueries(process.cwd());
	for (const languageQueries of queries.values()) {
		const rule = languageQueries.find(
			(query) => query.id === "ts-react-antipatterns",
		);
		if (rule) return rule;
	}
	throw new Error("missing ts-react-antipatterns rule");
}

async function countRootChildrenReads<T>(
	run: () => Promise<T>,
	failRootRead = false,
) {
	const { Node } = await loadWebTreeSitter();
	const descriptor = Object.getOwnPropertyDescriptor(
		Node.prototype,
		"children",
	);
	if (!descriptor?.get)
		throw new Error("web-tree-sitter Node.children is not an accessor");
	const originalGet = descriptor.get;
	let reads = 0;
	Object.defineProperty(Node.prototype, "children", {
		...descriptor,
		get: function (this: InstanceType<typeof Node>) {
			if (this.parent == null) {
				reads++;
				if (failRootRead) throw new Error("injected root children failure");
			}
			return originalGet.call(this);
		},
	});
	try {
		return { value: await run(), reads };
	} finally {
		Object.defineProperty(Node.prototype, "children", descriptor);
	}
}

describe("tree-sitter runner — ts-react-antipatterns context gate (#5466)", () => {
	beforeAll(async () => {
		env = makeRealRunnerEnv({ modifiedRanges: [{ start: 1, end: 1 }] });
		await assertGrammarAvailable("typescript");
	});

	it("flags a setCount loop in a module that imports React", async () => {
		expect(await rulesFor("widget.ts", REACT_LOOP_SRC)).toContain(
			"ts-react-antipatterns",
		);
	}, 30_000);

	it("does NOT flag a setFoo loop in a plain module", async () => {
		expect(await rulesFor("util.ts", PLAIN_LOOP_SRC)).not.toContain(
			"ts-react-antipatterns",
		);
	}, 30_000);

	it("walks a large plain file once for many matching loops in the batched caller", async () => {
		const { value, reads } = await countRootChildrenReads(() =>
			rulesFor("many-plain.ts", MULTI_LOOP_SRC),
		);
		expect(value).not.toContain("ts-react-antipatterns");
		expect(reads).toBe(2);
	}, 30_000);

	it("walks a JSX file once and keeps all React-context matches in the batched caller", async () => {
		const src = `const view = <div />;\n${MULTI_LOOP_SRC}`;
		const { value, reads } = await countRootChildrenReads(() =>
			rulesFor("many-jsx.tsx", src),
		);
		expect(value).toContain("ts-react-antipatterns");
		expect(reads).toBe(2);
	}, 30_000);

	it("reuses the context probe across searchFileWithQuery matches", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getReactRule();
		const { ctx, filePath } = env.addFile(
			"many-react.ts",
			`import { useState } from "react";\n${MULTI_LOOP_SRC}`,
		);
		void ctx;
		const { value, reads } = await countRootChildrenReads(() =>
			client.runQueryOnFile(query, filePath, "typescript"),
		);
		expect(value.length).toBe(12);
		expect(reads).toBe(1);
	}, 30_000);

	it("does not carry context from one changed file invocation to the next", async () => {
		expect(
			await rulesFor(
				"context-first.tsx",
				`const view = <div />;\n${MULTI_LOOP_SRC}`,
			),
		).toContain("ts-react-antipatterns");
		expect(await rulesFor("context-next.ts", MULTI_LOOP_SRC)).not.toContain(
			"ts-react-antipatterns",
		);
	}, 30_000);

	it("keeps matches when the real parser's root children accessor fails", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getReactRule();
		const { filePath } = env.addFile(
			"unknown-context.ts",
			`import { useState } from "react";\n${MULTI_LOOP_SRC}`,
		);
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		try {
			const { value, reads } = await countRootChildrenReads(
				() => client.runQueryOnFile(query, filePath, "typescript"),
				true,
			);
			expect(value.length).toBe(12);
			expect(reads).toBe(1);
			await flushTreeSitterLog();
			const { rows, skipped } = readNdjsonRows<
				Pick<TreeSitterLogEntry, "phase" | "reason" | "metadata">
			>(getTreeSitterLogPath());
			expect(skipped).toBe(0);
			expect(
				rows.filter((row) => row.metadata?.postFilter === "has_react_context"),
			).toMatchObject([
				{
					phase: "diagnostic",
					reason: expect.stringContaining("context probe failed"),
				},
			]);
		} finally {
			vi.unstubAllEnvs();
		}
	}, 30_000);
});
