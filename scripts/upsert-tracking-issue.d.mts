export function main(
	argv?: string[],
	gh?: (args: string[]) => string,
): {
	action: "created" | "updated" | "closed" | "no-action";
	issueNumber?: number;
};
