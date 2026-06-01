import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";

const dart = createAvailabilityChecker("dart", ".exe");
const flutter = createAvailabilityChecker("flutter", ".bat");

// Lint rules that `dart fix` rewrites deterministically. The `--format=
// machine` output does NOT surface a per-diagnostic fix flag, so we keep
// a curated allowlist. Sources: dart.dev/tools/dart-fix and the `linter`
// package's documentation of which rules ship a fix. Conservative — when
// in doubt, leave a rule off this list.
const DART_FIXABLE_RULES = new Set<string>([
	// const / final canonicalization
	"prefer_const_constructors",
	"prefer_const_constructors_in_immutables",
	"prefer_const_declarations",
	"prefer_const_literals_to_create_immutables",
	"prefer_final_fields",
	"prefer_final_in_for_each",
	"prefer_final_locals",
	"prefer_final_parameters",
	"unnecessary_const",
	"unnecessary_final",
	"unnecessary_new",
	// null-aware / null safety modernization
	"avoid_init_to_null",
	"avoid_null_checks_in_equality_operators",
	"avoid_returning_null_for_void",
	"null_closures",
	"prefer_if_null_operators",
	"prefer_null_aware_operators",
	"unnecessary_null_aware_assignments",
	"unnecessary_null_in_if_null_operators",
	// string / quoting / interpolation
	"prefer_adjacent_string_concatenation",
	"prefer_interpolation_to_compose_strings",
	"prefer_single_quotes",
	"unnecessary_brace_in_string_interps",
	"unnecessary_string_escapes",
	"unnecessary_string_interpolations",
	"use_raw_strings",
	"use_string_buffers",
	// collection literals / spread / where
	"prefer_collection_literals",
	"prefer_contains",
	"prefer_for_elements_to_map_fromiterable",
	"prefer_inlined_adds",
	"prefer_int_literals",
	"prefer_iterable_whereType",
	"prefer_is_empty",
	"prefer_is_not_empty",
	"prefer_is_not_operator",
	"prefer_spread_collections",
	"use_collection_literals_when_possible",
	// types / generics / function syntax
	"omit_local_variable_types",
	"prefer_expression_function_bodies",
	"prefer_function_declarations_over_variables",
	"prefer_generic_function_type_aliases",
	"prefer_typing_uninitialized_variables",
	"prefer_void_to_null",
	"type_init_formals",
	"use_function_type_syntax_for_parameters",
	// redundancy / cleanup
	"avoid_redundant_argument_values",
	"avoid_unused_constructor_parameters",
	"empty_catches",
	"empty_constructor_bodies",
	"unnecessary_lambdas",
	"unnecessary_overrides",
	"unnecessary_parenthesis",
	"unnecessary_this",
	// imports / sorting / formatting
	"combinators_ordering",
	"directives_ordering",
	"prefer_relative_imports",
	"sort_child_properties_last",
	"slash_for_doc_comments",
	// flutter-specific deterministic rewrites
	"sized_box_for_whitespace",
	"use_decorated_box",
	"use_full_hex_values_for_flutter_colors",
	"use_key_in_widget_constructors",
	"use_named_constants",
	"use_super_parameters",
	// misc
	"prefer_conditional_assignment",
	"prefer_equal_for_default_values",
	"prefer_initializing_formals",
	"avoid_void_async",
	"unawaited_futures",
	"use_rethrow_when_possible",
]);

// dart analyze --format=machine output:
// severity|type|code|file|line|col|length|message
function parseDartMachineOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const parts = line.split("|");
		if (parts.length < 8) continue;

		const [severityStr, , code, file, lineStr, colStr, , ...messageParts] =
			parts;
		const message = messageParts.join("|").trim();
		const lineNum = parseInt(lineStr, 10);
		const colNum = parseInt(colStr, 10);

		// Only include diagnostics for the target file
		if (
			file &&
			!path.resolve(file).endsWith(path.resolve(filePath).replace(/\\/g, "/"))
		) {
			const resolvedFile = path.resolve(file.trim());
			const resolvedTarget = path.resolve(filePath);
			if (resolvedFile !== resolvedTarget) continue;
		}

		const severity =
			severityStr?.trim().toLowerCase() === "error" ? "error" : "warning";
		const ruleId = code?.trim() ?? "dart";
		const fixable = DART_FIXABLE_RULES.has(ruleId);
		diagnostics.push({
			id: `dart-${ruleId}-${lineNum}-${colNum}`,
			message: `[${ruleId}] ${message}`,
			filePath,
			line: lineNum || 1,
			column: colNum || 1,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "dart",
			rule: ruleId,
			defectClass: "style",
			fixable,
			fixSuggestion: fixable
				? "Run `dart fix --apply` to apply the deterministic auto-correction for this rule."
				: undefined,
		});
	}
	return diagnostics;
}

function firstOutputLine(result: { stdout?: string; stderr?: string }): string {
	return `${result.stderr || ""}\n${result.stdout || ""}`
		.trim()
		.split(/\r?\n/, 1)[0]
		.slice(0, 200);
}

const dartAnalyzeRunner: RunnerDefinition = {
	id: "dart-analyze",
	appliesTo: ["dart"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const absPath = path.resolve(cwd, ctx.filePath);
		const dartAvailable = await dart.isAvailableAsync(cwd);
		const flutterAvailable =
			!dartAvailable && (await flutter.isAvailableAsync(cwd));
		if (!dartAvailable && !flutterAvailable) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}
		const cmd = dartAvailable
			? dart.getCommand(cwd)!
			: flutter.getCommand(cwd)!;
		const args = dartAvailable
			? ["analyze", "--format=machine", absPath]
			: ["analyze", "--machine", absPath];

		const result = await safeSpawnAsync(cmd, args, { cwd, timeout: 30000 });

		if (result.error && !result.stdout && !result.stderr) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// dart analyze writes diagnostics to stderr in machine format
		const raw = (result.stderr || "") + (result.stdout || "");
		const diagnostics = parseDartMachineOutput(raw, ctx.filePath);

		if (diagnostics.length === 0) {
			if (result.status && result.status !== 0) {
				return {
					status: "failed",
					diagnostics: [
						{
							id: "dart-analyze-nonzero-no-diagnostics",
							message:
								firstOutputLine(result) ||
								"dart analyze exited non-zero without machine diagnostics",
							filePath: ctx.filePath,
							severity: "warning",
							semantic: "warning",
							tool: "dart",
							rule: "dart-analyze",
							fixable: false,
						},
					],
					semantic: "warning",
				};
			}
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasErrors = diagnostics.some((d) => d.severity === "error");
		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

export default dartAnalyzeRunner;
export { parseDartMachineOutput, DART_FIXABLE_RULES };
