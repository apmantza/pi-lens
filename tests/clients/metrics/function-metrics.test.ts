import { describe, expect, it } from "vitest";
import {
	measureFile,
	type NamedFunctionMetrics,
} from "../../../clients/metrics/function-metrics.js";
import {
	isComplexityLanguageId,
	resolveTreeSitterLanguage,
	withTreeSitterRoot,
} from "../../../clients/tree-sitter-shared.js";

// One corpus per metrics table, each value worked out by hand from the
// tables in clients/metrics/function-metrics.ts. A row is
// [name, line, cyclomatic, cognitive, nesting, length, parameters].
type Row = [string, number, number, number, number, number, number];

const TS = `export function pick(a: number, b?: string, ...rest: number[]): number {
	if (a > 0 && b) {
		for (const r of rest) {
			if (r === a) return r;
		}
	}
	return b ? 1 : 0;
}

class Store {
	get(key: string, fallback = ""): string {
		try {
			return this.read(key) ?? fallback;
		} catch {
			return fallback;
		}
	}
}

const total = (xs: number[]) => xs.reduce((sum, x) => (x > 0 ? sum + x : sum), 0);
`;
const TS_ROWS: Row[] = [
	// if, for-of, if, ternary, &&; cognitive 1 + 1(&&) + 2 + 3 + 1.
	["pick", 1, 6, 8, 3, 8, 3],
	// catch, ??; the catch sits inside the try, so it scores 2.
	["get", 11, 3, 3, 1, 7, 2],
	// The callback's ternary counts here too, one function level deeper.
	["<anonymous@L20>", 20, 2, 2, 0, 1, 1],
	["<anonymous@L20>", 20, 2, 1, 0, 1, 2],
];

const TSX = `export function List({ items }: { items: string[] }) {
	if (items.length === 0) return <p>empty</p>;
	return (
		<ul>
			{items.map((item) => (item ? <li key={item}>{item}</li> : null))}
		</ul>
	);
}

export const Badge = (props: { on: boolean; label?: string }) =>
	props.on && props.label ? <b>{props.label}</b> : null;

function useToggle(initial: boolean) {
	let value = initial;
	while (!value) {
		switch (typeof value) {
			case "boolean":
				value = true;
				break;
			default:
				value = false;
		}
	}
	return value;
}
`;
const TSX_ROWS: Row[] = [
	["List", 1, 3, 3, 1, 8, 1],
	["<anonymous@L5>", 5, 2, 1, 0, 1, 1],
	// An expression body is its own scope: the ternary scores 1, && scores 1.
	["<anonymous@L10>", 10, 3, 2, 0, 2, 1],
	// while, one case (default is not a decision); switch scores 1 + 1.
	["useToggle", 13, 3, 3, 2, 13, 1],
];

const JS = `function walk(node, visit, depth = 0) {
	if (!node) return;
	visit(node, depth);
	for (const child of node.children || []) {
		walk(child, visit, depth + 1);
	}
}

const retry = async function (task, { attempts = 3 } = {}) {
	let left = attempts;
	do {
		try {
			return await task();
		} catch (error) {
			if (--left === 0 || error.fatal) throw error;
		}
	} while (left > 0);
};

export const id = x => x;
`;
const JS_ROWS: Row[] = [
	["walk", 1, 4, 3, 1, 7, 3],
	// do, catch, if, ||; the catch and the if both sit under do + try.
	["<anonymous@L9>", 9, 5, 8, 3, 10, 2],
	["<anonymous@L20>", 20, 1, 0, 0, 1, 1],
];

const PY = `def classify(value, *, strict=False, **extra):
    if value is None and strict:
        raise ValueError("missing")
    elif isinstance(value, int) or extra:
        return "number" if value > 0 else "other"
    for key in extra:
        while key:
            key = key[1:]
    return "text"


class Reader:
    def read(self, path, /, retries=2):
        try:
            with open(path) as handle:
                return handle.read()
        except FileNotFoundError:
            return None
        except OSError:
            if retries:
                return self.read(path, retries - 1)
            raise


def route(command):
    match command:
        case "start":
            return 1
        case "stop":
            return 0
    handler = lambda event: event or None
    return handler(command)
`;
const PY_ROWS: Row[] = [
	// if, elif, conditional, for, while, and, or. The bare * is not a parameter.
	["classify", 1, 8, 10, 2, 9, 3],
	// Two excepts and an if, each one level inside the try.
	["read", 13, 4, 6, 2, 10, 3],
	// Two cases; match scores 1, the lambda's or scores 1.
	["route", 25, 4, 2, 1, 8, 1],
	["<anonymous@L31>", 31, 2, 1, 0, 1, 1],
];

const GO = `package sample

func Parse(input string, strict bool, limits ...int) (int, error) {
	if input == "" && strict {
		return 0, errEmpty
	} else if len(limits) > 0 || !strict {
		for _, limit := range limits {
			if limit < 0 {
				continue
			}
		}
	}
	return len(input), nil
}

func (s *Server) Handle(kind, name string) string {
	switch kind {
	case "a", "b":
		return name
	case "c":
		return ""
	default:
		return "unknown"
	}
}

func Watch(events <-chan int, done chan struct{}) {
	notify := func(n int) bool { return n > 0 }
	for {
		select {
		case e := <-events:
			notify(e)
		case <-done:
			return
		}
	}
}
`;
const GO_ROWS: Row[] = [
	// An else-if nests one level under its if; cognitive 1+1+2+1+3+4.
	["Parse", 3, 7, 12, 4, 12, 3],
	// The receiver is not a parameter; "kind, name string" declares two.
	["Handle", 16, 3, 1, 1, 10, 2],
	["Watch", 27, 4, 3, 2, 11, 2],
	["<anonymous@L28>", 28, 1, 0, 0, 1, 1],
];

const RUST = `pub fn parse(input: &str, strict: bool) -> Option<u32> {
    if input.is_empty() && strict {
        return None;
    } else if let Ok(n) = input.parse::<u32>() {
        return Some(n);
    }
    let mut total = 0;
    for c in input.chars() {
        while total > 100 || c == ' ' {
            total -= 1;
        }
        total += 1;
    }
    Some(total)
}

impl Grid {
    fn cell(&self, x: usize, y: usize) -> char {
        match (x, y) {
            (0, _) => '|',
            (_, 0) => '-',
            _ => ' ',
        }
    }
}

fn spin(limit: u32) -> u32 {
    let step = |n: u32| if n % 2 == 0 { n / 2 } else { n + 1 };
    let mut n = limit;
    loop {
        if n <= 1 {
            break;
        }
        n = step(n);
    }
    n
}
`;
const RUST_ROWS: Row[] = [
	["parse", 1, 7, 8, 2, 15, 2],
	// Every arm counts, the catch-all included; &self is a parameter.
	["cell", 18, 4, 1, 1, 7, 3],
	// The closure's if scores 2: a nested function deepens cognitive nesting.
	["spin", 27, 4, 5, 2, 11, 1],
	["<anonymous@L28>", 28, 2, 1, 1, 1, 1],
];

// Labeled break/continue (#5274 F1, Greptile PRRT_kwDORt8rec6zwPCR): master's
// subtreeCognitive scored a labeled jump; the seam dropped it and a labeled
// loop scored the same as an unlabeled one. SonarSource: a labeled jump adds 1,
// flat, with no nesting term; a bare break or continue adds nothing. Rust's
// `break 'outer` is a break_expression with a loop_label, which master never
// scored and which stays out of scope.
const TS_LABELED = `function scan(grid: number[][]) {
	outer: for (const row of grid) {
		for (const cell of row) {
			if (cell < 0) continue outer;
			if (cell === 0) break;
		}
		if (row.length === 0) break outer;
	}
}
`;
const GO_LABELED = `package sample

func Scan(grid [][]int) {
outer:
	for _, row := range grid {
		for _, cell := range row {
			if cell < 0 {
				continue outer
			}
			if cell == 0 {
				break
			}
		}
		if len(row) == 0 {
			break outer
		}
	}
}
`;
// for 1, for 2, if 3, continue outer 1, if 3, bare break 0, if 2, break outer 1;
// cyclomatic is 1 + two fors + three ifs.
const LABELED_ROW = (name: string, line: number, length: number): Row => [
	name,
	line,
	6,
	13,
	3,
	length,
	1,
];

async function rowsFor(fileName: string, content: string): Promise<Row[]> {
	const languageId = resolveTreeSitterLanguage(fileName);
	if (!languageId || !isComplexityLanguageId(languageId)) {
		throw new Error(`${fileName} has no metrics table`);
	}
	const parsed = await withTreeSitterRoot(
		`/virtual/${fileName}`,
		content,
		(root) => measureFile(root, languageId).functions,
		"function-metrics-test",
	);
	expect(parsed.parsed).toBe(true);
	return (parsed.parsed ? parsed.value : []).map((f: NamedFunctionMetrics) => [
		f.name,
		f.line,
		f.cyclomatic,
		f.cognitive,
		f.nesting,
		f.length,
		f.parameters,
	]);
}

describe("measureFile corpus (#5086)", () => {
	it.each([
		["sample.ts", TS, TS_ROWS],
		["sample.tsx", TSX, TSX_ROWS],
		["sample.js", JS, JS_ROWS],
		["sample.py", PY, PY_ROWS],
		["sample.go", GO, GO_ROWS],
		["sample.rs", RUST, RUST_ROWS],
	] as const)(
		"measures every function in %s",
		async (fileName, content, rows) => {
			expect(await rowsFor(fileName, content)).toEqual(rows);
		},
	);

	it.each([
		["labeled.ts", TS_LABELED, LABELED_ROW("scan", 1, 9)],
		["labeled.go", GO_LABELED, LABELED_ROW("Scan", 3, 16)],
	] as const)(
		"scores a labeled break or continue once, flat, in %s (#5274)",
		async (fileName, content, row) => {
			expect(await rowsFor(fileName, content)).toEqual([row]);
		},
	);

	it("scores file-level nesting and cognitive complexity over the whole tree", async () => {
		const parsed = await withTreeSitterRoot(
			"/virtual/flat.py",
			"if ready:\n    for item in queue:\n        handle(item)\n\ndef handle(item):\n    if item:\n        return item\n",
			(root) => {
				const { cognitive, nesting, functions } = measureFile(root, "python");
				return { cognitive, nesting, functions: functions.length };
			},
			"function-metrics-test",
		);
		// Module-level code counts, and a top-level def adds no nesting of its
		// own: the if inside handle scores 1, not 2.
		expect(parsed.parsed ? parsed.value : undefined).toEqual({
			cognitive: 4,
			nesting: 2,
			functions: 1,
		});
	});
});
