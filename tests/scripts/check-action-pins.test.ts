import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	parseActionPins,
	resolveGithubMatchingTags,
	resolveGithubTag,
	validatePins,
} from "../../scripts/check-action-pins.mjs";

const GOOD = "0057852bfaa89a56745cba8c7296529d2fc39830";
const BAD = "6849a6489940f00c2f30c0fb92c6274307ccb58a";
const FIXTURE = readFileSync(
	join(process.cwd(), "tests/fixtures/action-pins/sample.yml"),
	"utf8",
);

describe("check-action-pins parser (#4043)", () => {
	it("finds SHA pins, preserves paths, and ignores non-pinned uses", () => {
		const pins = parseActionPins(FIXTURE, "fixture.yml");
		expect(pins).toEqual([
			{
				action: "actions/cache/restore",
				sha: GOOD,
				tag: "v4.3.0",
				file: "fixture.yml",
				line: 2,
			},
			{
				action: "local/action",
				sha: BAD,
				tag: "",
				file: "fixture.yml",
				line: 4,
			},
		]);
	});

	it("reports the missing version comment that caused #4043", async () => {
		const pins = parseActionPins(`- uses: actions/cache@${BAD}`, "fixture.yml");
		await expect(validatePins(pins, async () => GOOD)).resolves.toEqual([
			`fixture.yml:1: actions/cache@${BAD} has no version comment`,
		]);
	});

	it("rejects the stale actions/cache SHA through the resolver seam", async () => {
		const pins = parseActionPins(
			`- uses: actions/cache@${BAD} # v4.3.0`,
			"fixture.yml",
		);
		await expect(validatePins(pins, async () => GOOD)).resolves.toEqual([
			`fixture.yml:1: actions/cache # v4.3.0 resolves to ${GOOD}, not ${BAD}`,
		]);
	});

	it("accepts a full semver comment only at its exact peeled release", async () => {
		const pins = parseActionPins(
			`- uses: actions/cache@${GOOD} # v4.3.0`,
			"fixture.yml",
		);
		await expect(validatePins(pins, async () => GOOD)).resolves.toEqual([]);
		await expect(validatePins(pins, async () => BAD)).resolves.toEqual([
			`fixture.yml:1: actions/cache # v4.3.0 resolves to ${BAD}, not ${GOOD}`,
		]);
	});

	it("accepts a major-only comment when a release tag carries the pin", async () => {
		const pins = parseActionPins(
			`- uses: actions/cache@${GOOD} # v4`,
			"fixture.yml",
		);
		await expect(
			validatePins(pins, async () => [
				{ tag: "v4.2.0", sha: GOOD },
				{ tag: "v4.3.0", sha: BAD },
			]),
		).resolves.toEqual([]);
	});

	it("rejects a major-only comment when no matching release carries the pin", async () => {
		const pins = parseActionPins(
			`- uses: actions/cache@${GOOD} # v4`,
			"fixture.yml",
		);
		await expect(
			validatePins(pins, async () => [{ tag: "v4.3.0", sha: BAD }]),
		).resolves.toEqual([
			`fixture.yml:1: actions/cache@${GOOD} is not a v4 release; nearest tags: v4.3.0`,
		]);
	});

	it("accepts a minor-only comment when a matching release carries the pin", async () => {
		const pins = parseActionPins(
			`- uses: actions/cache@${GOOD} # v4.3`,
			"fixture.yml",
		);
		await expect(
			validatePins(pins, async () => [{ tag: "v4.3.0", sha: GOOD }]),
		).resolves.toEqual([]);
	});

	it("peels an annotated tag at the GitHub API process boundary", async () => {
		const calls: string[] = [];
		const fetchImpl = async (input: string | URL | Request) => {
			calls.push(String(input));
			return calls.length === 1
				? new Response(
						JSON.stringify({ object: { type: "tag", sha: "tag-object" } }),
						{ status: 200 },
					)
				: new Response(JSON.stringify({ object: { sha: GOOD } }), {
						status: 200,
					});
		};
		expect(
			await resolveGithubTag("actions/cache", "v4.3.0", fetchImpl, {}),
		).toBe(GOOD);
		expect(calls).toEqual([
			"https://api.github.com/repos/actions/cache/git/ref/tags/v4.3.0",
			"https://api.github.com/repos/actions/cache/git/tags/tag-object",
		]);
	});

	it("resolves matching release refs and peels annotated releases", async () => {
		const calls: string[] = [];
		const fetchImpl = async (input: string | URL | Request) => {
			calls.push(String(input));
			return calls.length === 1
				? new Response(
						JSON.stringify([
							{ ref: "refs/tags/v6", object: { type: "commit", sha: BAD } },
							{
								ref: "refs/tags/v6.5.0",
								object: { type: "tag", sha: "tag-object" },
							},
						]),
						{ status: 200 },
					)
				: new Response(JSON.stringify({ object: { sha: GOOD } }), {
						status: 200,
					});
		};
		expect(
			await resolveGithubMatchingTags(
				"actions/setup-node",
				"v6",
				fetchImpl,
				{},
			),
		).toEqual([{ tag: "v6.5.0", sha: GOOD }]);
		expect(calls).toEqual([
			"https://api.github.com/repos/actions/setup-node/git/matching-refs/tags/v6.",
			"https://api.github.com/repos/actions/setup-node/git/tags/tag-object",
		]);
	});

	// Recurrence #4422 F3 (#4427): the three resolvers each built their own
	// header block until it moved to githubHeaders. These pin the behaviour the
	// move must keep: the token (GITHUB_TOKEN, else GH_TOKEN) goes out as a
	// Bearer header on every request of a peel, and an anonymous run sends none.
	describe("request headers", () => {
		const capture = () => {
			const seen: Array<Record<string, string>> = [];
			const fetchImpl = async (_input: unknown, init?: RequestInit) => {
				seen.push(init?.headers as Record<string, string>);
				return seen.length === 1
					? new Response(
							JSON.stringify([
								{ ref: "refs/tags/v6.5.0", object: { type: "tag", sha: "t" } },
							]),
							{ status: 200 },
						)
					: new Response(JSON.stringify({ object: { sha: GOOD } }), {
							status: 200,
						});
			};
			return { seen, fetchImpl };
		};

		it.each([
			["GITHUB_TOKEN", { GITHUB_TOKEN: "gh-tok" }, "Bearer gh-tok"],
			["GH_TOKEN", { GH_TOKEN: "cli-tok" }, "Bearer cli-tok"],
			[
				"GITHUB_TOKEN over GH_TOKEN",
				{ GITHUB_TOKEN: "gh-tok", GH_TOKEN: "cli-tok" },
				"Bearer gh-tok",
			],
		])(
			"sends %s as a Bearer header on both requests of a peel",
			async (_n, env, header) => {
				const { seen, fetchImpl } = capture();
				await resolveGithubMatchingTags(
					"actions/setup-node",
					"v6",
					fetchImpl,
					env,
				);
				expect(seen.map((headers) => headers.Authorization)).toEqual([
					header,
					header,
				]);
				expect(seen[0].Accept).toBe("application/vnd.github+json");
			},
		);

		it("sends no Authorization header without a token", async () => {
			const { seen, fetchImpl } = capture();
			await resolveGithubMatchingTags(
				"actions/setup-node",
				"v6",
				fetchImpl,
				{},
			);
			expect(seen).toHaveLength(2);
			for (const headers of seen) {
				expect(Object.keys(headers)).not.toContain("Authorization");
			}
		});

		// Recurrence: the single-tag resolver builds its own header from
		// `env.GITHUB_TOKEN || env.GH_TOKEN`, so swapping the operands there left
		// every row green while the matching-refs peel pinned the precedence.
		it.each([
			["GITHUB_TOKEN", { GITHUB_TOKEN: "gh-tok" }, "Bearer gh-tok"],
			["GH_TOKEN", { GH_TOKEN: "cli-tok" }, "Bearer cli-tok"],
			[
				"GITHUB_TOKEN over GH_TOKEN",
				{ GITHUB_TOKEN: "gh-tok", GH_TOKEN: "cli-tok" },
				"Bearer gh-tok",
			],
		])("sends %s on the single-tag resolver too", async (_n, env, header) => {
			const seen: Array<Record<string, string>> = [];
			const fetchImpl = async (_input: unknown, init?: RequestInit) => {
				seen.push(init?.headers as Record<string, string>);
				return new Response(JSON.stringify({ object: { sha: GOOD } }), {
					status: 200,
				});
			};
			await resolveGithubTag("actions/cache", "v4.3.0", fetchImpl, env);
			expect(seen[0].Authorization).toBe(header);
		});
	});
});
