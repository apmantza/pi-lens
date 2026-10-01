import { createHash } from "node:crypto";

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

/**
 * Hash serialized project-snapshot JSON while replacing only the top-level
 * volatile `generatedAt` value with a stable sentinel. The persist worker calls
 * this on the UTF-8 bytes the dispatcher serialized (#3789), so no second copy
 * of the body is decoded into a string; the synchronous fallback passes the
 * bytes it already holds. The scan reads only ASCII structure (quotes,
 * backslashes, braces), which never occurs inside a UTF-8 multibyte sequence,
 * and the hash covers the same bytes the string form encoded, so a digest a
 * released writer stored in the meta sidecar still matches (fixture corpus
 * `tests/fixtures/snapshot-persist/released-4.3.0`).
 */
export function fingerprintProjectSnapshotJson(
	json: string | Uint8Array,
	generatedAt: string,
): string {
	const bytes =
		typeof json === "string"
			? Buffer.from(json)
			: Buffer.from(json.buffer, json.byteOffset, json.byteLength);
	const marker = Buffer.from(`"generatedAt":${JSON.stringify(generatedAt)}`);
	let markerIndex = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < bytes.length; index++) {
		const byte = bytes[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (byte === BACKSLASH) escaped = true;
			else if (byte === QUOTE) inString = false;
			continue;
		}
		if (byte === QUOTE) {
			if (
				depth === 1 &&
				index + marker.length <= bytes.length &&
				bytes.compare(
					marker,
					0,
					marker.length,
					index,
					index + marker.length,
				) === 0
			) {
				markerIndex = index;
				break;
			}
			inString = true;
		} else if (byte === OPEN_BRACE) depth++;
		else if (byte === CLOSE_BRACE) depth--;
	}
	const hash = createHash("sha256");
	if (markerIndex < 0) {
		hash.update(bytes);
	} else {
		hash.update(bytes.subarray(0, markerIndex));
		hash.update('"generatedAt":""');
		hash.update(bytes.subarray(markerIndex + marker.length));
	}
	return hash.digest("hex");
}
