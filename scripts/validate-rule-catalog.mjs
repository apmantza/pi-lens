import fs from "node:fs";
import path from "node:path";

const STRICT = process.argv.includes("--strict");

const root = process.cwd();
const catalogPath = path.join(root, "rules", "rule-catalog.json");
const treeSitterRoot = path.join(root, "rules", "tree-sitter-queries");
const astGrepRoot = path.join(root, "rules", "ast-grep-rules", "rules");

const TRACKED_AST_GREP_IDS = new Set([
	"no-sql-in-code",
	"no-sql-in-code-js",
	"no-open-redirect",
	"no-open-redirect-js",
	"no-javascript-url",
	"no-javascript-url-js",
	"no-insecure-randomness",
	"no-insecure-randomness-js",
	"no-implied-eval",
	"no-implied-eval-js",
	"no-hardcoded-secrets",
	"no-hardcoded-secrets-js",
	"no-global-eval-js",
	"jwt-no-verify",
	"jwt-no-verify-js",
	"toctou",
	"toctou-js",
	"missed-concurrency",
	"missed-concurrency-js",
	"no-await-in-loop",
	"no-await-in-loop-js",
	"unmarshal-tag-is-dash",
	"redundant-unsafe-function",
	"avoid-duplicate-export",
	"rust-2024-let-chain-candidate",
	"no-console-except-error",
	"no-console-except-error-js",
	"missing-component-decorator",
	"unnecessary-react-hook",
	"redundant-usestate-type",
	"find-import-file-without-extension",
	"no-compile-call",
	"no-marshal-load",
	"no-requests-verify-false",
	"no-python-sql-string-concat",
	"find-func-declaration-with-prefix",
	"defer-func-call-antipattern",
	"no-console-except-catch",
	"go-test-functions",
	"go-defer-func-call-antipattern",
	"ruby-detect-path-traversal",
	"loop-var-capture",
	"defer-in-loop",
	"nil-map-assignment",
	"string-concat-in-loop",
	"mutex-unlock-mismatch",
	"unlock-in-loop",
	"waitgroup-done-scope",
	"gorm-find-without-where",
	"gorm-n-plus-one",
]);

function walkYaml(dir, acc = []) {
	if (!fs.existsSync(dir)) return acc;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walkYaml(full, acc);
		} else if (entry.name.endsWith(".yml")) {
			acc.push(full);
		}
	}
	return acc;
}

function readYamlScalar(text, key) {
	const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
	if (!match) return undefined;
	return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function collectTreeSitterSecurityConcurrency() {
	const files = walkYaml(treeSitterRoot);
	const rules = [];
	for (const file of files) {
		const text = fs.readFileSync(file, "utf8");
		const id = readYamlScalar(text, "id");
		const category = readYamlScalar(text, "category");
		if (!id || !category) continue;
		if (category !== "security" && category !== "concurrency") continue;
		const language =
			readYamlScalar(text, "language") ?? path.basename(path.dirname(file));
		rules.push({
			id,
			category,
			language,
			file: path.relative(root, file).replaceAll("\\", "/"),
		});
	}
	return rules;
}

function collectAstGrepTrackedRules() {
	const files = walkYaml(astGrepRoot);
	const rules = [];
	for (const file of files) {
		const text = fs.readFileSync(file, "utf8");
		const id = readYamlScalar(text, "id");
		if (!id || !TRACKED_AST_GREP_IDS.has(id)) continue;
		const language = readYamlScalar(text, "language") ?? "unknown";
		rules.push({
			id,
			language,
			file: path.relative(root, file).replaceAll("\\", "/"),
		});
	}
	return rules;
}

function validateCatalog(catalog) {
	const required = [
		"rule_id",
		"engine",
		"language",
		"family",
		"scope",
		"canonical_concept",
		"severity_default",
		"confidence",
		"status",
	];
	const validEngine = new Set(["tree-sitter", "ast-grep", "architect"]);
	const validSeverity = new Set(["error", "warning", "info", "review"]);
	const validConfidence = new Set(["low", "medium", "high"]);
	const validStatus = new Set(["experimental", "active", "deprecated"]);

	const errors = [];
	const warnings = [];
	const byRuleId = new Map();
	const activeByConceptScopeLang = new Map();

	for (const [index, entry] of catalog.entries.entries()) {
		for (const field of required) {
			if (!entry[field]) {
				errors.push(`entries[${index}] missing required field '${field}'`);
			}
		}

		if (entry.engine && !validEngine.has(entry.engine)) {
			errors.push(`entries[${index}] has invalid engine '${entry.engine}'`);
		}
		if (entry.severity_default && !validSeverity.has(entry.severity_default)) {
			errors.push(
				`entries[${index}] has invalid severity_default '${entry.severity_default}'`,
			);
		}
		if (entry.confidence && !validConfidence.has(entry.confidence)) {
			errors.push(
				`entries[${index}] has invalid confidence '${entry.confidence}'`,
			);
		}
		if (entry.status && !validStatus.has(entry.status)) {
			errors.push(`entries[${index}] has invalid status '${entry.status}'`);
		}

		if (entry.rule_id) {
			if (byRuleId.has(entry.rule_id)) {
				errors.push(`duplicate rule_id '${entry.rule_id}' in rule catalog`);
			}
			byRuleId.set(entry.rule_id, entry);
		}

		if (entry.status === "active" && !entry.allow_overlap) {
			const key = `${entry.language}::${entry.scope}::${entry.canonical_concept}`;
			const prev = activeByConceptScopeLang.get(key);
			if (prev) {
				warnings.push(
					`possible overlap for ${key}: '${prev.rule_id}' and '${entry.rule_id}' (consider allow_overlap or concept split)`,
				);
			} else {
				activeByConceptScopeLang.set(key, entry);
			}
		}
	}

	return { errors, warnings, byRuleId };
}

if (!fs.existsSync(catalogPath)) {
	console.error(`[rule-catalog] missing ${catalogPath}`);
	process.exit(1);
}

const catalogRaw = fs.readFileSync(catalogPath, "utf8");
let parsed;
try {
	parsed = JSON.parse(catalogRaw);
} catch (error) {
	console.error(`[rule-catalog] invalid JSON: ${error}`);
	process.exit(1);
}

const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
const treeRules = collectTreeSitterSecurityConcurrency();
const astRules = collectAstGrepTrackedRules();
const { errors, warnings, byRuleId } = validateCatalog({ entries });

for (const rule of treeRules) {
	if (!byRuleId.has(rule.id)) {
		warnings.push(
			`missing catalog entry for ${rule.id} (${rule.category}, ${rule.language}) at ${rule.file}`,
		);
	}
}

for (const entry of entries) {
	if (entry.engine !== "tree-sitter") continue;
	const exists = treeRules.some((rule) => rule.id === entry.rule_id);
	if (!exists) {
		warnings.push(
			`catalog entry '${entry.rule_id}' has no matching tree-sitter rule file (maybe removed or renamed)`,
		);
	}
}

for (const rule of astRules) {
	if (!byRuleId.has(rule.id)) {
		warnings.push(
			`missing catalog entry for ${rule.id} (ast-grep, ${rule.language}) at ${rule.file}`,
		);
	}
}

for (const entry of entries) {
	if (entry.engine !== "ast-grep") continue;
	const exists = astRules.some((rule) => rule.id === entry.rule_id);
	if (!exists) {
		warnings.push(
			`catalog entry '${entry.rule_id}' has no matching tracked ast-grep rule file`,
		);
	}
}

const report = {
	catalogEntries: entries.length,
	trackedTreeSitterSecurityConcurrencyRules: treeRules.length,
	trackedAstGrepRules: astRules.length,
	errors: errors.length,
	warnings: warnings.length,
	strict: STRICT,
};

console.log(JSON.stringify(report, null, 2));
for (const err of errors) console.error(`[rule-catalog][error] ${err}`);
for (const warn of warnings) console.error(`[rule-catalog][warn] ${warn}`);

if (errors.length > 0) process.exit(1);
if (STRICT && warnings.length > 0) process.exit(1);
