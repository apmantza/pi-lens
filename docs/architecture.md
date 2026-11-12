# Architecture

This page maps how pi-lens routes a host event to the findings the agent sees. It is for contributors and curious users; you do not need it to use pi-lens.

Most lifecycle events enter through one wrapper, which drops and counts events
that arrive on a replaced session. `tool_call` registers raw: it delegates
straight to a handler that owns its own total guard. Events fan out into the
edit-time lane and the LSP lane. Both lanes write into the findings stores.
Nothing reaches the agent from those stores until a freshness gate or an
explicit age label clears it.

```mermaid
flowchart TD
    subgraph host["pi host"]
        HOST["Host events<br/>tool_call, tool_result, turn_start/end,<br/>session_start/shutdown, agent_end, context"]
        WRAP["Stale-ctx wrapper<br/>skips and counts events on a replaced session<br/>tool_result, turn_start, turn_end, agent_end,<br/>agent_settled, session_start, context"]
    end

    subgraph guards["Guards"]
        RG["Read-guard<br/>blocks edits that lack prior reading"]
        GG["Git-guard<br/>holds commit/push while findings stay unresolved"]
    end

    subgraph edit["Edit-time lane"]
        PIPE["Post-write pipeline<br/>secrets, format, autofix, sync, lint, tests"]
        PLAN["Dispatch plan<br/>per file kind, per capability group"]
        RUN["Runners<br/>format, lint, types, security, smells, docs"]
        STRUCT["Structural rules<br/>tree-sitter queries and ast-grep"]
        BUS["files-touched bus<br/>tells extensions which paths moved"]
    end

    subgraph lsp["LSP lane"]
        POOL["Client pool<br/>warm reuse, idle eviction"]
        DIAGS["File and workspace diagnostics"]
        CASC["Impact cascade<br/>tiered wait policy"]
    end

    STORES["Findings stores<br/>widget state, warning caches, project snapshot"]

    subgraph gate["Freshness gating"]
        FRESH["Path freshness<br/>mtime vs scan time, past-EOF, dependency drift"]
        DISPO["Dispositions<br/>false-positive, suppress, defer, flagged"]
        LABEL["Explicit age label<br/>for findings no path gate can check"]
    end

    subgraph deliver["Delivery surfaces"]
        TURN["Turn-end findings injection"]
        WIDGET["Widget and footer tally"]
        TOOLS["lens_diagnostics tool"]
        NUDGE["Agent nudges"]
    end

    SESSION["Session lifecycle<br/>primary, sequential replacement, concurrent secondary"]
    SINKS["Observability sinks<br/>latency.log, degradation ledger, bounded telemetry,<br/>cache observability, cascade and tree-sitter logs"]
    CONFIG["Config-core<br/>resolve, merge, deny"]
    REVIEWGRAPH["Review-graph intelligence<br/>call graph, reverse deps, import resolution"]

    HOST --> WRAP
    HOST -->|tool_call, raw| RG
    HOST -->|tool_call, raw| GG
    WRAP -->|session_start| SESSION
    WRAP -->|tool_result| PIPE
    WRAP -->|tool_result, records reads and writes| RG
    SESSION --> POOL
    SESSION --> STORES
    PIPE --> PLAN
    PLAN --> RUN
    PLAN --> STRUCT
    PIPE --> POOL
    PIPE --> BUS
    CONFIG --> PIPE
    CONFIG --> PLAN
    STRUCT --> REVIEWGRAPH
    REVIEWGRAPH --> CASC
    POOL --> DIAGS
    DIAGS --> CASC
    RUN --> STORES
    STRUCT --> STORES
    DIAGS --> STORES
    CASC --> STORES
    BUS --> NUDGE
    RG -->|read and edit history filter| NUDGE
    STORES --> FRESH
    STORES --> LABEL
    FRESH --> DISPO
    DISPO --> TURN
    DISPO --> WIDGET
    DISPO --> TOOLS
    LABEL --> TURN
    TURN --> GG
    WRAP --> SINKS
    PIPE --> SINKS
    RUN --> SINKS
    STRUCT --> SINKS
    POOL --> SINKS
    CASC --> SINKS
    RG --> SINKS
    GG --> SINKS
    FRESH --> SINKS
```

Architecture-level view, updated when a lane changes. Per-tool inventories live
in [features](features.md) and
[language coverage](language-coverage.md). Today the edit-time lane carries
45+ runner modules over 35+ file kinds, and the LSP lane speaks to 50
language server definitions.

The gating box is an abstraction, not a call order. Freshness covers several
independent mechanisms: path freshness against scan time, past-EOF line checks,
and forward-import dependency drift. Dispositions are one more filter alongside
them, not a second stage every finding walks through. Read the box as "a finding
passes the gates that apply to it", and see `clients/finding-delivery-gate.ts`
for the per-surface contract.
