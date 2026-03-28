# pi-lens Refactoring Plan

Based on analysis of pi-lens architecture and patterns from pi-formatter.

## Current State Assessment

### Strengths ✅
- **Delta Mode**: Only shows NEW violations, not pre-existing
- **Complexity Metrics**: MI, cognitive complexity, historical tracking
- **Turn State**: Tracks modified files across turns for batch processing
- **Fix Loop**: Iterative fix with session state and false positive marking
- **Type Safety Checks**: Switch exhaustiveness, architectural rules
- **Test Runner**: Integrated test running on write
- **Good test coverage**: 170 tests, 16 test files

### Weaknesses ⚠️
- **index.ts is monolithic**: 1632 lines of if/else chains
- **Tool dispatch is hardcoded**: Each tool check duplicated across clients
- **File kind detection is scattered**: `isSupportedFile()` in each client
- **Config walking is duplicated**: Each client re-implements directory traversal
- **No failure sanitization**: Raw stderr shown to users
- **No deferred mode**: Immediate feedback can cause model drift

---

## Phased Implementation Plan

### Phase 1: Foundation (Low Effort, High Impact)

**Goal**: Extract common utilities and add centralized file kind detection

#### 1.1 File Kind Detection (`clients/file-kinds.ts` - NEW)
- [ ] Create `FileKind` type union: `jsts | python | go | rust | cxx | cmake | shell | json | markdown`
- [ ] Create `detectFileKind(filePath: string): FileKind | undefined`
- [ ] Update all clients to use centralized detection
- [ ] Update `isSupportedFile()` to use detection

#### 1.2 Failure Sanitization (`clients/sanitize.ts` - NEW)
- [ ] Create `sanitizeToolOutput(output: string): string` - strip ANSI, normalize errors
- [ ] Create `extractErrorMessage(output: string): string | undefined` - get key error line
- [ ] Update `BiomeClient`, `RuffClient`, `GoClient`, `RustClient` to use sanitizer

#### 1.3 Tool Availability Caching (`clients/tool-availability.ts` - NEW)
- [ ] Create `checkToolAvailability(tools: string[]): Map<string, boolean>`
- [ ] Add caching to avoid repeated `spawnSync` checks
- [ ] Update all clients to use cached availability

**Deliverables**: ~200 lines new code, ~100 lines removed from clients

---

### Phase 2: Declarative Dispatch (Medium Effort, High Impact) ✅ DONE

**Goal**: Replace 500+ lines of if/else with declarative config

#### 2.1 Tool Config Types (`clients/dispatch/types.ts` - NEW) ✅
- [x] `RunnerDefinition`: id, appliesTo, priority, when, run
- [x] `DispatchContext`: filePath, cwd, kind, pi, autofix, deltaMode
- [x] `RunnerResult` with diagnostics + semantic
- [x] `Diagnostic`: structured issue representation
- [x] `OutputSemantic`: blocking, warning, fixed, silent, none
- [x] `ToolPlan` and `RunnerGroup` interfaces

#### 2.2 Core Tool Dispatcher (`clients/dispatch/dispatcher.ts` - NEW) ✅
- [x] Registry: registerRunner, getRunner, getRunnersForKind
- [x] dispatchForFile() with plan-based execution
- [x] Mode support: "all", "fallback", "first-success"
- [x] Output formatting with emoji

#### 2.3 Execution Plan (`clients/dispatch/plan.ts` - NEW) ✅
- [x] TOOL_PLANS for all file kinds

#### 2.4 Per-File Runners (`clients/dispatch/runners/*.ts` - NEW) ✅
- [x] ts-lsp.ts - TypeScript LSP diagnostics
- [x] biome.ts - Biome lint for JS/TS/JSON
- [x] ruff.ts - Ruff lint for Python
- [x] type-safety.ts - Type safety checks
- [x] ast-grep.ts - Structural analysis
- [x] architect.ts - Architectural rules + file size
- [x] go-vet.ts - Go vet linting
- [x] rust-clippy.ts - Rust clippy linting

#### 2.5 Integration ✅
- [x] dispatchLint() helper in integration.ts
- [x] Dispatcher now runs by default (no flag needed)
- [x] Replaced 422 lines with 6-line dispatch call
- [x] Project-wide checks remain in index.ts (need global state)

**Stats**: 1632 → 1275 lines (-357 lines, -22%)

**Note**: Project-wide checks (duplicate exports, circular deps, test runner,
jscpd) require global state and remain in index.ts.

---

### Phase 3: Deferred Feedback Mode (Medium Effort, Medium Impact)

**Goal**: Add option to batch feedback until agent_end

#### 3.1 Feedback Mode Config
- [ ] Add `--feedback-mode` flag: `immediate | deferred | batch`
- [ ] `immediate`: Current behavior (show on each write/edit)
- [ ] `deferred`: Collect all issues, show on `agent_end`
- [ ] `batch`: Show every N writes or on `agent_end`

#### 3.2 Issue Collector (`clients/feedback/collector.ts` - NEW)
- [ ] Create `FeedbackCollector` class
- [ ] Track issues by file, severity, tool
- [ ] Support deduplication (same issue from multiple tools)
- [ ] Implement `flush(): ToolResult[]` for agent_end

#### 3.3 Update Event Handlers
- [ ] Modify `tool_result` to either dispatch immediately or collect
- [ ] Modify `agent_end` to flush collected feedback
- [ ] Add TUI summary showing issue counts by severity

**Deliverables**: New feature, backward compatible

---

### Phase 4: Config Walking (Medium Effort, Medium Impact)

**Goal**: Centralize config file detection

#### 4.1 Config Walker (`clients/config-walker.ts` - NEW)
- [ ] Create `findConfigFile(filePath: string, patterns: string[], rootDir: string): Promise<string | undefined>`
- [ ] Add caching per filePath + patterns combination
- [ ] Handle glob patterns (e.g., `biome.json`, `biome.jsonc`)
- [ ] Walk up from file to root

#### 4.2 Config Patterns Registry (`clients/config-patterns.ts` - NEW)
- [ ] Define `ToolConfigPatterns`: Map of tool name → config file patterns
- [ ] Patterns: biome, eslint, tsconfig, ruff, pyproject, go.mod, Cargo.toml, etc.
- [ ] Export `TOOL_CONFIG_PATTERNS` constant

#### 4.3 Update Clients
- [ ] Refactor `BiomeClient.checkFile()` to use config walker
- [ ] Refactor `TypeScriptClient` to use config walker
- [ ] Refactor `RuffClient` to use config walker
- [ ] Remove duplicated config walking code

**Deliverables**: ~150 lines removed from clients

---

### Phase 5: Module Extraction (Higher Effort, Long-term Value)

**Goal**: Break up monolithic index.ts

#### 5.1 New Directory Structure
```
commands/
├── handlers/
│   ├── lens-metrics-handler.ts    (~200 lines)
│   ├── lens-format-handler.ts     (~100 lines)
│   ├── lens-booboo-handler.ts     (~150 lines)
│   └── lens-refactor-handler.ts   (~100 lines)
├── dispatch/
│   ├── types.ts                   (ToolConfig, ToolContext, etc.)
│   ├── dispatcher.ts              (core dispatch logic)
│   ├── tools.ts                   (tool definitions)
│   └── feedback/
│       ├── collector.ts
│       └── modes.ts
└── index.ts                       (~300 lines, just wiring)
```

#### 5.2 Extract Commands
- [ ] Move `/lens-metrics` handler to `commands/handlers/lens-metrics-handler.ts`
- [ ] Move `/lens-format` handler to `commands/handlers/lens-format-handler.ts`
- [ ] Move `/lens-booboo` handler to `commands/handlers/lens-booboo-handler.ts`
- [ ] Move `/lens-booboo-fix` handler to `commands/handlers/lens-fix-handler.ts`
- [ ] Move `/lens-booboo-refactor` handler to `commands/handlers/lens-refactor-handler.ts`

#### 5.3 Extract Tool Definitions
- [ ] Move tool configs from `dispatch/tools.ts` to `commands/dispatch/tools/`
- [ ] One file per tool: `biome.ts`, `ruff.ts`, `ast-grep.ts`, etc.
- [ ] Update imports in dispatcher

#### 5.4 Clean Up index.ts
- [ ] Remove all handler code (~800 lines)
- [ ] Remove tool dispatch code (~400 lines)
- [ ] Keep: client initialization, flag registration, event wiring
- [ ] Target: ~300 lines

**Deliverables**: Cleaner architecture, easier testing

---

## Migration Strategy

### Backward Compatibility
- All existing flags continue to work
- All existing commands continue to work
- New features are additive (opt-in)

### Testing Strategy
- Add tests for new modules before removing old code
- Run full test suite after each phase
- Use feature flags to toggle new behavior during transition

### Rollback Plan
- Keep old code in `index.ts` until new code is proven
- Use git tags to mark phase completions
- Can revert to previous phase if issues arise

---

## Success Metrics

| Metric | Before | After |
|--------|--------|-------|
| index.ts lines | 1632 | ~300 |
| Tool dispatch code | ~500 lines | ~200 lines (config) |
| File detection code | 8 copies | 1 centralized |
| Config walking code | 4 copies | 1 centralized |
| Failure messages | Raw stderr | Sanitized |
| Deferred mode | ❌ | ✅ |

---

## Estimated Timeline

| Phase | Effort | Duration |
|-------|--------|----------|
| Phase 1 | Low | 1-2 days |
| Phase 2 | Medium | 3-5 days |
| Phase 3 | Medium | 2-3 days |
| Phase 4 | Medium | 2-3 days |
| Phase 5 | Higher | 1 week |

**Total**: ~2-3 weeks for full implementation

---

## References

- pi-formatter architecture: https://github.com/tenzir/pi-formatter
- Current pi-lens codebase: `index.ts`, `clients/*.ts`
- Patterns to adopt: File kind detection, failure sanitization, deferred mode
