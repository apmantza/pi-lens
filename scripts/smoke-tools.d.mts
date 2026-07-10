// Types for the (plain-JS) tool-smoke harness, so TS consumers — e.g. the
// smoke-fixture-coverage drift guard — can import its fixture arrays.
export interface SmokeFixture {
	lang: string;
	dir: string;
	file: string;
	targets?: string[];
	tools?: string[];
	expectDiagnostic?: boolean;
}
export interface LspFixture {
	lang: string;
	dir: string;
	file: string;
	serverHint: string;
	tools?: string[];
	/** Auxiliary (diagnostic-only) servers attached alongside the primary. */
	auxiliaryServerIds?: string[];
	auxiliarySourceMatch?: string;
	gitInit?: boolean;
	clean?: boolean;
	lombokJar?: boolean;
	expectNoMessageMatch?: string;
	disableServers?: string[];
	expectServerId?: string;
	expectSourceMatch?: string;
}
export interface FormatFixture {
	lang: string;
	dir: string;
	file: string;
	formatter: string;
	tools?: string[];
}
export interface AutofixFixture {
	lang: string;
	dir: string;
	file: string;
	tool: string;
	tools?: string[];
}
export const FIXTURES: SmokeFixture[];
export const LSP_FIXTURES: LspFixture[];
export const FORMAT_FIXTURES: FormatFixture[];
export const AUTOFIX_FIXTURES: AutofixFixture[];
