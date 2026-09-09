import { escapeRegExp } from "./string-utils.js";

export type FeatureHintKind = "service" | "cli-command" | "library";

export type TrustBoundary =
	| "auth"
	| "database"
	| "external-api"
	| "filesystem"
	| "network"
	| "process-exec"
	| "serialization"
	| "user-input";

function normalizeHintInput(value: string): string {
	return value.replace(/\\/g, "/");
}

function hasHintToken(value: string, tokens: readonly string[]): boolean {
	const escaped = tokens.map((token) => escapeRegExp(token));
	const alternatives = escaped.join("|");
	// Path/word boundaries are deliberately explicit: a token must occupy a
	// segment (or a dot/dash/underscore-separated word), never an arbitrary
	// substring. The second expression preserves camelCase names such as
	// authStore and DatabaseClient without making `adb` match `db`.
	return (
		new RegExp(
			`(?:^|[/_.\\-\\s])(?:${alternatives})(?=[/_.\\-\\s]|$)`,
			"i",
		).test(value) ||
		new RegExp(
			`(?:^|(?<=[a-z0-9]))(?:${tokens
				.flatMap((token) => [
					token[0].toUpperCase() + token.slice(1),
					...(token === "openai" ? ["OpenAI"] : []),
					...(token === "github" ? ["GitHub"] : []),
					...(token === "gitlab" ? ["GitLab"] : []),
				])
				.join("|")})(?=[A-Z]|[/_.\\-\\s]|$)`,
		).test(value)
	);
}

/**
 * Deterministic feature-kind hint derived from package/entity/file names.
 * Inspired by clawpatch's packageKind() heuristic.
 */
export function inferFeatureKind(nameOrPath: string): FeatureHintKind {
	const normalized = normalizeHintInput(nameOrPath);
	if (
		hasHintToken(normalized, [
			"config",
			"store",
			"db",
			"database",
			"github",
			"openai",
			"sync",
			"service",
		])
	) {
		return "service";
	}
	if (/(^|[/_.\-\s])(cli|command|bin)([/_.\-\s]|$)/i.test(normalized)) {
		return "cli-command";
	}
	return "library";
}

/**
 * Deterministic trust-boundary hints derived from package/entity/file names.
 * These are advisory metadata for context injection, not security findings.
 */
export function inferTrustBoundaries(nameOrPath: string): TrustBoundary[] {
	const normalized = normalizeHintInput(nameOrPath);
	const boundaries = new Set<TrustBoundary>();

	if (
		hasHintToken(normalized, [
			"config",
			"store",
			"db",
			"database",
			"repo",
			"repository",
			"model",
			"migration",
		])
	) {
		boundaries.add("filesystem");
		boundaries.add("database");
	}
	if (
		hasHintToken(normalized, [
			"github",
			"gitlab",
			"openai",
			"anthropic",
			"stripe",
			"slack",
			"sync",
			"webhook",
			"api",
			"client",
		])
	) {
		boundaries.add("network");
		boundaries.add("external-api");
		boundaries.add("serialization");
	}
	if (
		/(^|[/_.\-\s])(cli|command|bin|exec|spawn|process|shell)([/_.\-\s]|$)/i.test(
			normalized,
		)
	) {
		boundaries.add("user-input");
		boundaries.add("process-exec");
	}
	if (
		hasHintToken(normalized, [
			"auth",
			"login",
			"token",
			"session",
			"oauth",
			"jwt",
		])
	) {
		boundaries.add("auth");
		boundaries.add("user-input");
	}

	return [...boundaries];
}

export function featureHintMetadata(nameOrPath: string): {
	featureKind: FeatureHintKind;
	trustBoundaries: TrustBoundary[];
} {
	return {
		featureKind: inferFeatureKind(nameOrPath),
		trustBoundaries: inferTrustBoundaries(nameOrPath),
	};
}
