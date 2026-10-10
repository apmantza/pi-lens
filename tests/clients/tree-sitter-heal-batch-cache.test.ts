/**
 * #3834: a clean compile that heals a rule must not leave a cached batch that
 * was built while that rule was charged and skipped.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWebTreeSitter } from "../../clients/deps/web-tree-sitter.js";
import { getDegradationSummary } from "../../clients/degradation-ledger.js";
import {
	TreeSitterClient,
	wasmQueryInput,
} from "../../clients/tree-sitter-client.js";
import type { TreeSitterQuery } from "../../clients/tree-sitter-query-loader.js";

const trap = () => {
	const { WebAssembly } = globalThis as unknown as {
		WebAssembly: { RuntimeError: new (message: string) => Error };
	};
	return new WebAssembly.RuntimeError("table index is out of bounds");
};

const rule: TreeSitterQuery = {
	id: "r1",
	name: "r1",
	severity: "warning",
	category: "test",
	language: "python",
	message: "r1",
	query: "(function_definition) @fn",
	metavars: ["fn"],
	has_fix: false,
	filePath: "",
};

const healthyRule: TreeSitterQuery = {
	...rule,
	id: "healthy",
	name: "healthy",
	query: "(return_statement) @ret",
	message: "healthy",
};

const defs = (client: TreeSitterClient) =>
	client as unknown as {
		compileRawQuery: (
			queryId: string,
			query: string,
			metavars: string[],
			languageId: string,
		) => Promise<unknown>;
		compileQueryBatch: (
			queryDefs: TreeSitterQuery[],
			languageId: string,
			retain?: boolean,
		) => Promise<{
			entries: Array<{ queryDef: TreeSitterQuery }>;
			key: string;
			query: { delete: () => void };
		} | null>;
		loadLanguage: (languageId: string) => Promise<unknown>;
		queryBatchCache: Map<string, unknown>;
		queryBatchInputs: { size: number };
		queryBatchBuilds: Map<string, unknown>;
		getQueryCacheKey: (key: string, languageId: string) => string;
		cacheQueryBatch: (
			key: string,
			value: unknown,
			inputKeys?: string[],
		) => void;
		releaseQueryBatch: (batch: { query: { delete: () => void } }) => void;
		retireQueryBatch: (batch: { query: { delete: () => void } } | null) => void;
		reportWasmAbort: (
			thrown: unknown,
			input?: { languageId: string; source: string },
		) => boolean;
		parseFileAndUse: (...args: unknown[]) => Promise<unknown>;
		wasmInputKey: (input: { languageId: string; source: string }) => string;
		trappedInputs: Map<string, { traps: number; by?: string; source?: string }>;
		clearWasmInput: (input: {
			languageId: string;
			source: string;
			caller?: string;
		}) => void;
	};

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.PI_LENS_TREE_SITTER_QUERY_BATCH_CACHE_CAP;
});

describe("tree-sitter batch cache healing (#3834)", () => {
	it("invalidates a batch that omitted a rule healed by an in-flight raw compile", async () => {
		const client = new TreeSitterClient();
		expect(await client.init()).toBe(true);
		const state = defs(client);
		const realLoad = state.loadLanguage.bind(client);
		const { Query } = await loadWebTreeSitter();
		const realPatternCount = Query.prototype.patternCount;
		let trapProbe = true;
		vi.spyOn(Query.prototype, "patternCount").mockImplementation(function (
			this: InstanceType<typeof Query>,
		) {
			if (trapProbe) {
				trapProbe = false;
				throw trap();
			}
			return realPatternCount.call(this);
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let loads = 0;
		vi.spyOn(state, "loadLanguage").mockImplementation(async (languageId) => {
			loads++;
			if (loads === 1) {
				return {
					get 0(): number {
						throw trap();
					},
				};
			}
			if (loads === 2) {
				await held;
			}
			return realLoad(languageId);
		});

		// One earlier one-off leaves r1 retryable. The second compile passes its
		// check and remains in flight while the batch builds.
		const compileRaw = () =>
			state.compileRawQuery(rule.id, rule.query, rule.metavars ?? [], "python");
		expect(await compileRaw()).toBeNull();
		const pendingRaw = compileRaw();

		// The probe trap charges r1; the following build skips it and caches a
		// batch without r1 while the raw compile is still held.
		expect(
			await state.compileQueryBatch([rule, healthyRule], "python"),
		).not.toBeNull();
		const degraded = await state.compileQueryBatch(
			[rule, healthyRule],
			"python",
		);
		expect(degraded?.entries.map(({ queryDef }) => queryDef.id)).toEqual([
			"healthy",
		]);
		expect(state.queryBatchCache.size).toBe(1);
		expect(state.queryBatchInputs.size).toBe(1);

		release();
		expect(await pendingRaw).not.toBeNull();
		expect(state.queryBatchCache.size).toBe(0);
		expect(state.queryBatchInputs.size).toBe(0);
		const healed = await state.compileQueryBatch([rule, healthyRule], "python");
		expect(healed?.entries.map(({ queryDef }) => queryDef.id)).toEqual([
			"r1",
			"healthy",
		]);
	});

	it("invalidates only batches containing the healed input and bounds their mirrors", async () => {
		const client = new TreeSitterClient();
		expect(await client.init()).toBe(true);
		const state = defs(client);
		const alternateRule = {
			...healthyRule,
			id: "alternate",
			name: "alternate",
		};
		const first = await state.compileQueryBatch([healthyRule], "python");
		const second = await state.compileQueryBatch([alternateRule], "python");
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(state.queryBatchCache.size).toBe(2);
		expect(state.queryBatchInputs.size).toBe(2);

		const firstInput = wasmQueryInput(first!.key);
		state.trappedInputs.set(state.wasmInputKey(firstInput), {
			traps: 1,
			by: undefined,
			source: firstInput.source,
		});
		const firstDelete = vi.spyOn(first!.query, "delete");
		const secondDelete = vi.spyOn(second!.query, "delete");
		state.clearWasmInput(firstInput);

		expect(state.queryBatchCache.size).toBe(1);
		expect(state.queryBatchInputs.size).toBe(1);
		expect(firstDelete).toHaveBeenCalledTimes(1);
		expect(secondDelete).not.toHaveBeenCalled();

		process.env.PI_LENS_TREE_SITTER_QUERY_BATCH_CACHE_CAP = "1";
		await state.compileQueryBatch([alternateRule, healthyRule], "python");
		expect(state.queryBatchCache.size).toBe(1);
		expect(state.queryBatchInputs.size).toBe(1);
	});

	it("defers native disposal until an in-flight batch consumer releases it", async () => {
		const client = new TreeSitterClient();
		expect(await client.init()).toBe(true);
		const state = defs(client);
		const content = "def f():\n    return 1\n";
		const filePath = "tree-sitter-heal-batch.py";
		const initial = await client.runQueriesOnFile(
			[healthyRule],
			filePath,
			"python",
			{},
			content,
		);
		expect(initial.map(({ queryDef }) => queryDef.id)).toEqual(["healthy"]);

		const cache = client as unknown as {
			queryBatchCache: Map<
				string,
				{
					key: string;
					query: { delete: () => void };
				}
			>;
		};
		const batch = [...cache.queryBatchCache.values()][0];
		expect(batch).toBeDefined();
		const deleteQuery = vi.spyOn(batch.query, "delete");
		const batchInput = wasmQueryInput(batch.key);
		state.trappedInputs.set(state.wasmInputKey(batchInput), {
			traps: 1,
			by: undefined,
			source: batchInput.source,
		});

		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const parse = state.parseFileAndUse.bind(client);
		vi.spyOn(state, "parseFileAndUse").mockImplementation(async (...args) => {
			await held;
			return parse(...args);
		});
		const pending = client.runQueriesOnFile(
			[healthyRule],
			filePath,
			"python",
			{},
			content,
		);
		await Promise.resolve();
		const trapsBefore =
			getDegradationSummary().find((group) => group.kind === "wasm-trap")
				?.count ?? 0;
		state.clearWasmInput(batchInput);
		expect(deleteQuery).not.toHaveBeenCalled();
		expect(
			getDegradationSummary().find(
				(group) => group.kind === "wasm-query-batch-disposal-deferred",
			)?.count,
		).toBe(1);
		expect(
			getDegradationSummary().find((group) => group.kind === "wasm-trap")
				?.count,
		).toBe(trapsBefore);

		release();
		expect((await pending).map(({ queryDef }) => queryDef.id)).toEqual([
			"healthy",
		]);
		expect(deleteQuery).toHaveBeenCalledTimes(1);
	});

	it("releases a retired batch in finally when the consumer throws", async () => {
		const client = new TreeSitterClient();
		expect(await client.init()).toBe(true);
		const state = defs(client);
		const filePath = "tree-sitter-heal-batch-error.py";
		await client.runQueriesOnFile(
			[healthyRule],
			filePath,
			"python",
			{},
			"def f():\n    return 1\n",
		);
		const batch = [...state.queryBatchCache.values()][0] as {
			key: string;
			query: { delete: () => void };
		};
		const deleteQuery = vi.spyOn(batch.query, "delete");
		const batchInput = wasmQueryInput(batch.key);
		state.trappedInputs.set(state.wasmInputKey(batchInput), {
			traps: 1,
			by: undefined,
			source: batchInput.source,
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(state, "parseFileAndUse").mockImplementation(async () => {
			await held;
			throw new Error("consumer failed");
		});
		const pending = client.runQueriesOnFile(
			[healthyRule],
			filePath,
			"python",
			{},
			"def f():\n    return 1\n",
		);
		await Promise.resolve();
		state.clearWasmInput(batchInput);
		release();
		await expect(pending).rejects.toThrow("consumer failed");
		expect(deleteQuery).toHaveBeenCalledTimes(1);
	});

	it("retains a cache hit before a heal can retire it (#4207 F6)", async () => {
		const client = new TreeSitterClient();
		expect(await client.init()).toBe(true);
		const state = defs(client);
		const filePath = "tree-sitter-heal-cache-hit.py";
		const content = "def f():\n    return 1\n";
		const first = await client.runQueriesOnFile(
			[healthyRule],
			filePath,
			"python",
			{},
			content,
		);
		const batch = [...state.queryBatchCache.values()][0] as {
			key: string;
			query: { delete: () => void };
		};
		const deleteQuery = vi.spyOn(batch.query, "delete");
		const batchInput = wasmQueryInput(batch.key);
		state.trappedInputs.set(state.wasmInputKey(batchInput), {
			traps: 1,
			by: undefined,
			source: batchInput.source,
		});
		// The heal is queued after the cache-hit lookup but before its caller's
		// continuation. This prevents #4207 F6: disposing the native query under
		// the scan because retainQueryBatch ran too late.
		queueMicrotask(() => state.clearWasmInput(batchInput));
		const second = await client.runQueriesOnFile(
			[healthyRule],
			filePath,
			"python",
			{},
			content,
		);
		expect(first.map(({ queryDef }) => queryDef.id)).toEqual(["healthy"]);
		expect(second.map(({ queryDef }) => queryDef.id)).toEqual(["healthy"]);
		expect(deleteQuery).toHaveBeenCalledTimes(1);
	});

	it("does not cache a batch after its build heals an input (#4207 F7)", async () => {
		const client = new TreeSitterClient();
		expect(await client.init()).toBe(true);
		const state = defs(client);
		const probeKey = state.getQueryCacheKey(
			`raw:${rule.id}:${rule.query}`,
			"python",
		);
		const probeInput = wasmQueryInput(probeKey);
		state.trappedInputs.set(state.wasmInputKey(probeInput), {
			traps: 1,
			by: undefined,
			source: probeInput.source,
		});
		const { Query } = await loadWebTreeSitter();
		const realPatternCount = Query.prototype.patternCount;
		let queuedHeal = false;
		vi.spyOn(Query.prototype, "patternCount").mockImplementation(function (
			this: InstanceType<typeof Query>,
		) {
			if (!queuedHeal) {
				queuedHeal = true;
				// This continuation lands after the synchronous build and before
				// its cache-publication continuation (#4207 F7).
				queueMicrotask(() => {
					state.trappedInputs.set(state.wasmInputKey(probeInput), {
						traps: 1,
						by: undefined,
						source: probeInput.source,
					});
					state.clearWasmInput(probeInput);
				});
			}
			return realPatternCount.call(this);
		});
		const built = await state.compileQueryBatch([rule, healthyRule], "python");
		expect(built?.entries.map(({ queryDef }) => queryDef.id)).toEqual([
			"r1",
			"healthy",
		]);
		// clearWasmInput ran during the synchronous build, before its final await;
		// the healed build must not become the process-wide cached answer.
		expect(state.queryBatchCache.size).toBe(0);
	});

	it("coalesces concurrent cold builds at the batch seam (#4207 F8)", async () => {
		const client = new TreeSitterClient();
		expect(await client.init()).toBe(true);
		const state = defs(client);
		const realLoad = state.loadLanguage.bind(client);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(state, "loadLanguage").mockImplementation(async (languageId) => {
			await held;
			return realLoad(languageId);
		});
		const first = state.compileQueryBatch([healthyRule], "python");
		const second = state.compileQueryBatch([healthyRule], "python");
		await Promise.resolve();
		expect(state.queryBatchBuilds.size).toBe(1);
		release();
		const [firstBatch, secondBatch] = await Promise.all([first, second]);
		expect(firstBatch).toBe(secondBatch);
	});

	it("retires the evicted batch", async () => {
		const client = new TreeSitterClient();
		expect(await client.init()).toBe(true);
		const state = defs(client);
		process.env.PI_LENS_TREE_SITTER_QUERY_BATCH_CACHE_CAP = "1";
		const first = await state.compileQueryBatch([healthyRule], "python");
		const alternateRule = { ...healthyRule, id: "evicted", name: "evicted" };
		const deleteQuery = vi.spyOn(first!.query, "delete");
		await state.compileQueryBatch([alternateRule], "python");
		expect(deleteQuery).toHaveBeenCalledTimes(1);
	});

	it("does not retain full file text in a trap record", async () => {
		const client = new TreeSitterClient();
		expect(await client.init()).toBe(true);
		const state = defs(client);
		const fileInput = { languageId: "python", source: "secret file text" };
		client.reportWasmAbort(trap(), fileInput);
		const entry = [...state.trappedInputs.values()][0];
		expect(entry.source).toBeUndefined();
	});

	it("leases every coalesced consumer at publication, before a heal can dispose (#4207 F9)", async () => {
		const client = new TreeSitterClient();
		expect(await client.init()).toBe(true);
		const state = defs(client);
		const filePath = "tree-sitter-heal-coalesced.py";
		const content = "def f():\n    return 1\n";
		const probeKey = state.getQueryCacheKey(
			`raw:${rule.id}:${rule.query}`,
			"python",
		);
		const probeInput = wasmQueryInput(probeKey);
		// r1 is charged, so the build skips it and caches a batch holding only
		// `healthy`; healing r1's entry invalidates exactly that batch.
		state.trappedInputs.set(state.wasmInputKey(probeInput), {
			traps: 2,
			by: undefined,
			source: probeInput.source,
		});
		const { Query } = await loadWebTreeSitter();
		const realPatternCount = Query.prototype.patternCount;
		let queued = false;
		let cachedAtHeal = -1;
		let deletedAtHeal = -1;
		let deleteQuery: ReturnType<typeof vi.spyOn> | undefined;
		vi.spyOn(Query.prototype, "patternCount").mockImplementation(function (
			this: InstanceType<typeof Query>,
		) {
			if (!queued) {
				queued = true;
				// Another actor's two-hop continuation. The first hop runs before
				// the build's publication section, so the second lands after the
				// batch is cached and before the coalesced consumers resume: the
				// window where #4207 F9 disposed the native Query under three
				// scans that then silently reported zero findings.
				queueMicrotask(() =>
					queueMicrotask(() => {
						const cached = [...state.queryBatchCache.values()];
						cachedAtHeal = cached.length;
						const batch = cached[0] as
							| { query: { delete: () => void } }
							| undefined;
						if (batch) deleteQuery = vi.spyOn(batch.query, "delete");
						client.clearWasmInput(probeInput);
						deletedAtHeal = deleteQuery?.mock.calls.length ?? -1;
					}),
				);
			}
			return realPatternCount.call(this);
		});
		const results = await Promise.all(
			[0, 1, 2].map(() =>
				client.runQueriesOnFile(
					[rule, healthyRule],
					filePath,
					"python",
					{},
					content,
				),
			),
		);
		// The interleaving this test needs, pinned so a scheduler change reds
		// instead of passing vacuously: the heal lands after publication.
		expect(cachedAtHeal).toBe(1);
		// Publication already carries all three leases, so the heal retires the
		// batch and defers disposal instead of deleting it under the scans.
		expect(deletedAtHeal).toBe(0);
		expect(results.map((matches) => matches.length)).toEqual([1, 1, 1]);
		expect(deleteQuery).toBeDefined();
		expect(deleteQuery).toHaveBeenCalledTimes(1);
	});

	it("disposes an epoch-skipped build once its coalesced consumers release it (#4207 F10)", async () => {
		const client = new TreeSitterClient();
		expect(await client.init()).toBe(true);
		const state = defs(client);
		const probeKey = state.getQueryCacheKey(
			`raw:${rule.id}:${rule.query}`,
			"python",
		);
		const probeInput = wasmQueryInput(probeKey);
		state.trappedInputs.set(state.wasmInputKey(probeInput), {
			traps: 1,
			by: undefined,
			source: probeInput.source,
		});
		const realLoad = state.loadLanguage.bind(client);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let heldOnce = false;
		vi.spyOn(state, "loadLanguage").mockImplementation(
			async (languageId: string) => {
				if (!heldOnce) {
					heldOnce = true;
					await held;
				}
				return realLoad(languageId);
			},
		);
		const owner = state.compileQueryBatch([rule, healthyRule], "python", true);
		const waiter = state.compileQueryBatch([rule, healthyRule], "python", true);
		// An external heal while the build is in flight moves the epoch, so the
		// build refuses publication and no cache entry ever owns this batch.
		client.clearWasmInput(probeInput);
		release();
		const [ownerBatch, waiterBatch] = await Promise.all([owner, waiter]);
		expect(ownerBatch).not.toBeNull();
		expect(ownerBatch).toBe(waiterBatch);
		expect(state.queryBatchCache.size).toBe(0);
		const deleteQuery = vi.spyOn(ownerBatch!.query, "delete");
		// The waiter counted its lease when it joined, so one release is not the
		// last one: the native Query survives it (#4207 F11).
		state.releaseQueryBatch(ownerBatch!);
		expect(deleteQuery).not.toHaveBeenCalled();
		state.releaseQueryBatch(waiterBatch!);
		expect(deleteQuery).toHaveBeenCalledTimes(1);
	});

	it("leases a caller that joins after the build decided (#4207 F9)", async () => {
		const client = new TreeSitterClient();
		expect(await client.init()).toBe(true);
		const state = defs(client);
		const probeKey = state.getQueryCacheKey(
			`raw:${rule.id}:${rule.query}`,
			"python",
		);
		const probeInput = wasmQueryInput(probeKey);
		state.trappedInputs.set(state.wasmInputKey(probeInput), {
			traps: 1,
			by: undefined,
			source: probeInput.source,
		});
		const realLoad = state.loadLanguage.bind(client);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let heldOnce = false;
		vi.spyOn(state, "loadLanguage").mockImplementation(
			async (languageId: string) => {
				if (!heldOnce) {
					heldOnce = true;
					await held;
				}
				return realLoad(languageId);
			},
		);
		// The build record stays registered until the owner's own continuation
		// runs, one microtask after the decision section. A caller that enters
		// in between joins a build that has already decided: its lease goes onto
		// the decided batch, because the join counter is drained. Counting it
		// there instead would release against another consumer's lease and
		// dispose the native Query early (state-table row 9).
		let lateJoin!: Promise<{ query: { delete: () => void } } | null>;
		const realRetire = state.retireQueryBatch.bind(client);
		state.retireQueryBatch = (batch) => {
			realRetire(batch);
			queueMicrotask(() => {
				lateJoin = state.compileQueryBatch([rule, healthyRule], "python", true);
			});
		};
		const owner = state.compileQueryBatch([rule, healthyRule], "python", true);
		const waiter = state.compileQueryBatch([rule, healthyRule], "python", true);
		client.clearWasmInput(probeInput);
		release();
		const [ownerBatch, waiterBatch] = await Promise.all([owner, waiter]);
		const lateBatch = await lateJoin;
		expect(ownerBatch).not.toBeNull();
		expect(waiterBatch).toBe(ownerBatch);
		// The late caller joined the registered build instead of starting one.
		expect(lateBatch).toBe(ownerBatch);
		const deleteQuery = vi.spyOn(ownerBatch!.query, "delete");
		state.releaseQueryBatch(ownerBatch!);
		expect(deleteQuery).not.toHaveBeenCalled();
		state.releaseQueryBatch(waiterBatch!);
		expect(deleteQuery).not.toHaveBeenCalled();
		state.releaseQueryBatch(lateBatch!);
		expect(deleteQuery).toHaveBeenCalledTimes(1);
	});

	it("records the deferred disposal of a trapped build it refuses to publish (#4207 F10)", async () => {
		const client = new TreeSitterClient();
		expect(await client.init()).toBe(true);
		const state = defs(client);
		const deferred = () =>
			getDegradationSummary().find(
				(group) => group.kind === "wasm-query-batch-disposal-deferred",
			)?.count ?? 0;
		const { Query } = await loadWebTreeSitter();
		const realPatternCount = Query.prototype.patternCount;
		let trappedOnce = false;
		vi.spyOn(Query.prototype, "patternCount").mockImplementation(function (
			this: InstanceType<typeof Query>,
		) {
			if (!trappedOnce) {
				trappedOnce = true;
				throw trap();
			}
			return realPatternCount.call(this);
		});
		const before = deferred();
		const results = await client.runQueriesOnFile(
			[rule, healthyRule],
			"tree-sitter-heal-trapped.py",
			"python",
			{},
			"def f():\n    return 1\n",
		);
		// A trapped build is degraded, so it is not published; its consumer's
		// release must still free the native Query it was handed.
		expect(results.map(({ queryDef }) => queryDef.id)).toEqual(["healthy"]);
		expect(state.queryBatchCache.size).toBe(0);
		expect(deferred() - before).toBe(1);
	});
});
