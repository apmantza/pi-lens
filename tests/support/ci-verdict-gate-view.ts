// #5629: ci-verdict reads the PR's `statusCheckRollup` (the view GitHub's merge
// gate reads) before it prints green. A `gh` double that answers `gh pr view`
// for a green head spreads this into its reply, the way `gh` returns the
// rollup of a PR whose own runs posted the required names.
export const greenGateView = (
	names: readonly string[] = ["Unit tests", "Lint & type-check"],
) => ({
	statusCheckRollup: names.map((name) => ({
		__typename: "CheckRun",
		name,
		status: "COMPLETED",
		conclusion: "SUCCESS",
	})),
});
