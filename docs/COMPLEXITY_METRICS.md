# Complexity Metrics

pi-lens calculates comprehensive code quality metrics for every source file. These are used by `/lens-tdi` and shown in `/lens-booboo` reports.

## Metrics Overview

| Metric | Range | Description | Thresholds |
|--------|-------|-------------|------------|
| **Maintainability Index (MI)** | 0-100 | Composite score combining complexity, size, and structure | <20: 🔴 Unmaintainable, 20-40: 🟡 Poor, >60: ✅ Good |
| **Cognitive Complexity** | 0+ | Human mental effort to understand code (nesting penalties) | >20: 🟡 Hard to understand, >50: 🔴 Very complex |
| **Cyclomatic Complexity** | 1+ | Independent code paths (branch points + 1) | >10: 🟡 Complex function, >20: 🔴 Highly complex |
| **Max Cyclomatic** | 1+ | Worst function in file | >10 flagged |
| **Nesting Depth** | 0+ | Maximum block nesting level | >4: 🟡 Deep nesting, >6: 🔴 Excessive |
| **Code Entropy** | 0-8+ bits | Shannon entropy — unpredictability of code patterns | >4.0: 🟡 Risky, >7.0: 🔴 Very unpredictable |
| **Halstead Volume** | 0+ | Vocabulary × length — unique ops/operands | High = many different operations |

## Formulas

### Maintainability Index (Microsoft)

```
MI = max(0, (171 - 5.2*ln(Halstead) - 0.23*Cyclomatic - 16.2*ln(LOC)) * 100/171) + commentBonus
```

Where:
- **Halstead** = Halstead Volume
- **Cyclomatic** = Average cyclomatic complexity
- **LOC** = Lines of code
- **commentBonus** = up to +10% for well-commented code

### Cognitive Complexity (SonarSource)

- +1 for each structural node (if, for, while, case, catch, switch)
- +1 for each level of nesting
- +1 for each && and || in binary expressions
- Exception: else-if chains don't add nesting

### Cyclomatic Complexity (McCabe)

```
M = E - N + 2P
```

Where:
- **E** = Number of edges in control flow graph
- **N** = Number of nodes
- **P** = Number of connected components (usually 1)

Simplified: Count branch points + 1

### Code Entropy (Shannon)

```
H = -Σ(p(i) * log2(p(i)))
```

Where:
- **p(i)** = frequency of token i / total tokens

Thresholds:
- ≤4.0 bits: Predictable, conventional code ✅
- 4.0-7.0 bits: Moderate complexity 🟡
- ≥7.0 bits: Unpredictable, hard to maintain 🔴

### Halstead Volume

```
V = N * log2(n)
```

Where:
- **N** = total operators + operands (program length)
- **n** = unique operators + operands (vocabulary size)

## Technical Debt Index (TDI)

The TDI provides a single score (0-100) representing overall codebase health. Lower is better.

### Formula

```
TDI = MI-debt(45%) + cognitive(30%) + nesting(10%) + maxCyc(10%) + entropy(5%)
```

### Debt Calculation per Factor

| Factor | Debt Formula | Good | Bad |
|--------|---------------|------|-----|
| **MI** | `(100 - MI) / 100` | 100 | 0 |
| **Cognitive** | `min(1, cognitive / 200)` | 0 | ≥500 |
| **Nesting** | `max(0, nesting - 3) / 7` | ≤3 | ≥10 |
| **Max Cyclomatic** | `max(0, maxCyc - 10) / 20` | ≤10 | ≥30 |
| **Entropy** | `max(0, entropy - 4.0) / 3.0` | ≤4.0 | ≥7.0 |

### Grades

- **A** (0-15%): Excellent codebase health
- **B** (16-30%): Good, minor improvements possible
- **C** (31-50%): Moderate debt, consider refactoring
- **D** (51-70%): Significant debt, plan refactoring
- **F** (71%+): High debt, immediate attention needed

### Usage

```bash
/lens-tdi  # Display TDI score with breakdown by category
```

## AI Slop Indicators

Metrics suggesting potentially AI-generated low-quality code:

- **Low MI + high cognitive + high entropy** = potential spaghetti code
- **Excessive comments (>40%) + low MI** = hand-holding anti-patterns
- **Single-use helpers with high entropy** = over-abstraction
- **Many small functions with high cyclomatic** = fragmented complexity

**Usage:**
- `/lens-booboo` — Shows complexity table for all files
- `tool_result` — Complexity tracked per file, warnings inline
