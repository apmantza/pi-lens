function resolveValue(
	value: string,
	action: string,
	runId: string,
	eventName = "pull_request",
): string | boolean {
	const trimmed = value.trim();
	if (trimmed === "'edited'" || trimmed === '"edited"') return "edited";
	if (trimmed === "'pull_request'" || trimmed === '"pull_request"')
		return "pull_request";
	if (trimmed === "'default'" || trimmed === '"default"') return "default";
	if (trimmed === "''" || trimmed === '""') return "";
	const quoted = trimmed.match(/^(?:'([^']*)'|"([^"]*)")$/);
	if (quoted) return quoted[1] ?? quoted[2] ?? "";
	if (trimmed === "github.event.action") return action;
	if (trimmed === "github.event_name") return eventName;
	if (trimmed === "github.event.pull_request.number") return "42";
	if (trimmed === "github.ref") return "refs/pull/42/merge";
	if (trimmed === "github.event.client_payload.sha") return "dispatch-sha";
	if (trimmed === "github.run_id") return runId;
	return false;
}

function evaluateTerm(
	term: string,
	action: string,
	runId: string,
	eventName: string,
	strict = false,
): string | boolean {
	const trimmed = term.trim();
	if (trimmed === "true" || trimmed === "false") return trimmed === "true";
	const equality = trimmed.match(
		/^github\.event_name\s*(==|!=)\s*(['"])([^'"]*)\2$/,
	);
	if (equality)
		return equality[1] === "=="
			? eventName === equality[3]
			: eventName !== equality[3];
	if (strict)
		throw new Error(`unsupported workflow expression term: ${trimmed}`);
	const parts = trimmed.split("==").map((part) => part.trim());
	if (parts.length === 2)
		return (
			resolveValue(parts[0], action, runId, eventName) ===
			resolveValue(parts[1], action, runId, eventName)
		);
	return resolveValue(trimmed, action, runId, eventName);
}

export function evaluateExpression(
	expression: string,
	action: string,
	runId: string,
	eventName = "pull_request",
	strict = false,
): string | boolean {
	for (const alternative of expression.split("||")) {
		const conjunction = alternative
			.split("&&")
			.map((term) => evaluateTerm(term, action, runId, eventName, strict));
		const value = conjunction.reduce<string | boolean>(
			(left, right) => (left ? right : left),
			true,
		);
		if (value) return value;
	}
	return "";
}

export function evaluateGroup(
	group: string,
	action: string,
	runId: string,
	eventName = "pull_request",
): string {
	return group.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_, expression: string) =>
		String(evaluateExpression(expression, action, runId, eventName)),
	);
}

export function evaluateCancelInProgress(
	value: unknown,
	eventName: string,
): boolean {
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	if (typeof value !== "string")
		throw new Error("cancel-in-progress must be boolean or expression");
	const expression = value.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");
	return Boolean(
		evaluateExpression(expression, "opened", "run", eventName, true),
	);
}
