# Graph and code-understanding inspiration for pi-lens

**Date:** 2026-08-02
**Scope:** Source-oriented review of four public repositories, followed by a comparison with the existing pi-lens review graph, Tree-sitter extraction, word index, report tools, snapshot lifecycle, and MCP seam. This is a research document, not an endorsement of any upstream implementation.

I inspected repository maps, manifests, architecture/design documentation, agent skills and CLI references, core extraction/resolution/query code, persistence and watch/update code, representative tests, examples, and security material. Claims marked **Observed** are supported by the cited upstream source. Claims marked **Recommendation** are judgments for pi-lens. A README benchmark or product statement is not treated as an implementation fact unless the source or tests support it. “Graph” is used carefully: Graphify and Code-Graph-RAG combine source graphs with documents or workflow/agent surfaces, while codegraph and Compass are primarily structural code/project graphs.

## Sources consulted

The primary sources are listed here so later readers can reproduce the review:

- [Code-Graph-RAG README](https://github.com/vitali87/code-graph-rag/blob/main/README.md), [`pyproject.toml`](https://github.com/vitali87/code-graph-rag/blob/main/pyproject.toml), [architecture overview](https://github.com/vitali87/code-graph-rag/blob/main/docs/architecture/overview.md), [graph schema](https://github.com/vitali87/code-graph-rag/blob/main/docs/architecture/graph-schema.md), [language support](https://github.com/vitali87/code-graph-rag/blob/main/docs/architecture/language-support.md), [CLI reference](https://github.com/vitali87/code-graph-rag/blob/main/docs/guide/cli-reference.md), [real-time updates](https://github.com/vitali87/code-graph-rag/blob/main/docs/guide/realtime-updates.md), [`codebase_rag/graph_updater.py`](https://github.com/vitali87/code-graph-rag/blob/main/codebase_rag/graph_updater.py), [`models.py`](https://github.com/vitali87/code-graph-rag/blob/main/codebase_rag/models.py), [`tools/code_retrieval.py`](https://github.com/vitali87/code-graph-rag/blob/main/codebase_rag/tools/code_retrieval.py), [`tools/semantic_search.py`](https://github.com/vitali87/code-graph-rag/blob/main/codebase_rag/tools/semantic_search.py), [`mcp/tools.py`](https://github.com/vitali87/code-graph-rag/blob/main/codebase_rag/mcp/tools.py), and incremental/cross-project tests [1](https://github.com/vitali87/code-graph-rag/blob/main/codebase_rag/tests/integration/test_incremental_external_prune_e2e.py) [2](https://github.com/vitali87/code-graph-rag/blob/main/codebase_rag/tests/integration/test_cross_project_retrieval_e2e.py).
- [SylphAI codegraph README](https://github.com/SylphAI-Inc/skills/blob/main/skills/codegraph/README.md), [agent `SKILL.md`](https://github.com/SylphAI-Inc/skills/blob/main/skills/codegraph/SKILL.md), [`scripts/scan.py`](https://github.com/SylphAI-Inc/skills/blob/main/skills/codegraph/scripts/scan.py), [`scripts/overview.py`](https://github.com/SylphAI-Inc/skills/blob/main/skills/codegraph/scripts/overview.py), [`scripts/render.py`](https://github.com/SylphAI-Inc/skills/blob/main/skills/codegraph/scripts/render.py), [`scripts/viewer.html`](https://github.com/SylphAI-Inc/skills/blob/main/skills/codegraph/scripts/viewer.html), and [`scripts/test_codegraph.py`](https://github.com/SylphAI-Inc/skills/blob/main/skills/codegraph/scripts/test_codegraph.py).
- [Compass README](https://github.com/crabbuild/compass/blob/main/README.md), [`Cargo.toml`](https://github.com/crabbuild/compass/blob/main/Cargo.toml), [How Compass works](https://github.com/crabbuild/compass/blob/main/docs/concepts/how-it-works.md), [graph model](https://github.com/crabbuild/compass/blob/main/docs/concepts/graph-model.md), [extraction pipeline](https://github.com/crabbuild/compass/blob/main/docs/implementation/extraction-pipeline.md), [CompassQL](https://github.com/crabbuild/compass/blob/main/docs/COMPASSQL.md), agent [`SKILL.md`](https://github.com/crabbuild/compass/blob/main/crates/compass-cli/assets/compass-skill/SKILL.md), [query reference](https://github.com/crabbuild/compass/blob/main/crates/compass-cli/assets/compass-skill/references/query.md), [`compass-model/src/graph.rs`](https://github.com/crabbuild/compass/blob/main/crates/compass-model/src/graph.rs), [`query_index.rs`](https://github.com/crabbuild/compass/blob/main/crates/compass-model/src/query_index.rs), [`compass-files/src/manifest.rs`](https://github.com/crabbuild/compass/blob/main/crates/compass-files/src/manifest.rs), and [`compass-core/src/watch.rs`](https://github.com/crabbuild/compass/blob/main/crates/compass-core/src/watch.rs).
- [Graphify README](https://github.com/Graphify-Labs/graphify/blob/v8/README.md), [`ARCHITECTURE.md`](https://github.com/Graphify-Labs/graphify/blob/v8/ARCHITECTURE.md), [`pyproject.toml`](https://github.com/Graphify-Labs/graphify/blob/v8/pyproject.toml), [`graphify/extract.py`](https://github.com/Graphify-Labs/graphify/blob/v8/graphify/extract.py), [`build.py`](https://github.com/Graphify-Labs/graphify/blob/v8/graphify/build.py), [`cache.py`](https://github.com/Graphify-Labs/graphify/blob/v8/graphify/cache.py), [`watch.py`](https://github.com/Graphify-Labs/graphify/blob/v8/graphify/watch.py), [`symbol_resolution.py`](https://github.com/Graphify-Labs/graphify/blob/v8/graphify/symbol_resolution.py), [`resolver_registry.py`](https://github.com/Graphify-Labs/graphify/blob/v8/graphify/resolver_registry.py), [`analyze.py`](https://github.com/Graphify-Labs/graphify/blob/v8/graphify/analyze.py), [`skill-pi.md`](https://github.com/Graphify-Labs/graphify/blob/v8/graphify/skill-pi.md), [`serve.py`](https://github.com/Graphify-Labs/graphify/blob/v8/graphify/serve.py), [`security.py`](https://github.com/Graphify-Labs/graphify/blob/v8/graphify/security.py), and representative tests [incremental](https://github.com/Graphify-Labs/graphify/blob/v8/tests/test_incremental.py), [query CLI](https://github.com/Graphify-Labs/graphify/blob/v8/tests/test_query_cli.py), [security](https://github.com/Graphify-Labs/graphify/blob/v8/tests/test_security.py), and [benchmark](https://github.com/Graphify-Labs/graphify/blob/v8/tests/test_benchmark.py).

## Executive summary

The strongest shared lesson is not “add a graph.” It is **separate authoritative structure from interpretation and presentation, then make uncertainty and freshness visible**. Compass is the most disciplined reference for this: immutable graph snapshots, explicit `EXTRACTED`/`INFERRED`/`AMBIGUOUS` provenance, bounded queries, quarantine of invalid records, and atomic publication. SylphAI’s codegraph is the best reference for agent ergonomics: a compact digest, progressive disclosure, importance-ranked files, guided reading tours, and a self-contained offline artifact. Graphify shows how to make a graph a practical agent workflow with `query`, `path`, `explain`, `affected`, hooks, and MCP, but its broad graph includes documents and model-generated concepts and therefore cannot be treated as a pure code-graph precedent. Code-Graph-RAG has the richest language-specific semantic ambition—Memgraph, multi-pass resolution, data-flow edges, AST editing, and optional embeddings—but also the heaviest operational and provider surface.

pi-lens already has the core ingredients these projects repeatedly rediscover: a shared TreeSitterClient and extractor; an immutable-by-replacement review graph with file/symbol/edge indexes; sequence-aware and content-hash-aware incremental paths; a persisted graph with explicit partial coverage; reverse dependencies; a bounded BM25 word index; `project_report`, `module_report`, `read_symbol`, and `read_enclosing`; and a host-neutral `lens-engine`/MCP seam. The real opportunity is not parallel storage or a second parser. It is to improve **evidence-aware context packing and reading order over those existing seams**.

### Concise comparison matrix

| Project | Primary artifact | Structural truth | Retrieval/agent surface | Update/persistence | Main caution |
| --- | --- | --- | --- | --- | --- |
| Code-Graph-RAG | Memgraph graph plus CLI/MCP | Tree-sitter, multi-pass language handlers, resolved calls/imports, optional flows/findings | Natural language to Cypher, snippet retrieval, semantic search, AST edit/optimization tools | Hash/parser caches, incremental graph updater, file watcher; calls are recalculated broadly | Memgraph/Docker and optional Qdrant/ML/provider dependencies make it operationally large |
| SylphAI codegraph | `graph.json` + `digest.md` + one offline HTML | Stdlib regex extraction; imports reliable, calls unique-name heuristics | Agent writes `enrich.json`; tours and copied “ask” prompts; three visual views | Re-scan preserves enrichment by stable IDs; no live incremental graph | Calls/layers are explicitly approximate; semantic meaning is manual enrichment |
| Compass | `compass-out/graph.json`, report, manifest, optional history | Native Rust/tree-sitter extraction plus resolvers, typed evidence/provenance | Bounded natural query, `search`, `callers`, `path`, `affected`, CompassQL, MCP/skill | Hash manifest, atomic generation, watch/reconciliation, immutable Git realizations | Broad product scope and a large native dependency/build surface |
| Graphify | NetworkX-derived `graph.json`, report, HTML, optional exports | Tree-sitter code graph plus semantic document/media graph; confidence labels | `/graphify`, query/path/explain, hooks, MCP, optional semantic extraction | Per-file AST/semantic caches, tier-aware merge, watch reconciliation | Generic document/semantic edges and optional LLM output must not be confused with verified code edges |

## 1. Code-Graph-RAG

### Purpose and architecture

**Observed:** Code-Graph-RAG is a multi-language codebase assistant. Its documented pipeline is Tree-sitter parser → AST analysis → Memgraph, followed by an interactive RAG CLI that generates Cypher, retrieves source, and drives editing/optimization. The schema is unusually expressive: Project/Package/Folder/File/Module, Class/Function/Method and type nodes, external modules, resources, findings, and relationship families including `DEFINES`, `IMPORTS`, `EXPORTS`, `INHERITS`, `CALLS`, `REFERENCES`, `INSTANTIATES`, `READS_FROM`, `WRITES_TO`, and opt-in `FLOWS_TO`. Resource/data-flow edges are conservatively intra-procedural with limited caller/callee handoff, not general whole-program taint proof.

`graph_updater.py` implements multiple passes: structure, optional C/C++ libclang/hybrid and C# Roslyn frontends, per-file extraction, deferred parent/import/call resolution, endpoint and finding passes, pruning, then optional embeddings. The language table and package extras cover a wide set of languages. The graph model in `models.py` is deliberately generic (`GraphNode` labels/properties and `GraphRelationship` source/target/type/properties), while language-specific handlers carry the difficult resolution logic.

### Interfaces, retrieval, and agent behavior

**Observed:** `cgr start --update-graph`, `export`, `optimize`, `watch`, and language grammar commands are the principal CLI surfaces. Natural-language questions are converted into Cypher by an LLM/provider path; exact source retrieval is separate and uses qualified name plus recorded line range. `CodeRetriever` gives the recorded absolute path precedence, checks project roots, and returns a bounded source slice with location/docstring. Optional semantic search embeds a query, searches Qdrant or another configured vector backend, then resolves node IDs back through the graph and source locations. The MCP registry exposes graph query, retrieval, semantic/structural search, read/write/edit, directory, shell, and agent tools.

This is a useful separation between **graph selection** and **source reading**: a graph answer is not itself a source body. It also validates cross-project retrieval: the integration test indexes two repositories and proves a retriever rooted in one can retrieve a symbol from the other using stored absolute paths.

### Incremental and scale evidence

**Observed:** The updater maintains per-file hashes, directory mtimes, parser fingerprints, a bounded AST cache, a function registry, and rehydrated definitions for unchanged files. The graph updater test suite includes orphaned external-module pruning and the implementation checks that a shared graph still contains the project before trusting a local sync cache. The realtime watcher debounces saves but explicitly recalculates all `CALLS` relationships for each processed change; its own documentation calls this a correctness choice that can hurt large, frequently edited repositories. That is an important negative lesson: local file reparse and global relationship repair are different costs.

### Strongest ideas and limitations

**Recommendation for inspiration:** borrow the distinction between local extraction facts, deferred resolution facts, and optional high-value edge families. A pi-lens “evidence tier” could expose why an edge is present without pretending to be a compiler. The source-retrieval contract—stable identity, path validation, line range, and failure when the source is missing—is also aligned with `read_symbol`/`read_enclosing`.

**Observed limitation:** the dependency stack includes Python 3.12+, Memgraph client/Docker, many grammar packages, optional Qdrant/Torch/Transformers, and provider integrations. This is not a fit for pi-lens’s lightweight, host-extension, install-safe hot path. Its Cypher generation also places a model/provider in query planning; that is unsuitable as an authoritative answer path unless every result is bounded and source-verified.

## 2. SylphAI `skills/codegraph`

### Purpose and architecture

**Observed:** This is an agent skill, not a daemon or graph database. It has a strict three-stage contract:

1. `scan.py` deterministically produces `graph.json` and a compact `digest.md`.
2. The agent reads the digest and writes only `enrich.json` with summaries, layer corrections, and 3–6-step tours.
3. `render.py` validates and atomically emits one self-contained offline HTML artifact; `overview.py` derives the coarse architecture view.

`scan.py` is standard-library-only, uses Git’s tracked/untracked-with-ignore listing when available, caps files and per-file size, avoids minified files, extracts docstrings/comments, uses hand-written import resolution, computes PageRank plus fan-in and size, detects cycles, and extracts symbols only for the most important files. Its cross-file calls are intentionally constrained to unique non-stopword names. The actual graph schema has typed IDs (`mod:`, `file:`, `sym:`, `ext:`), containment/import/call/inheritance/dependency edges, line ranges, importance, layers, entry status, and summaries.

### Agent-facing commands and context packing

**Observed:** The skill tells an agent to read `digest.md`, not a potentially megabyte-sized `graph.json`, and to summarize the top 30–60 ranked files first. It requires IDs to be copied verbatim and drops unknown enrichment IDs with warnings. Tours encode reading order, something a dependency graph does not supply. Each rendered node can copy a complete prompt containing path, summary, LOC, fan-in/fan-out, symbols, and both edge directions—an offline context handoff rather than an embedded chat client.

The viewer has overview, orbitable starmap, and expandable folder→file→symbol views. It hides tests, folds hub edges, disables calls by default, supports neighborhood focus, and caps animated packets. `render.py` validates duplicate IDs and dangling edges before an atomic same-directory replacement. The tests assert deterministic graphs, real module/path references, cycle detection, docstring provenance, enrichment behavior, tour validation, geometry, and declutter controls.

### Limitations and pi-lens fit

**Observed limitation:** the skill states plainly that extraction is regex-based, imports are trustworthy, calls are hints, dynamic imports/DI/reflection/runtime registration are invisible, layers are path heuristics, and generated/minified/lock files are excluded. Its reported speed and 60fps claims are demonstrations, not a general guarantee. It has no durable graph freshness protocol beyond re-running scan/render.

**Recommendation:** adopt the *shape* of digest-plus-progressive-disclosure, not its parser. `project_report` already gives ranked hubs, entry points, subsystems, risk, dead-weight caveats, and trust/provenance; `module_report` already gives summaries, callbacks, imports, used-by, recommended reads, compact output, and blast radius. The gap is a deterministic, bounded reading tour or context pack over these existing reports. Use TreeSitter ranges and the word index; do not add a `digest` database or regex extractor.

## 3. Compass

### Purpose, model, and pipeline

**Observed:** Compass is a native Rust, local-first knowledge graph for source code and project artifacts. The README says structural extraction and queries need no Python, embeddings, vector database, model credentials, or runtime parser downloads. The workspace manifest shows a large but deliberately native product: Tree-sitter language pack, SQLite/Prolly history storage, query engine, MCP, exports, optional semantic/media/integration crates, and strict Rust lints.

Its documented pipeline is discover → extract → resolve → analyze → publish → query. `compass-model/src/graph.rs` loads a directed graph, preserves insertion order and multigraph semantics, builds incoming/outgoing adjacency and query indexes, and can create minimal endpoint nodes during loading. `query_index.rs` indexes labels, display labels, source files, edge types, typed adjacency, and a schema fingerprint. The graph model treats IDs as opaque stable strings, retains open-ended node/edge attributes, and keeps parallel edges distinct.

The most valuable model detail is provenance: `EXTRACTED`, `INFERRED`, or `AMBIGUOUS`, with source locations and an explicit warning that inferred or extracted does not equal runtime truth. Invalid records are quarantined, partial publication carries omission diagnostics and `incomplete_coverage`, and document-level or empty-graph failures preserve the last good generation.

### Incremental, history, and scale bounds

**Observed:** The manifest tracks mtime plus AST and semantic hashes. It distinguishes unchanged, changed, new, renamed/deleted/excluded files, and only reuses extraction when content, cache format, parser/extractor configuration, and relevant project-wide inputs are compatible. The extraction-pipeline documentation requires cold/warm/change/rename/delete equivalence testing. Watch mode debounces events, supports native or polling backends, filters scope, retries failures, and performs periodic reconciliation. Atomic publication advances graph and manifest together. Exact Git history is represented as immutable realizations with a commit/profile/extraction fingerprint, not as mutable “current” data.

Queries are explicitly bounded by row, path, expansion, memory, response, and deadline limits. CompassQL is a deterministic read-only openCypher subset with parameter files and table/JSON/JSONL outputs. The source query engine uses SQLite full-text ranking and typed response limits, while the graph indexes support exact adjacency operations.

### Agent and integration surface

**Observed:** The Compass skill routes architecture to `query` then `explain`, impact to `affected`, exact automation to `query --cql`, source relationships to `path`/`callers`/`callees`, and revision questions to history/diff. It says to use the graph to select a small source set and verify decisive facts in source. `--budget` bounds rendered context, not graph truth. The skill includes on-demand references for commands, query, update, semantic extraction, history, hooks, exports, MCP, security, and operations.

### Strongest ideas, limitations, and fit

**Recommendation:** Compass is the clearest inspiration for pi-lens’s honesty contract: every graph-backed report should expose completeness, provenance, current-vs-historical state, direction, and bounds. Its immutable snapshot/atomic generation discipline closely validates pi-lens’s existing replacement-based graph and worker persistence design. Its query index also supports investing in task-specific indexes rather than one generic “graph search.”

**Observed limitation:** Compass’s native binary and extensive workspace are much larger than pi-lens needs. Its semantic and integration capabilities are optional but broaden the trust boundary. Its communities are useful hypotheses, not stable architecture labels; its own docs say IDs and clusters must not be treated as business truth. Pi-lens should adapt contracts and tests, not import CompassQL, Prolly storage, or a second native graph runtime.

## 4. Graphify

### Purpose and graph boundaries

**Observed:** Graphify is both a Python library and an agent skill. Its pipeline is `detect → extract → build_graph → cluster → analyze → report → export`, communicating through dicts and NetworkX. The graph can contain code, Markdown/docs, SQL schemas, configs, PDFs/images/media, rationale nodes, and model-generated concepts. That makes it a **general knowledge/workflow graph**, not only a source-code graph. Code extraction is local Tree-sitter; semantic document/media extraction may call the assistant or a configured provider.

The common extraction contract is nodes with `id`, `label`, `source_file`, `source_location` and edges with source/target/relation/confidence. `EXTRACTED`, `INFERRED`, and `AMBIGUOUS` are persisted. `ids.py` centralizes Unicode/path-independent ID normalization because AST and semantic producers otherwise create ghost nodes. `symbol_resolution.py` and `resolver_registry.py` provide conservative cross-file resolution and language-specific passes; the resolver defers receiver/member calls rather than binding every same-named method.

### Queries, skills, and context

**Observed:** The `/graphify` skill uses `query` for bounded BFS/DFS context, `path` for shortest known connection, `explain` for a node, and `affected` for incoming impact. It has a fast path that reuses an existing graph, a token budget, source-location citations, and an explicit rule not to invent edges. A hook can softly nudge an agent to query first; opt-in strict mode blocks at most the first raw read per session and then allows it. The MCP server supports stdio by default and optional HTTP, with bounded graph contexts/LRU behavior and optional API-key protection. These are workflow controls, not graph facts.

### Freshness, semantic cache, and security

**Observed:** `cache.py` stores per-file AST and semantic results keyed by content, with semantic prompt fingerprints to prevent replaying old extraction instructions. Semantic chunks checkpoint incrementally, preserve partial markers, and constrain model output to dispatched files. `build.py` replaces the changed file’s contribution and uses tier-aware AST versus semantic ownership; `watch.py` debounces code changes, rebuilds code locally, flags non-code changes for semantic re-extraction, distinguishes deleted from newly excluded files, and atomically replaces accepted graph output. Tests cover stale import pruning, direction preservation, oversized graph rejection, query context filtering, and benchmark subgraph token counts.

`security.py` is a strong boundary: HTTP(S)-only URLs, DNS/private-IP/metadata protection and redirect revalidation, fetch size/time limits, graph path confinement, graph file size caps before JSON parsing, control-character/length-limited labels, and no source execution. The README’s privacy section is more nuanced than “local”: code-only is local, but docs/PDFs/images can leave the machine according to selected provider; query logging is opt-in in the current source despite older/common descriptions of logging.

### Limitations and fit

**Observed limitation:** NetworkX and plain JSON are approachable but can duplicate memory and do not themselves provide query indexes or immutable generations. The generic semantic graph can introduce relationships that are not compiler-backed. Hook strictness can also redirect agent behavior without proving a graph is complete. Provider selection, media extras, HTTP serving, and many platform skills enlarge installation and privacy complexity.

**Recommendation:** borrow Graphify’s provenance-aware IDs, source-location-first query output, tier-aware invalidation, and “query before broad read” skill wording. Reject its generic document graph as a pi-lens core model; pi-lens can already attach diagnostics and docs through separate surfaces, and merging model-generated concepts into the immutable review graph would make code answers less trustworthy.

## Cross-project patterns

1. **Two layers beat one “smart graph.”** Deterministic extraction should own identity, locations, imports, containment, and explicit syntax. A separate layer may add summaries, tours, semantic edges, or provider results. The boundary must preserve source ownership and provenance.
2. **Agent value comes from context selection, not graph size.** Digests, PageRank/centrality, hubs, entry points, `affected`, neighborhood focus, query budgets, and compact JSON/JSONL all reduce the source set before reading bodies.
3. **Reading order is a first-class product.** Sylph tours and Graphify’s query-first skill make explicit what raw edges omit. Compass’s “query then verify source” workflow is the safest formulation.
4. **Freshness is part of every answer.** Hashes, parser/prompt fingerprints, sequence hints, manifests, periodic reconciliation, atomic publication, partial flags, and current-vs-history separation prevent a plausible stale graph from masquerading as truth.
5. **Resolution should expose uncertainty.** Name-only calls, inferred edges, ambiguous targets, missing endpoints, quarantined records, and incomplete coverage are useful if surfaced; silently dropping or upgrading them is not.
6. **The graph and retrieval index are complementary.** BM25/FTS is good at finding vocabulary; graph traversal is good at explaining relationships; source ranges are the final evidence. Embeddings are optional and should never replace structural evidence for code navigation.
7. **Presentation must be bounded independently of storage.** Interactive views fold hubs and cap animated edges; query engines cap rows/paths/bytes; reports use compact views. A graph can be complete while a response is intentionally a projection.

## Pi-lens fit matrix

| Upstream idea | Existing pi-lens equivalent | Real gap/overlap | Fit and likely seam |
| --- | --- | --- | --- |
| Provenance per relationship | Review-graph edge `resolution`, report section provenance, capped-coverage fields | More edge-level evidence/locations could be surfaced consistently | **Adapt** in `clients/review-graph/types.ts`, `module-report.ts`, `project-report.ts`; no new graph |
| Digest of top architecture | `project_report` compact view, word-index ranking, `recommendedReads` | No single persisted digest/tour artifact | **Adapt** as a bounded report/context mode, not a second cache; `clients/project-report.ts` |
| Guided tours/read order | Entry points, hubs, recommended reads, blast radius | No explicit multi-step tour contract | **Adapt** deterministically first; later optional agent-authored notes in reports/docs, not graph truth |
| Query-first agent workflow | Pi tools plus MCP mirrored engine; read guard tracks coverage | Could nudge toward `project_report`/`symbol_search` before broad reads | **Adapt** in a skill/docs surface; do not block native reads like Graphify strict mode |
| FTS/BM25 plus graph centrality | Persisted word index already uses BM25, reverse-dep centrality, graph annotations | Strong overlap; validate ranking quality rather than add embeddings | **Keep/adapt** in `clients/word-index.ts` and `lens-engine.ts` |
| Typed graph query language | `computeTransitiveImpact`, module/project reports, MCP tools | No arbitrary read-only graph query; current bounded tools are safer | **Reject for now**; add narrowly scoped query operations only if telemetry shows demand |
| Hash/prompt/parser-aware cache | Project snapshot/sequence/content hash, graph version, word-index metadata | Semantic prompt versioning is not a core pi-lens graph concern | **Keep existing**; extend snapshot metadata only for a demonstrated new derived index |
| Atomic immutable publication | Immutable graph-by-replacement, persist worker/generation, partial coverage | This is already stronger than several upstream paths | **Preserve**, do not copy mutable NetworkX/JSON merge semantics |
| Semantic/vector retrieval | Optional upstream embeddings | Pi-lens has no evidence of a semantic-search gap; external provider/privacy cost is high | **Reject until measured**; use TreeSitter/BM25/graph first |
| Offline interactive map | `lens-map` already produces deterministic self-contained HTML | Graphify/Sylph offer useful declutter and progressive UI patterns | **Adapt** in `clients/lens-map.ts`; no new graph/index |
| Tier-aware replacement of changed-file data | `updateGraphFiles`, reverse-deps, sequence fast path | Existing implementation is immutable and graph-specific | **Keep**, audit only when a new fact tier is added |
| Cross-project graph | Upstream CGR/Graphify support it | pi-lens is project-scoped by design and path-keyed caches are safety-sensitive | **Reject** unless a concrete MCP use case funds identity/privacy design |

## Top eight prioritized inspirations

1. **Evidence-aware compact context pack.** User value: fewer exploratory reads with explicit file, symbol, edge, line-range, provenance, and truncation evidence. Cost/risk: medium; must avoid claiming body coverage from an outline and must respect read-guard semantics. Performance/token impact: bounded by top-N hits and line ranges; reuses BM25, immutable graph, and TreeSitter extraction. Surface: agent tool first, then MCP mirror through `lens-engine`; likely `clients/word-index.ts`, `module-report.ts`, `lens-engine.ts`.
2. **Deterministic guided reading path.** User value: answer “where do I start?” as a 3–6-step path from entry point through important dependencies. Cost: low-medium; path choice needs transparent tie-breaking and must distinguish shortest from important. Token impact: small compact output. Surface: `project_report`/`module_report` and MCP mirror, computed from existing graph BFS/centrality; no persisted tour graph.
3. **Uniform edge evidence and completeness display.** User value: agents can tell exact/import/receiver-type/name-only and partial/capped/unavailable apart. Cost: medium, mostly output-contract and tests. Cache impact: none. Surface: existing reports/tools and MCP; extend only fields already derivable from graph nodes/edges.
4. **Query-first skill guidance without hard blocking.** User value: agents orient with `project_report`/`symbol_search` before flooding context. Cost: low; risk is friction and stale-cache overconfidence. Token impact: saves broad reads. Surface: docs/skill, perhaps a soft tool description; explicitly not a strict read guard.
5. **Declutter policy for `lens-map`.** User value: human architecture map remains readable at hub-heavy scale. Cost: low-medium; implement only view-level folding/LOD, preserve underlying graph. Performance: fewer DOM/SVG/canvas operations. Surface: `clients/lens-map.ts` and its viewer assets; no agent/MCP contract change.
6. **Freshness telemetry for retrieval answers.** User value: expose index age, graph generation, source cap, reverse-dependency availability, and whether a result was disk or warm memory. Cost: low; no new storage. Surface: `symbol_search`/MCP health and logs; use existing snapshot and graph metadata.
7. **Failure/quarantine vocabulary for graph-backed answers.** User value: “not found” is not confused with “not indexed” or “incomplete.” Cost: medium; align existing `available`, `coverage`, `unavailable:file-cap`, and indeterminate cascade statuses. Surface: engine/report contracts and tests.
8. **Design-only evaluation corpus for ranking and context.** User value: measurable recall and token reduction without provider dependence. Cost: medium in tests/fixtures, low runtime risk. Cache impact: none. Surface: tests and documentation; use real pi-lens fixtures, not an external graph store.

## Do not copy

- **Duplicate graph/index/parser storage.** Do not add a Memgraph/NetworkX/SQLite graph or a second Tree-sitter extractor when pi-lens already has immutable review-graph, reverse-deps, BM25, and shared `TreeSitterClient` seams. A new representation would create path, schema, freshness, and graph-generation disagreement.
- **Stale graph claims.** Do not infer “zero results means no relationship,” serve a partial/capped graph as complete, or upgrade name-only/inferred calls to fact. Preserve pi-lens’s existing indeterminate cascade and coverage language.
- **Synchronous or unbounded walks.** Upstream examples that scan or recompute all calls on every save are useful cautionary evidence, not a hot-path design. Keep file caps, chunked yields, deadlines, abort behavior, and async persistence. This is especially important on the TUI event loop.
- **Provider/network coupling.** Do not make agent navigation depend on Qdrant, an LLM Cypher planner, remote semantic extraction, or runtime grammar downloads. Structural tools must work offline and degrade honestly.
- **Project-controlled code execution.** Never execute source to discover calls, load arbitrary project plugins, or permit graph queries to become shell commands. Parsing and query tools remain read-only unless an explicit existing mutation path is used.
- **Privacy/security regressions.** Do not embed credentials in HTML, log proprietary prompts/results by default, fetch arbitrary URLs without SSRF/size/timeout guards, or expose an HTTP MCP endpoint without explicit authentication/bind warnings.
- **OS/install incompatibilities.** Do not assume POSIX paths, case-insensitive filesystems, Unix process groups, a global Python/Rust toolchain, or postinstall network access. Any implementation must honor pi-lens’s path normalization, project/global data directories, Windows tree-kill and install-lock rules, Linux CI, and no-install ordinary tests.

## Design-only experiment plan and issue-sized follow-ups

1. **Ranking replay:** build a fixture set of 20–30 real pi-lens questions with expected files/symbols. Compare current BM25, BM25+reverse-dependency centrality, and graph-only baselines. Record top-k recall, ties, false positives from tests/vendor/docs, and token cost. No production changes.
2. **Reading-path prototype:** as a pure function over a frozen `ReviewGraph`, choose entry → hub/dependency paths under a 3–6 node cap. Compare shortest path, centrality-weighted path, and `project_report` recommendations. Validate deterministic output and missing/partial graph behavior.
3. **Context-pack prototype:** compose existing `symbol_search` hits with `module_report` read handles and TreeSitter line ranges under a hard byte/token budget. Verify it never marks an outline as a body read, never returns files outside `paths`, and reports graph/index generations and truncation.
4. **Staleness telemetry:** log (or expose in a report only) graph generation, snapshot sequence, word-index file count/truncation, source mtimes checked, and cache source. Validate warm/disk/cold behavior and Windows separator/case forms without adding a cache.
5. **Map declutter experiment:** measure `lens-map` render size and interaction latency with hub folding/edge caps, comparing visual loss against current file/node caps. Do not change graph data.

Issue-sized follow-ups should be: (a) context-pack contract and unit tests; (b) reading-path tie-breaking and evidence tests; (c) ranking fixture/evaluation harness; (d) freshness fields in tool responses; and (e) lens-map declutter only if measurements show a real bottleneck. Claims needing validation telemetry include whether agents actually need semantic embeddings, whether recommended-read paths reduce rereads, how often persisted graph/index caps are hit, and whether graph centrality improves top-k recall enough to justify its cost.

## Final recommendation

The next smallest contained improvement should be a **read-only, bounded “recommended context path” design on top of `symbol_search` and `module_report`**, implemented first as a pure function and fixture evaluation—not as a new graph or index. Start with existing BM25 hits, existing reverse-dependency/immutable graph annotations, and TreeSitter-derived symbol line ranges; return at most a few ranked files/read handles with explicit `provenance`, graph/index freshness, and truncation. Keep `read_symbol`/`read_enclosing` as the only body-coverage authorities, and expose the same result through the existing `lens-engine` seam only after the pi tool contract is proven.

This captures the best upstream idea—progressive, task-focused reading order—while respecting pi-lens’s stronger existing invariants: one shared parser, one immutable graph, one persisted BM25 index, bounded event-loop work, honest partiality, and a single MCP mirror seam. It should be rejected or narrowed if ranking telemetry does not show a measurable reduction in source reads or context tokens.
