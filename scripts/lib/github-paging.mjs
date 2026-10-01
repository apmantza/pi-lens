/**
 * Bounded REST paging for the warden (review round 1, F6).
 *
 * The marker-based comment dedupe in the warden reads
 * only the FIRST page of `issues/{n}/comments`, so a PR past 100 comments
 * would stop finding its own marker and start repeating notices.
 *
 * `sort=created&direction=desc` does NOT help: probed 2026-08-26 against
 * `repos/apmantza/pi-lens/issues/2109/comments`, `direction=desc` and
 * `direction=asc` returned the identical ascending list, so the endpoint
 * ignores the parameter (AGENTS.md shape 16 -- verify the API's real
 * behaviour, do not trust the doc). Newest-first is therefore unavailable and
 * the reader must walk to the last page.
 *
 * The walk is bounded like the warden's GraphQL reader: it stops at
 * MAX_REST_PAGES and reports truncation rather than looping, and a truncated
 * read is never reported as a complete one.
 */

export const REST_PAGE_SIZE = 100;
export const MAX_REST_PAGES = 10; // 1000 records; far above any PR in this repo.

/**
 * Collect every record of a paginated REST list. Throws on an HTTP failure or
 * a malformed page, so the caller's existing fail-closed handling applies:
 * an unreadable list must never read as "the marker is absent".
 */
export async function paginate(fetcher, url) {
	const items = [];
	const separator = url.includes("?") ? "&" : "?";
	for (let page = 1; page <= MAX_REST_PAGES; page++) {
		const response = await fetcher(
			`${url}${separator}per_page=${REST_PAGE_SIZE}&page=${page}`,
			{ headers: { accept: "application/vnd.github+json" } },
		);
		if (!response.ok)
			throw new Error(`${url} page ${page} -> HTTP ${response.status}`);
		const body = await response.json();
		if (!Array.isArray(body))
			throw new Error(`${url} page ${page} returned no array`);
		items.push(...body);
		// A short page is the last page. This is the only exhaustion signal
		// that does not need the Link header.
		if (body.length < REST_PAGE_SIZE) return items;
		if (page === MAX_REST_PAGES)
			throw new Error(
				`${url} still full at page ${MAX_REST_PAGES}; read truncated`,
			);
	}
	return items;
}

/**
 * Which of these markers already appear in the issue's comments? One paged
 * read answers for every marker, so a head carrying several stuck runs
 * (#2203) costs the same single read as one carrying none.
 */
export async function presentCommentMarkers(
	fetcher,
	owner,
	repo,
	number,
	markers,
) {
	const comments = await paginate(
		fetcher,
		`https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
	);
	const bodies = comments.map((c) => String(c?.body ?? ""));
	return new Set(
		(markers ?? []).filter((marker) =>
			bodies.some((body) => body.includes(marker)),
		),
	);
}

/**
 * Does any comment on this issue carry the marker? Shared by both modules so
 * the per-head dedupe has one implementation, not two that can drift.
 */
export async function commentMarkerExists(
	fetcher,
	owner,
	repo,
	number,
	marker,
) {
	const present = await presentCommentMarkers(fetcher, owner, repo, number, [
		marker,
	]);
	return present.has(marker);
}
