import * as containment from "../../../clients/symbol-containment.js";
import { describe, expect, it, vi } from "vitest";
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
// A bound arrow, function expression or lambda takes its binding's name
// (#5087); an unbound one stays `<anonymous@L<line>>`.
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
	["total", 20, 2, 2, 0, 1, 1],
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
	["Badge", 10, 3, 2, 0, 2, 1],
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
	["retry", 9, 5, 8, 3, 10, 2],
	["id", 20, 1, 0, 0, 1, 1],
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
	["handler", 31, 2, 1, 0, 1, 1],
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

async function keysFor(fileName: string, content: string): Promise<string[]> {
	const languageId = resolveTreeSitterLanguage(fileName);
	if (!languageId || !isComplexityLanguageId(languageId)) {
		throw new Error(`${fileName} has no metrics table`);
	}
	const parsed = await withTreeSitterRoot(
		`/virtual/${fileName}`,
		content,
		(root) => measureFile(root, languageId).functions.map((f) => f.key),
		"function-metrics-test",
	);
	expect(parsed.parsed).toBe(true);
	return parsed.parsed ? parsed.value : [];
}

// #5087: the complexity delta pairs a function before and after an edit by
// this key, so it carries the owner and never the line.
describe("measureFile function keys (#5087)", () => {
	it.each([
		[
			"shared boundary",
			"class A {\n a() {}\n} class B { b() {}\n c() { const f = () => 1; }\n}\nfunction outer() { class C { x() {} } }\n",
			["A.a", "A.b", "B.c", "B.f", "outer", "x"],
		],
		[
			"container priority",
			"function outer() {\n return 1;\n} class B { b() {}\n c() {}\n}\n",
			["outer", "B.b", "B.c"],
		],
		[
			"smaller boundary",
			"class A {\n a() {}\n} class B { b() {}\n c() {}\n d() {}\n}\n",
			["A.a", "A.b", "B.c", "B.d"],
		],
		[
			"later smaller owner",
			"class A {\n a() {}\n aa() {}\n aaa() {}\n} class B { b() {}\n}\n",
			["A.a", "A.aa", "A.aaa", "B.b"],
		],
		[
			"smallest ending owner",
			"function outer() {\n function inner() { return 0;\n} } class B { b() {}\n c() {}\n d() {}\n}\n",
			["outer", "outer.inner", "inner.b", "B.c", "B.d"],
		],
		[
			"shared start",
			"function outer() { class Inner { run() {}\n}\n return 0;\n}\n",
			["outer", "Inner.run"],
		],
		["equal spans", "class A { run() { const f = () => 1; } }\n", ["run", "f"]],
		[
			"expired owners",
			"class A {\n run() {}\n}\nfunction next() {}\n",
			["A.run", "next"],
		],
	])("preserves line containment for %s", async (_label, content, expected) => {
		// V1: a faster owner lookup must retain strict spans and first-owner ties.
		expect(await keysFor("spans.ts", content as string)).toEqual(expected);
	});

	it("keys a wide file without scanning all owners for each function", async () => {
		// V1: the old first-touch keying scanned every owner for every row.
		const scan = vi.spyOn(containment, "findOwnerName");
		try {
			const keys = await keysFor(
				"wide.ts",
				Array.from(
					{ length: 512 },
					(_, i) => `class C${i} {\n run() {}\n}\n`,
				).join(""),
			);
			expect(keys).toHaveLength(512);
			expect(keys[511]).toBe("C511.run");
			expect(scan).toHaveBeenCalledTimes(0);
		} finally {
			scan.mockRestore();
		}
	});

	it("qualifies a method by its class, and numbers same-key siblings", async () => {
		const keys = await keysFor(
			"keys.ts",
			[
				"class A {",
				"\trun(): void {}",
				"}",
				"class B {",
				"\trun(): void {",
				"\t\tconst step = () => 1;",
				"\t\t[1].map((x) => x);",
				"\t\t[2].map((y) => y);",
				"\t}",
				"}",
				"export const run = () => 0;",
				"",
			].join("\n"),
		);
		expect(keys).toEqual([
			"A.run",
			"B.run",
			"run.step",
			"run.<anonymous>",
			"run.<anonymous>#2",
			"run",
		]);
	});

	it("does not move when an edit shifts every line", async () => {
		const body =
			"const total = (xs: number[]) => xs.length;\nclass S {\n\tget(): number {\n\t\treturn [1].map((v) => v)[0];\n\t}\n}\n";
		const before = await keysFor("shift.ts", body);
		const after = await keysFor("shift.ts", `// one\n// two\n\n${body}`);
		expect(after).toEqual(before);
		expect(before).toEqual(["total", "S.get", "get.<anonymous>"]);
	});

	it("qualifies Python methods, Go methods by receiver, and Rust impl items", async () => {
		expect(
			await keysFor(
				"keys.py",
				"class Q:\n    def push(self, x):\n        return x\n\nsquare = lambda v: v * v\n",
			),
		).toEqual(["Q.push", "square"]);
		expect(
			await keysFor(
				"keys.go",
				"package p\n\ntype Server struct{}\n\nfunc (s *Server) Run() {}\n\nfunc Run() {}\n",
			),
		).toEqual(["Server.Run", "Run"]);
		expect(
			await keysFor(
				"keys.rs",
				"struct C;\nimpl C {\n    fn new() -> Self { C }\n}\nfn new() {}\n",
			),
		).toEqual(["C.new", "new"]);
	});
});
