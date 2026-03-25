# Fix Plan — Iteration 1

📋 BOOBOO FIX PLAN — Iteration 1/3 (112 fixable items remaining)

⚡ Auto-fixed: Biome --write --unsafe, Ruff --fix + format already ran.

## 🔨 Fix these [107 items]

### no-console-log (14)
→ Remove or replace with class logger method
  - `clients/subprocess-client.ts:41`
  - `clients/type-coverage-client.ts:40`
  - `clients/metrics-client.ts:59`
  - `clients/rust-client.ts:67`
  - `clients/jscpd-client.ts:42`
  - `clients/ruff-client.ts:47`
  - `clients/dependency-checker.ts:54`
  - `clients/biome-client.ts:48`
  - `clients/go-client.ts:50`
  - `clients/knip-client.ts:43`
  - `clients/test-runner-client.ts:206`
  - `clients/complexity-client.ts:158`
  - `clients/ast-grep-client.ts:93`
  - `index.ts:64`

### silent-failure (56)
→ Add this.log('Error: ' + err.message) or rethrow
  - `clients/subprocess-client.ts:87`
  - `clients/subprocess-client.ts:134`
  - `clients/type-coverage-client.ts:91`
  - `clients/rust-client.ts:98`
  - `clients/rust-client.ts:148`
  - `clients/rust-client.ts:174`
  - `clients/rust-client.ts:268`
  - `clients/jscpd-client.ts:111`
  - `clients/jscpd-client.ts:123`
  - `clients/jscpd-client.ts:171`
  - `clients/ruff-client.ts:67`
  - `clients/ruff-client.ts:113`
  - `clients/ruff-client.ts:150`
  - `clients/ruff-client.ts:212`
  - `clients/ruff-client.ts:253`
  ... and 41 more

### nested-ternary (9)
→ Extract to if/else or a named variable
  - `clients/type-coverage-client.ts:108`
  - `clients/complexity-client.ts:273`
  - `index.ts:1243`
  - `index.ts:1245`
  - `index.ts:1247`
  - `index.ts:1252`
  - `index.ts:1252`
  - `index.ts:1252`
  - `index.ts:1690`

### empty-catch (28)
→ Add this.log('Error: ' + err.message) to the catch block
  - `clients/rust-client.ts:98`
  - `clients/rust-client.ts:268`
  - `clients/jscpd-client.ts:123`
  - `clients/jscpd-client.ts:171`
  - `clients/ruff-client.ts:150`
  - `clients/ruff-client.ts:212`
  - `clients/ruff-client.ts:253`
  - `clients/biome-client.ts:173`
  - `clients/biome-client.ts:247`
  - `clients/biome-client.ts:316`
  - `clients/go-client.ts:82`
  - `clients/typescript-client.ts:84`
  - `clients/test-runner-client.ts:265`
  - `clients/test-runner-client.ts:294`
  - `clients/test-runner-client.ts:318`
  ... and 13 more

## 🤖 AI Slop indicators [5 files]
  - `clients/ast-grep-client.ts`: Many try/catch blocks (10)
  - `clients/ruff-client.ts`: Many try/catch blocks (6)
  - `clients/subprocess-client.ts`: Excessive comments (34%), Over-abstraction (6 single-use helpers)
  - `clients/test-runner-client.ts`: Many try/catch blocks (7)
  - `index.ts`: Excessive comments (33%), Many try/catch blocks (9)

## ⏭️ Skip [29 items — architectural]
  - **large-class** (14): Splitting a class requires architectural decisions.
  - **no-non-null-assertion** (4): Each `!` needs nullability analysis in context.
  - **long-method** (5): Extraction requires understanding the function's purpose.
  - **long-parameter-list** (6): Redesigning the signature requires an API decision.

---
Fix the items above, then run `/lens-booboo-fix` again for the next iteration.
If an item in '🔨 Fix these' is not safe to fix, skip it with one sentence why.