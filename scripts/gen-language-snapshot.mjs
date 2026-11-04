#!/usr/bin/env node
/**
 * Language-identity golden snapshot (#2424).
 *
 * Records, for every extension and special filename in the UNION of the
 * language tables (file-kinds, lsp/language, tree-sitter-shared,
 * project-diagnostics/scanner, read-expansion, review-graph/builder,
 * module-report), what each consumer answers for that file. The fixture is the
 * reviewer's proof that consolidating those tables onto
 * `clients/language-registry.ts` changed exactly the enumerated rows and
 * nothing else.
 *
 *   npm run build && node scripts/gen-language-snapshot.mjs          # write
 *   npm run build && node scripts/gen-language-snapshot.mjs --check  # verify
 *
 * `tests/clients/language-registry-drift.test.ts` runs the same comparison, so
 * an accidental change to any consumer fails CI with a readable diff.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	detectFileKind,
	getLanguageId as getKindLanguageId,
	KIND_EXTENSIONS,
} from "../clients/file-kinds.js";
import { LANGUAGE_TO_GRAMMAR } from "../clients/grammar-source.js";
import {
	getLanguageId as getLspLanguageId,
	LANGUAGE_EXTENSIONS,
} from "../clients/lsp/language.js";
import { tsLangForFile } from "../clients/module-report.js";
import { TREE_SITTER_EXT_TO_LANG } from "../clients/project-diagnostics/scanner.js";
import { readExpansionLanguage } from "../clients/read-expansion.js";
import { mapKindToTreeSitterLanguage } from "../clients/review-graph/builder.js";
import { EXT_TO_LANG } from "../clients/tree-sitter-shared.js";
import { isMainModule } from "./lib/is-main-module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_PATH = path.join(
	HERE,
	"..",
	"tests",
	"fixtures",
	"language-identity-snapshot.json",
);

/**
 * Special filenames worth snapshotting (basename classifiers, not extensions).
 * `tsconfig.app.json` is the #4636 row whose answers deliberately disagree:
 * kind `json` (the coarse classifier reads the suffix), LSP id `jsonc` (the
 * registry declares the name), grammar `json`. Its siblings' answers for the
 * same path are what a regression would move.
 */
const SPECIAL_FILENAME_SAMPLES = [
	"CMakeLists.txt",
	"Dockerfile",
	"Dockerfile.dev",
	"Jenkinsfile",
	"Makefile",
	"build.gradle",
	"root.hcl",
	"settings.gradle",
	"terragrunt.hcl",
	"tsconfig.app.json",
];

/** Every extension any table in the union knows about. */
export function extensionUnion() {
	const all = new Set();
	for (const extensions of Object.values(KIND_EXTENSIONS)) {
		for (const extension of extensions) all.add(extension.toLowerCase());
	}
	for (const key of Object.keys(LANGUAGE_EXTENSIONS)) {
		if (key.startsWith(".")) all.add(key.toLowerCase());
	}
	for (const key of Object.keys(EXT_TO_LANG)) all.add(key.toLowerCase());
	for (const key of Object.keys(TREE_SITTER_EXT_TO_LANG)) {
		all.add(key.toLowerCase());
	}
	// read-expansion contributes no key of its own: it resolves through the same
	// registry ext -> grammar column as EXT_TO_LANG above. It used to re-export
	// that column's key set as `CODE_FILE_EXTENSIONS`, which had no production
	// consumer and is deleted (#2424 review, named output b).
	return [...all].sort();
}

/** Every consumer's answer for one sample path. */
export function describe(samplePath) {
	const kind = detectFileKind(samplePath);
	const extension = path.extname(samplePath).toLowerCase();
	return {
		kind: kind ?? null,
		kindLanguageId: kind ? getKindLanguageId(kind) : null,
		lspId: getLspLanguageId(samplePath) ?? null,
		treeSitterGrammar: EXT_TO_LANG[extension] ?? null,
		scannerGrammar: TREE_SITTER_EXT_TO_LANG[extension] ?? null,
		readExpansionLang: readExpansionLanguage(samplePath) ?? null,
		reviewGraphGrammar: mapKindToTreeSitterLanguage(kind, samplePath) ?? null,
		moduleReportGrammar: tsLangForFile(samplePath, kind) ?? null,
	};
}

// #2434's `SCAN_LANGUAGE_PRIORITY` directory-scan decision used to get its
// own `scanPriority` section here (extension -> first matching id), but that
// projection is ORDER-BLIND by construction: `extensionUnion()` gives every
// extension exactly ONE owning id (the registry has no two ids sharing an
// extension), so nothing in that section could ever depend on which id, or
// which FAMILY (#2458 fix-round F1), is tried first — the exact property a
// scan-priority regression changes. It could not have caught F1's coverage
// bug (or a reordering) and never did; dropped rather than kept as a
// snapshot that looks like coverage but isn't. The real guard is the
// dedicated `SCAN_LANGUAGE_PRIORITY (#2434 fold)` describe block in
// `tests/clients/language-registry-drift.test.ts`, which pins family AND
// intra-family id order directly, plus the exhaustive family-union
// regression coverage in
// `tests/tools/lsp-diagnostics-scan-family.test.ts`.

export function buildSnapshot() {
	const files = {};
	for (const extension of extensionUnion()) {
		files[extension] = describe(`sample${extension}`);
	}
	for (const filename of SPECIAL_FILENAME_SAMPLES) {
		files[filename] = describe(filename);
	}
	return {
		note: "Generated by scripts/gen-language-snapshot.mjs - do not hand-edit.",
		grammars: Object.keys(LANGUAGE_TO_GRAMMAR).sort(),
		files,
	};
}

function main() {
	const snapshot = `${JSON.stringify(buildSnapshot(), null, "\t")}\n`;
	if (process.argv.includes("--check")) {
		const current = fs.readFileSync(SNAPSHOT_PATH, "utf8");
		if (current !== snapshot) {
			process.stderr.write(
				`Language snapshot drifted from ${SNAPSHOT_PATH}.\n` +
					"Re-run: node scripts/gen-language-snapshot.mjs\n",
			);
			process.exit(1);
		}
		process.stdout.write("Language snapshot up to date.\n");
		return;
	}
	fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
	fs.writeFileSync(SNAPSHOT_PATH, snapshot);
	process.stdout.write(`Wrote ${SNAPSHOT_PATH}\n`);
}

if (isMainModule(import.meta.url)) {
	main();
}
