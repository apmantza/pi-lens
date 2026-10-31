import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	lintLocalPrBody,
	lintPullRequestEvent,
	referencedIssues,
	resolveBugClosing,
	resolveBugClosingViaGh,
	resolveBugReferenced,
} from "../../scripts/check-pr-body.mjs";

// Recurrence (#4968): the detection audit of 2026-10-29 found 24 bug-linked PRs
// merged in one week with no `## Detection` section, because each said
// `Refs #N` where the lint only read `Closes`/`Fixes`/`Resolves`. #4769 and
// #4808 were p2 external-bug fixes with no lesson recorded. The rule is keyed
// on the issue's LABEL (`bug`, `nightly-drift`), not on the keyword, and it
// refuses where it cannot read the label or cannot parse the reference.
//
// Closing-PR behaviour is unchanged and pinned by the #4288 suites in
// check-pr-body.test.ts; this file owns the reference-only seam.
const base = (summary: string, tail = "") =>
	[
		"## Why",
		"The body gate records the detection lesson.",
		"",
		"## Notes for the reviewer",
		"- None.",
		"",
		"## Change outline",
		"- scripts/check-pr-body.mjs",
		"",
		"## Summary",
		summary,
		"",
		"## Proof and checks",
		"The proof sections follow.",
		"",
		"## Tests",
		"Targeted tests pass.",
		"",
		"## Blast radius",
		"No runtime module touched.",
		"",
		"## Class sweep",
		'Defect shape: a gate keyed on the keyword. Search: `rg -n "bugClosing" scripts`. Verdict: stay specific.',
		"Alignment: none: this fixture touches no family.",
		"",
		"## Fold check",
		"none: the search listed no candidate",
		"",
		"## Observability",
		"No new failure path; no record added.",
		tail,
	].join("\n");
const detection = (shape = "new: stale mirror", enforcer = "#4439") =>
	`\n## Detection\n\nCaught by: external user\nShould have been caught by: CI unit\nGap: none: no layer would have seen it\nShape: ${shape}\nEnforcer: ${enforcer}\n`;
const refsOnly = base("Fixes the reader. Refs #4321 for the rest.");
// Recurrence (#4968 F1): merged PR #4924 carried `(refs #4532)` in its title and
// named the bug in its body only as `Part (a) of #4532 gap 13 only`, a form no
// keyword list reads. #4532 is `bug`, and #4924 merged with no `## Detection`.
const title4924 =
	"fix: sweep held-document drift before lsp answers (refs #4532)";
const body4924 = base(
	"Part (a) of #4532 gap 13 only: files pi (the language server) already holds. Files pi does NOT hold (part (b)) are a separate lane; `clients/out-of-band-changes.ts` is untouched.",
);
const noGit = (() => "") as never;

describe("referencedIssues (#4968)", () => {
	it.each([
		["Refs #12", [12]],
		["refs: #12", [12]],
		["REFS #12, #13 and #14", [12, 13, 14]],
		["- **Refs** #12", [12]],
		["> Refs #12", [12]],
		["Fixes #12", [12]],
		["Resolved GH-12", [12]],
		["Ref #12", [12]],
		// A wrapped reference: the keyword or a trailing comma ends the line.
		["Otherwise Refs\n#12 and the rest.", [12]],
		["Refs #11,\n#12", [11, 12]],
		["Refs #11, #13 and\n#12", [11, 13, 12]],
		["Refs #11.\n#12 is unrelated.", [11]],
		["The fix (refs: [#12](https://example.test/i/12)) lands.", [12]],
		["Landed with refs - #12.", [12]],
		["Landed with **refs** **#12**.", [12]],
		["References #12", [12]],
		["Refs the audit in #12", [12]],
		["The change (refs #12) lands here.", [12]],
		["See Refs #12 and #13 and Closes #14", [12, 13, 14]],
		["No keyword mentions #12 here.", []],
		["```\nRefs #12\n```", []],
		// Quoted material in a fence is not a reference; an inline code span is
		// (fail closed: `Refs` before a code-spanned number still names it).
		["Refs `#12`", [12]],
		["Use `Refs #12` for a remainder.", [12]],
		["Refs the template placeholder #NNN", []],
		// Recurrence: PR 4641 opened a bullet with the verb "Fix" and linked a
		// review comment; a URL after the keyword's own span is prose.
		[
			"- Fix round 1 answers review [F1](https://github.com/o/r/pull/9#issuecomment-1).",
			[],
		],
	])("reads %j as %j", (text, expected) => {
		expect(referencedIssues(text)).toEqual({
			issues: expected,
			unrecognised: [],
		});
	});

	// A form the reader cannot turn into this repository's `#N` is returned for
	// the gate to refuse, never skipped (fails closed).
	it.each([
		["Refs owner/repo#12", "owner/repo#12"],
		[
			"Refs: https://github.com/o/r/issues/12",
			"https://github.com/o/r/issues/12",
		],
		["Closes https://github.com/o/r/pull/9", "https://github.com/o/r/pull/9"],
		// A link destination behind the keyword is still a reference.
		[
			"Refs [the bug](https://github.com/o/r/issues/12).",
			"https://github.com/o/r/issues/12",
		],
		["Refs\nowner/repo#12", "owner/repo#12"],
		// The destination reached through a definition, and mid-line.
		[
			"Refs [the bug][1]\n\n[1]: https://github.com/o/r/issues/12",
			"https://github.com/o/r/issues/12",
		],
		[
			"Refs [bug]\n\n[bug]: https://github.com/o/r/issues/12",
			"https://github.com/o/r/issues/12",
		],
		[
			"Landed (refs [the bug](https://github.com/o/r/issues/12)).",
			"https://github.com/o/r/issues/12",
		],
	])("returns %j as unrecognised", (text, token) => {
		expect(referencedIssues(text)).toEqual({
			issues: [],
			unrecognised: [token],
		});
	});
});

describe("resolveBugReferenced (#4968)", () => {
	const labelFetch = (names: string[]) =>
		vi
			.fn()
			.mockImplementation(
				async () =>
					new Response(
						JSON.stringify({ labels: names.map((name) => ({ name })) }),
						{ status: 200 },
					),
			);
	beforeEach(() => {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
	});
	afterEach(() => vi.unstubAllEnvs());

	it.each([["bug"], ["nightly-drift"]])(
		"is true for a %s label",
		async (name) => {
			expect(await resolveBugReferenced(refsOnly, labelFetch([name]))).toBe(
				true,
			);
		},
	);

	it("is false for a label that is neither", async () => {
		expect(
			await resolveBugReferenced(refsOnly, labelFetch(["enhancement"])),
		).toBe(false);
	});

	it("is false and never fetches when nothing is referenced", async () => {
		const fetchImpl = vi.fn();
		expect(await resolveBugReferenced(base("A plain change."), fetchImpl)).toBe(
			false,
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("reads only the issues the body does not close", async () => {
		const fetchImpl = labelFetch(["enhancement"]);
		await resolveBugReferenced(base("Closes #11. Refs #12."), fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(String(fetchImpl.mock.calls[0][0])).toContain("/issues/12");
	});

	it("is null on a failed read", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("denied", { status: 500 }));
		expect(await resolveBugReferenced(refsOnly, fetchImpl)).toBe(null);
	});

	it("is null with no API credentials", async () => {
		vi.stubEnv("GITHUB_TOKEN", "");
		expect(await resolveBugReferenced(refsOnly, labelFetch(["bug"]))).toBe(
			null,
		);
	});

	it("is null for a reference form it cannot read, without fetching", async () => {
		const fetchImpl = labelFetch(["enhancement"]);
		expect(
			await resolveBugReferenced(base("Refs owner/repo#12."), fetchImpl),
		).toBe(null);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	// The title channel (#4968 F1): the template makes the title carry the
	// issue, so a bug named there owes the lesson whatever the body's wording.
	it("reads a bug named only in the title (PR #4924)", async () => {
		expect(
			await resolveBugReferenced(body4924, labelFetch(["bug"]), title4924),
		).toBe(true);
		expect(await resolveBugReferenced(body4924, labelFetch(["bug"]))).toBe(
			false,
		);
	});

	it("reads a nightly-drift issue named in the title", async () => {
		expect(
			await resolveBugReferenced(
				base("A plain change."),
				labelFetch(["nightly-drift"]),
				"fix: tidy (refs #12)",
			),
		).toBe(true);
	});

	it("is false for a title issue that is not a bug", async () => {
		expect(
			await resolveBugReferenced(
				body4924,
				labelFetch(["enhancement"]),
				title4924,
			),
		).toBe(false);
	});

	it("reads an issue the title and the body both name once", async () => {
		const fetchImpl = labelFetch(["enhancement"]);
		await resolveBugReferenced(
			base("Refs #12."),
			fetchImpl,
			"fix: tidy (refs #12)",
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("leaves an issue the body closes to the closing route", async () => {
		const fetchImpl = labelFetch(["bug"]);
		expect(
			await resolveBugReferenced(
				base("Closes #12."),
				fetchImpl,
				"fix: tidy (closes #12)",
			),
		).toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("is null when the title issue's label cannot be read", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("denied", { status: 500 }));
		expect(await resolveBugReferenced(body4924, fetchImpl, title4924)).toBe(
			null,
		);
	});

	it("does not read a number in a title that has none", async () => {
		const fetchImpl = labelFetch(["bug"]);
		expect(
			await resolveBugReferenced(
				base("A plain change."),
				fetchImpl,
				"docs: tidy v4.4 notes for owner/repo#12 and 2026-10-29",
			),
		).toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("ignores a reference behind a bot block", async () => {
		const fetchImpl = labelFetch(["bug"]);
		const text = `${base("A plain change.")}\n\n<!-- greptile -->\nLast reviewed commit (refs #77)\n`;
		expect(await resolveBugReferenced(text, fetchImpl)).toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("a PR that only references a bug issue (#4968)", () => {
	const eventFetch = (
		labels: string[] | "fail",
		text: string,
		liveTitle?: string,
	) =>
		vi.fn().mockImplementation(async (url: string) => {
			if (String(url).includes("/files"))
				return new Response(JSON.stringify([]), { status: 200 });
			if (String(url).includes("/issues/"))
				return labels === "fail"
					? new Response("denied", { status: 500 })
					: new Response(
							JSON.stringify({ labels: labels.map((name) => ({ name })) }),
							{ status: 200 },
						);
			return new Response(JSON.stringify({ body: text, title: liveTitle }), {
				status: 200,
			});
		});
	const runEvent = async (
		text: string,
		labels: string[] | "fail",
		title?: string,
		liveTitle?: string,
	) => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = await lintPullRequestEvent(
				eventFetch(labels, text, liveTitle),
				{ pull_request: { number: 4968, body: text, title } },
				() => "",
			);
			return {
				result,
				errors: errors.mock.calls.flat().join("\n"),
				warnings: warnings.mock.calls.flat().join("\n"),
			};
		} finally {
			errors.mockRestore();
			warnings.mockRestore();
		}
	};
	beforeEach(() => {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
		vi.stubEnv("GITHUB_ACTIONS", "true");
	});
	afterEach(() => vi.unstubAllEnvs());

	it("CI reds a Refs-only bug body that has no Detection section", async () => {
		const run = await runEvent(refsOnly, ["bug"]);
		expect(run.result.valid).toBe(false);
		expect(run.errors).toContain('missing "## Detection"');
	});

	it("CI reds a nightly-drift reference too", async () => {
		const run = await runEvent(refsOnly, ["nightly-drift"]);
		expect(run.result.valid).toBe(false);
		expect(run.errors).toContain('missing "## Detection"');
	});

	it("CI passes a Refs-only bug body with a complete Detection section", async () => {
		const run = await runEvent(`${refsOnly}\n${detection()}`, ["bug"]);
		expect(run.errors).toBe("");
		expect(run.result.valid).toBe(true);
	});

	// The audit's blank and absent Shape/Enforcer lines (#4860, #4863 had none;
	// #4771 a stub name): each reds on the reference seam like on a closing PR.
	it.each([
		["a blank Shape", detection("", "#4439")],
		["an unnamed new Shape", detection("new:", "#4439")],
		["a blank Enforcer", detection("new: stale mirror", "")],
		[
			"no Shape or Enforcer line",
			"\n## Detection\n\nCaught by: dogfood\nShould have been caught by: this layer\nGap: none: docs only\n",
		],
	])("CI reds %s on a Refs-only bug body", async (_name, section) => {
		const run = await runEvent(`${refsOnly}\n${section}`, ["bug"]);
		expect(run.result.valid).toBe(false);
		expect(run.errors).toContain('"## Detection"');
	});

	it("CI refuses an unknown answer on a referenced bug", async () => {
		const run = await runEvent(
			`${refsOnly}\n${detection("new: stale mirror", "#4439").replace("external user", "unknown")}`,
			["bug"],
		);
		expect(run.result.valid).toBe(false);
		expect(run.errors).toContain("not a detection lesson");
	});

	it("CI passes a Refs-only body for a non-bug issue", async () => {
		const run = await runEvent(refsOnly, ["enhancement"]);
		expect(run.result.valid).toBe(true);
	});

	it("CI refuses when the referenced label cannot be read", async () => {
		const run = await runEvent(refsOnly, "fail");
		expect(run.result.valid).toBe(false);
		expect(run.errors).toMatch(/#4321.*could not be read/s);
	});

	it("CI refuses a reference form it cannot resolve", async () => {
		const run = await runEvent(base("Refs owner/repo#12."), ["enhancement"]);
		expect(run.result.valid).toBe(false);
		expect(run.errors).toContain("owner/repo#12");
	});

	// Recurrence guarded (#4976 CodeRabbit thread): a PR that closes a bug owes
	// the full section already, so a cross-repository `Refs` beside it changes no
	// requirement. Refusing it would redden a legitimate upstream citation
	// (#4755 cites hashicorp/vscode-...#N) for a label read the verdict never uses.
	it("CI passes a bug-closing PR that also cites an upstream issue", async () => {
		const closing = base("Closes #4321. Refs owner/repo#12 upstream.");
		const run = await runEvent(`${closing}\n${detection()}`, ["bug"]);
		expect(run.errors).toBe("");
		expect(run.result.valid).toBe(true);
	});

	it("CI still reds that bug-closing PR when the section is missing", async () => {
		const run = await runEvent(
			base("Closes #4321. Refs owner/repo#12 upstream."),
			["bug"],
		);
		expect(run.result.valid).toBe(false);
		expect(run.errors).toContain('missing "## Detection"');
		expect(run.errors).not.toContain("cannot be judged");
	});

	it("CI reds a bug named only in the title (PR #4924)", async () => {
		const run = await runEvent(body4924, ["bug"], title4924);
		expect(run.result.valid).toBe(false);
		expect(run.errors).toContain('missing "## Detection"');
	});

	it("CI passes a title-named bug with a complete Detection section", async () => {
		const run = await runEvent(
			`${body4924}\n${detection()}`,
			["bug"],
			title4924,
		);
		expect(run.errors).toBe("");
		expect(run.result.valid).toBe(true);
	});

	// Recurrence (#4976 CodeRabbit thread, the #2083 shape): "Re-run jobs"
	// replays the opened-event payload, so a title edited afterwards is stale
	// there. The body already came from the live PR; the title read from the
	// payload judged a title the author no longer has.
	it("CI reads a bug added to the title after the event", async () => {
		const run = await runEvent(
			body4924,
			["bug"],
			"fix: sweep held-document drift before lsp answers",
			title4924,
		);
		expect(run.result.valid).toBe(false);
		expect(run.errors).toContain('missing "## Detection"');
	});

	it("CI drops a bug removed from the title after the event", async () => {
		const run = await runEvent(
			body4924,
			["bug"],
			title4924,
			"fix: sweep held-document drift before lsp answers",
		);
		expect(run.errors).toBe("");
		expect(run.result.valid).toBe(true);
	});

	// The same live title reaches the refusal for an unreadable label and the
	// `refactor:` gate of lintPrBody (a retitle to refactor owes a table).
	it("CI refuses a label it cannot read for a bug added to the title", async () => {
		const run = await runEvent(
			body4924,
			"fail",
			"fix: sweep held-document drift before lsp answers",
			title4924,
		);
		expect(run.result.valid).toBe(false);
		expect(run.errors).toMatch(/#4532.*could not be read/s);
	});

	it("CI applies the refactor gate to a title retitled after the event", async () => {
		const run = await runEvent(
			body4924,
			["enhancement"],
			"fix: sweep held-document drift (refs #4532)",
			"refactor: sweep held-document drift (refs #4532)",
		);
		expect(run.result.valid).toBe(false);
		expect(run.errors).toContain("Behavior equivalence");
	});

	// F2: CI has the token, so an unreadable label refuses there. The message
	// does not tell the author to rewrite a reference that was already readable.
	it("CI refuses a title issue whose label cannot be read", async () => {
		const run = await runEvent(body4924, "fail", title4924);
		expect(run.result.valid).toBe(false);
		expect(run.errors).toMatch(/#4532.*could not be read/s);
		expect(run.errors).not.toContain("Write each reference");
	});

	it("CI tells the author to rewrite a reference it cannot read", async () => {
		const run = await runEvent(base("Refs owner/repo#12."), ["enhancement"]);
		expect(run.errors).toContain('Write each reference as "Refs #N"');
	});

	// F7: the unknown refusal also binds a PR that only references the bug.
	it("CI names a referenced bug in the unknown refusal", async () => {
		const run = await runEvent(
			`${refsOnly}\n${detection().replace("external user", "unknown")}`,
			["bug"],
		);
		expect(run.errors).not.toContain("a bug-closing PR names");
		expect(run.errors).toContain("closes or references a bug");
	});

	// F3: #4968 names `nightly-drift` for Closes too; 17 of 20 nightly-drift
	// issues carry no `bug` label, so a bug-only closing route left them out.
	it("CI reds a Closes of a nightly-drift-only issue", async () => {
		const run = await runEvent(base("Closes #4321."), ["nightly-drift"]);
		expect(run.result.valid).toBe(false);
		expect(run.errors).toContain('missing "## Detection"');
	});

	// The closing path is unchanged: an unreadable closed-issue label still
	// warns and skips (#4288), so a closing-only PR is not newly refused.
	it("CI keeps warn-and-skip for an unreadable closed issue", async () => {
		const run = await runEvent(base("Closes #4321."), "fail");
		expect(run.result.valid).toBe(true);
		expect(run.warnings).toContain("could not read the closed issue label");
	});
});

describe("the local preflight reads a referenced bug (#4968)", () => {
	it("reds a Refs-only body whose reference is a bug", () => {
		const result = lintLocalPrBody(refsOnly, process.cwd(), noGit, {
			bugClosing: false,
			bugReferenced: true,
		});
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain('missing "## Detection"');
	});

	it("passes a Refs-only body with a complete Detection section", () => {
		const result = lintLocalPrBody(
			`${refsOnly}\n${detection()}`,
			process.cwd(),
			noGit,
			{ bugClosing: false, bugReferenced: true },
		);
		expect(result.errors).toEqual([]);
	});

	it("passes a Refs-only body for a non-bug reference", () => {
		const result = lintLocalPrBody(refsOnly, process.cwd(), noGit, {
			bugClosing: false,
			bugReferenced: false,
		});
		expect(result.errors).toEqual([]);
	});

	// F2: a worker without gh (a write-confined sandbox) cannot read a label.
	// Locally that warns and skips, as the closing route does; CI, which has the
	// token, refuses (pinned above). Before, every `Refs #N` body reddened offline.
	const localWarnings = (run: () => unknown) => {
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			run();
			return warnings.mock.calls.flat().join("\n");
		} finally {
			warnings.mockRestore();
		}
	};

	it("warns and skips when the referenced label is unreadable", () => {
		let result: ReturnType<typeof lintLocalPrBody> | undefined;
		const warned = localWarnings(() => {
			result = lintLocalPrBody(refsOnly, process.cwd(), noGit, {
				bugClosing: false,
				bugReferenced: null,
			});
		});
		expect(result?.errors).toEqual([]);
		expect(result?.valid).toBe(true);
		expect(warned).toMatch(/could not read the label of #4321.*skipped/s);
	});

	it("warns and skips when the caller supplies no label reader at all", () => {
		let result: ReturnType<typeof lintLocalPrBody> | undefined;
		const warned = localWarnings(() => {
			result = lintLocalPrBody(refsOnly, process.cwd(), noGit, {
				bugClosing: false,
			});
		});
		expect(result?.valid).toBe(true);
		expect(warned).toContain("#4321");
	});

	// The skip covers the label read only. A reference the reader cannot turn
	// into `#N` needs no network, so it still refuses offline.
	it("still refuses a reference form it cannot read when labels are unreadable", () => {
		const result = lintLocalPrBody(
			base("Refs owner/repo#12."),
			process.cwd(),
			noGit,
			{ bugClosing: false, bugReferenced: null },
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("owner/repo#12");
		expect(result.errors.join(" ")).toContain(
			'Write each reference as "Refs #N"',
		);
	});

	it("hands the whole body and the title to an injected reader", () => {
		const resolve = vi.fn().mockReturnValue(false);
		const result = lintLocalPrBody(body4924, process.cwd(), noGit, {
			bugClosing: false,
			resolveBugReferenced: resolve,
			title: title4924,
		});
		expect(resolve).toHaveBeenCalledWith(body4924, title4924);
		expect(result.errors).toEqual([]);
	});

	// F4: the light validator runs only when no route already required the
	// section. A referenced bug with an `unknown` answer is reported once.
	it("reports an unknown answer on a referenced bug once", () => {
		const result = lintLocalPrBody(
			`${refsOnly}\n${detection().replace("external user", "unknown")}`,
			process.cwd(),
			noGit,
			{ bugClosing: false, bugReferenced: true },
		);
		const detectionErrors = result.errors.filter((error) =>
			error.includes('"## Detection"'),
		);
		expect(detectionErrors).toHaveLength(1);
		expect(detectionErrors[0]).toContain("not a detection lesson");
	});

	it("does not read references when the body already closes a bug", () => {
		const resolve = vi.fn();
		lintLocalPrBody(
			`${base("Closes #4320. Refs #4321.")}\n${detection()}`,
			process.cwd(),
			noGit,
			{ bugClosing: true, resolveBugReferenced: resolve },
		);
		expect(resolve).not.toHaveBeenCalled();
	});
});

// F3 (#4968): the closing route reads the same label list as a reference. A
// `Closes` of a nightly-drift-only issue owed no section before.
describe("the closing route reads nightly-drift (#4968)", () => {
	const labelFetch = (names: string[]) =>
		vi
			.fn()
			.mockImplementation(
				async () =>
					new Response(
						JSON.stringify({ labels: names.map((name) => ({ name })) }),
						{ status: 200 },
					),
			);
	beforeEach(() => {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
	});
	afterEach(() => vi.unstubAllEnvs());

	it("resolveBugClosing is true for a nightly-drift label", async () => {
		expect(
			await resolveBugClosing("Closes #12.", labelFetch(["nightly-drift"])),
		).toBe(true);
	});

	it("resolveBugClosingViaGh is true for a nightly-drift label", async () => {
		const exec = vi
			.fn()
			.mockReturnValue(JSON.stringify({ labels: [{ name: "nightly-drift" }] }));
		expect(
			await resolveBugClosingViaGh("Closes #12.", process.cwd(), exec as never),
		).toBe(true);
	});

	it("resolveBugClosing stays false for an unrelated label", async () => {
		expect(
			await resolveBugClosing("Closes #12.", labelFetch(["enhancement"])),
		).toBe(false);
	});
});
