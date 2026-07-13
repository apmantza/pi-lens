import type { FactRule } from "../fact-provider-types.js";
import type { Diagnostic } from "../types.js";

/**
 * cors-wildcard — Access-Control-Allow-Origin: * (TS/JS/Python/Go). Regex/line-based
 * (no compiler); formerly SN-004 in the SonarJS-inspired batch (#402).
 */
export const corsWildcardRule: FactRule = {
	id: "cors-wildcard",
	requires: ["file.content"],
	appliesTo(ctx) {
		return /\.(tsx?|py|go)$/.test(ctx.filePath);
	},
	evaluate(ctx, store) {
		const content = store.getFileFact<string>(ctx.filePath, "file.content");
		if (!content) return [];
		const diagnostics: Diagnostic[] = [];

		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (/^\s*(?:\/\/|\*|#|\/)/.test(line)) continue;
			const isWildcard =
				// TS/JS: header assignment or cors() call
				(/["']Access-Control-Allow-Origin["']/.test(line) &&
					/["']\*["']/.test(line)) ||
				/origin\s*:\s*["']\*["']/.test(line) ||
				(/cors\s*\(/.test(line) && /\*/.test(line)) ||
				// Python (FastAPI CORSMiddleware / Flask-CORS):
				// wildcard allow_origins/origins assignment
				/(?:allow_origins|origins)\s*=\s*["']\*["']/.test(line) ||
				// wildcard allow_origins/origins array assignment
				/(?:allow_origins|origins)\s*=\s*[[(]["']\*["']/.test(line) ||
				// Go (gin-cors, chi-cors, gorilla):
				// AllowAllOrigins enabled
				/AllowAllOrigins\s*:\s*true/.test(line) ||
				// wildcard AllowOrigins/AllowedOrigins slice
				// Use [^*\n]{0,60} instead of .* to prevent super-linear backtracking
				/Allow(?:ed)?Origins[^*\n]{0,60}\*/.test(line);

			if (isWildcard) {
				diagnostics.push({
					id: `cors-wildcard:${ctx.filePath}:${i + 1}`,
					tool: "fact-rules",
					rule: "cors-wildcard",
					filePath: ctx.filePath,
					line: i + 1,
					column: 1,
					severity: "error",
					semantic: "blocking",
					message:
						"CORS wildcard origin (*) allows any website to make credentialed requests — restrict to known origins",
				});
			}
		}
		return diagnostics;
	},
};
