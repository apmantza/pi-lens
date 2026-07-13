/**
 * Shared test-framework-call recognition for `high-fan-out` and `high-complexity`
 * (#577). A normal `it()`/`describe()` body naturally invokes many assertion/mock
 * helpers — that's test structure, not a coordination smell or genuine complexity.
 *
 * Two complementary heuristics, both call-name-based (no `ctx.fileRole` gating —
 * these calls only exist in test-framework code, so the signal is safe to apply
 * unconditionally):
 *
 * 1. `isTestFrameworkNoiseCall` — filters individual "meaningful calls" the same
 *    way `console.*`/`Math.*`/etc. are already excluded in high-fan-out. Handles
 *    assertion-heavy `it()` bodies directly.
 * 2. `isTestSuiteOrganizer` — a `describe()`/`it()`/`test()` wrapper's own
 *    FunctionSummary aggregates every call and branch from ALL of its nested test
 *    bodies (the shared tree-sitter walk in function-facts.ts does not stop at
 *    nested-function boundaries, since each nested callback also gets its own,
 *    correctly-scoped, FunctionSummary). That aggregation is not real fan-out or
 *    complexity — it's the sum of independent nested tests. A function is an
 *    "organizer" if it directly invokes `it`/`test`/`describe` (or their
 *    `.only`/`.skip`/`.each` variants) — i.e. it exists to group other tests, not
 *    to implement logic itself. This does NOT exempt genuinely complex/tangled
 *    test HELPER functions, since those don't call `it`/`describe`/`test`
 *    themselves.
 */

const EXPECT_CHAIN_PREFIX = "expect(";

const TEST_LIFECYCLE_NAMES = new Set([
	"it",
	"test",
	"describe",
	"beforeeach",
	"aftereach",
	"beforeall",
	"afterall",
]);

const TEST_LIFECYCLE_PREFIXES = ["it.", "test.", "describe."];

const MOCK_LIBRARY_PREFIXES = ["vi.", "jest."];

/**
 * True if `call` (a raw callee string from `FunctionSummary.outgoingCalls`) is
 * test-framework noise: an `expect(...)` assertion chain, a test lifecycle call
 * (`it`/`describe`/`test`/`beforeEach`/etc., including `.only`/`.skip`/`.each`
 * variants), or a mock-library call (`vi.*`/`jest.*`).
 */
export function isTestFrameworkNoiseCall(call: string): boolean {
	const lower = call.toLowerCase();
	if (lower === "expect" || lower.startsWith(EXPECT_CHAIN_PREFIX)) return true;
	if (TEST_LIFECYCLE_NAMES.has(lower)) return true;
	if (TEST_LIFECYCLE_PREFIXES.some((p) => lower.startsWith(p))) return true;
	if (MOCK_LIBRARY_PREFIXES.some((p) => lower.startsWith(p))) return true;
	return false;
}

/**
 * True if this function's (unfiltered) outgoing calls include a direct call to
 * `it`/`test`/`describe` — i.e. it groups nested test bodies rather than
 * implementing logic itself. Its aggregated fan-out/complexity reflects the sum
 * of independent nested tests, not one function's real signal.
 */
export function isTestSuiteOrganizer(calls: readonly string[]): boolean {
	return calls.some((call) => {
		const lower = call.toLowerCase();
		const base = lower.split("(")[0].split(".")[0];
		return base === "it" || base === "test" || base === "describe";
	});
}
