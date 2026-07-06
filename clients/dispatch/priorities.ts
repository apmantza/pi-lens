/**
 * Dispatch runner priority tiers.
 *
 * NOTE: These priorities only govern ordering within dispatch runner execution.
 * They do not represent full write/edit pipeline order.
 */
export const PRIORITY = {
	LSP_PRIMARY: 4,
	LSP_FALLBACK: 5,
	FORMAT_AND_LINT_PRIMARY: 10,
	LINT_SECONDARY: 12,
	STRUCTURAL_ANALYSIS: 14,
	SPECIALIZED_ANALYSIS: 15,
	GENERAL_ANALYSIS: 20,
	YAML_LINT: 22,
	SQL_LINT: 24,
	DOC_QUALITY: 30,
	ARCHITECTURE: 40,
	DEEP_LANGUAGE_ANALYSIS: 50,
} as const;
