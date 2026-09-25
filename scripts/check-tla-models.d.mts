export type TlcVerdict =
	| { status: "pass" }
	| { status: "violated"; invariant: string }
	| { status: "error"; detail: string };
export type ExpectedVerdict =
	| { status: "pass" }
	| { status: "violated"; invariant: string };
export declare const TLA_TOOLS: Readonly<{
	release: string;
	url: string;
	sha256: string;
}>;
export declare function parseModelHeader(
	text: string,
): { module: string; expect: ExpectedVerdict } | { error: string };
export declare function classifyTlcOutput(output: string): TlcVerdict;
export declare function verdictMatches(
	expected: ExpectedVerdict,
	actual: TlcVerdict,
): boolean;
export declare function describeVerdict(verdict: TlcVerdict): string;
export declare function listModelConfigs(root: string): string[];
export declare function resolveJarPath(
	jarArg: string | undefined,
	root: string,
): string;
