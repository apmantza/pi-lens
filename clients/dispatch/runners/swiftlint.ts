import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createAvailabilityChecker,
	resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.js";

const swiftlint = createAvailabilityChecker("swiftlint", ".exe");

/**
 * SwiftLint JSON output is a flat array of violation objects:
 *
 * [
 *   {
 *     "rule_id": "identifier_name",
 *     "reason": "Variable name should be between 3 and 40 characters long",
 *     "character": 10,
 *     "file": "/path/to/file.swift",
 *     "severity": "Warning",
 *     "type": "Identifier Name",
 *     "line": 15
 *   }
 * ]
 *
 * An empty array means clean. Exit code is non-zero when violations exist.
 */
interface SwiftLintViolation {
	rule_id?: string;
	reason?: string;
	character?: number;
	file?: string;
	severity?: string;
	type?: string;
	line?: number;
}

// SwiftLint rules whose rule class declares a `corrector` — i.e. rules that
// `swiftlint --fix` rewrites deterministically. The JSON reporter does not
// surface a per-violation `is_corrected` flag, so we keep a curated allowlist.
// Source: https://realm.github.io/SwiftLint/rule-directory.html (each rule
// page indicates whether a corrector exists). Conservative — when in doubt,
// leave a rule off this list.
const SWIFTLINT_FIXABLE_RULES = new Set<string>([
	"closing_brace",
	"colon",
	"comma",
	"comma_inheritance",
	"control_statement",
	"duplicate_imports",
	"empty_collection_literal",
	"empty_enum_arguments",
	"empty_parameters",
	"empty_parentheses_with_trailing_closure",
	"empty_string",
	"explicit_init",
	"file_header",
	"joined_default_parameter",
	"legacy_constant",
	"legacy_constructor",
	"legacy_hashing",
	"legacy_nsgeometry_functions",
	"mark",
	"modifier_order",
	"no_extension_access_modifier",
	"no_space_in_method_call",
	"number_separator",
	"opening_brace",
	"operator_usage_whitespace",
	"prefer_zero_over_explicit_init",
	"private_over_fileprivate",
	"protocol_property_accessors_order",
	"redundant_discardable_let",
	"redundant_nil_coalescing",
	"redundant_objc_attribute",
	"redundant_optional_initialization",
	"redundant_string_enum_value",
	"redundant_type_annotation",
	"redundant_void_return",
	"return_arrow_whitespace",
	"self_in_property_initialization",
	"shorthand_operator",
	"sorted_imports",
	"statement_position",
	"trailing_comma",
	"trailing_newline",
	"trailing_semicolon",
	"trailing_whitespace",
	"unneeded_break_in_switch",
	"unneeded_parentheses_in_closure_argument",
	"unused_capture_list",
	"vertical_parameter_alignment",
	"vertical_whitespace",
	"vertical_whitespace_between_cases",
	"vertical_whitespace_closing_braces",
	"vertical_whitespace_opening_braces",
	"void_function_in_ternary",
	"void_return",
	"yoda_condition",
]);

function parseSwiftLintOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	if (!raw.trim()) return diagnostics;

	try {
		const parsed = JSON.parse(raw) as SwiftLintViolation[];
		if (!Array.isArray(parsed)) return diagnostics;

		for (const item of parsed) {
			if (!item.reason) continue;

			const severityMap: Record<string, "error" | "warning" | "info"> = {
				error: "error",
				warning: "warning",
				info: "info",
			};
			const severity =
				severityMap[item.severity?.toLowerCase() ?? ""] ?? "warning";
			const ruleId = item.rule_id ?? "swiftlint";
			const fixable = SWIFTLINT_FIXABLE_RULES.has(ruleId);

			diagnostics.push({
				id: `swiftlint-${item.line}-${ruleId}`,
				message: `[${ruleId}] ${item.reason}`,
				filePath,
				line: item.line ?? 1,
				column: item.character ?? 1,
				severity,
				semantic: severity === "error" ? "blocking" : "warning",
				tool: "swiftlint",
				rule: ruleId,
				defectClass: "style",
				fixable,
				fixSuggestion: fixable
					? "Run `swiftlint --fix` to apply the deterministic auto-correction for this rule."
					: undefined,
			});
		}
	} catch {
		return diagnostics;
	}

	return diagnostics;
}

const swiftlintRunner: RunnerDefinition = {
	id: "swiftlint",
	appliesTo: ["swift"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		let cmd: string | null = null;
		if (
			await (swiftlint.isAvailableAsync(cwd))
		) {
			cmd = swiftlint.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "swiftlint");
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const result = await safeSpawnAsync(
			cmd,
			["--reporter", "json", path.resolve(cwd, ctx.filePath)],
			{ cwd, timeout: 15000 },
		);

		// SwiftLint exits non-zero on violations — stdout still has the JSON
		const raw = result.stdout || "";
		const diagnostics = parseSwiftLintOutput(raw, ctx.filePath);

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");

		return {
			status: hasBlocking ? "failed" : "succeeded",
			diagnostics,
			semantic: hasBlocking ? "blocking" : "warning",
		};
	},
};

export default swiftlintRunner;
export { parseSwiftLintOutput, SWIFTLINT_FIXABLE_RULES };
