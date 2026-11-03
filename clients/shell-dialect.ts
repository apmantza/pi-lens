import * as fs from "node:fs";
import * as path from "node:path";

/**
 * ShellCheck's supported linter dialects, pinned per defect shape 16 to
 * `bash-lsp/bash-language-server@server-5.8.1`
 * `server/src/shellcheck/config.ts` (`SHELLCHECK_DIALECTS`). A dialect
 * outside this set cannot be analyzed at all — ShellCheck refuses it
 * outright (SC1071) and, where zsh code happens to parse under bash
 * semantics, reports findings built on the wrong dialect.
 */
export const SHELLCHECK_SUPPORTED_DIALECTS: readonly string[] = [
	"sh",
	"bash",
	"dash",
	"ksh",
	"busybox",
] as const;

export function isShellcheckDialectSupported(dialect: string): boolean {
	return SHELLCHECK_SUPPORTED_DIALECTS.includes(dialect);
}

/**
 * True only for a resolved `zsh` dialect. The Bash language server's file
 * filter uses this narrow predicate, not the ShellCheck set above: the LSP lane
 * stays as it was for every other dialect (#3968 AC1) and only zsh, which the
 * server's analyzer refuses, is kept out (#5230).
 */
export function isZshDialect(dialect: string): boolean {
	return dialect === "zsh";
}

// Upstream shebang/directive parsing, pinned to
// `bash-lsp/bash-language-server@server-5.8.1` `server/src/util/shebang.ts`
// (defect shape 16 — test vectors generated from the real binary, not invented):
const SHEBANG_REGEXP = /^#!(.+)/;
// `/path/to/env [-S] <shell>` or `/path/to/<shell>`; takes the interpreter NAME.
const SHEBANG_INTERPRETER_REGEXP =
	/^[/](?:[^ /]+[/])*(?:env +(?:-S +)?)?([^ /]+)/;
// The first continuous run of blank/comment lines may carry a
// `shellcheck shell=<dialect>` directive (blanked comment lines keep the
// region open; any code line closes it).
const SHELLCHECK_SHELL_OR_EMPTY_REGEXP =
	/^\s*(?:#\s*shellcheck\s+(?:\S+\s+)*shell=(\w+)|#|$)/;
/** How many leading bytes dialect resolution inspects. */
const DIALECT_SNIFF_BYTES = 4096;

/** Dialect facts for a shell file, mirroring upstream `analyzeFile`'s shape. */
export interface ShellFileDialect {
	/** The parsed shebang interpreter name, or null. */
	shebang: string | null;
	/** The parsed `shellcheck shell=` directive value, or null. */
	directive: string | null;
	/** The resolved dialect name (defaults to bash, as upstream does). */
	dialect: string;
}

function parseShebang(content: string): string | null {
	const match = SHEBANG_REGEXP.exec(content);
	if (!match || !match[1]) return null;
	const interpreter = SHEBANG_INTERPRETER_REGEXP.exec(match[1].trim());
	if (!interpreter || !interpreter[1]) return null;
	return interpreter[1].trim();
}

function parseShellDirective(content: string): string | null {
	for (const line of content.split("\n")) {
		const match = SHELLCHECK_SHELL_OR_EMPTY_REGEXP.exec(line);
		// A code line closes the eligible region (upstream's rule).
		if (match === null) break;
		if (match[1]) return match[1].trim();
	}
	return null;
}

/**
 * Resolve a shell file's dialect: `shellcheck shell=` directive, then
 * shebang, then a file extension that carries one (upstream's `parseUri`
 * maps only `.zsh` to a name), defaulting to bash. Resolved against the
 * file's CURRENT bytes; an unreadable file fails open with the bash default
 * (pre-fix behavior — shape 48: the named harm of skipping would be silent
 * coverage loss, so we lint and let the spawn disclose).
 */
export function resolveShellFileDialect(filePath: string): ShellFileDialect {
	let content: string;
	try {
		const fd = fs.openSync(filePath, "r");
		try {
			const head = Buffer.alloc(DIALECT_SNIFF_BYTES);
			const bytesRead = fs.readSync(fd, head, 0, DIALECT_SNIFF_BYTES, 0);
			content = head.subarray(0, bytesRead).toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		// none: best-effort sniffing retains the bash default instead of dropping coverage.
		return { shebang: null, directive: null, dialect: "bash" };
	}
	const directive = parseShellDirective(content);
	const shebang = parseShebang(content);
	// Selection lower-cases the extension (`selectionReason`), so the
	// extension arm matches case-insensitively too — a `.ZSH` file must not
	// slip through to the bash fallback.
	const parsed =
		directive ??
		shebang ??
		(path.extname(filePath).toLowerCase() === ".zsh" ? "zsh" : null);
	return {
		shebang,
		directive,
		dialect: parsed ?? "bash",
	};
}
