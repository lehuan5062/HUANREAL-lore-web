// Parsing helpers for Lore content addresses. A Lore address is a
// `hash-context` pair of hex strings; the native SDK's error layer embeds
// this exact format in free-text messages (e.g. "Address not found:
// <hash>-<context>") with no structured fields available on the event/error
// object, so recovering it means regex-scanning the message text.

const HEX = "[0-9a-fA-F]+";
const ADDRESS_RE = new RegExp(`(${HEX})-(${HEX})`);
const ADDRESS_NOT_FOUND_RE = new RegExp(`Address not found:\\s*(${HEX})-(${HEX})`, "gi");

/**
 * Parse a single `"<hash>-<context>"` string into `{hash, context}`.
 * Throws if the string doesn't match that shape.
 * @param {string} text
 * @returns {{hash: string, context: string}}
 */
export function parseAddress(text) {
  const trimmed = String(text ?? "").trim();
  const m = ADDRESS_RE.exec(trimmed);
  if (!m || m[0] !== trimmed) {
    throw new Error(`Not a valid Lore address (expected "hash-context"): ${text}`);
  }
  return { hash: m[1], context: m[2] };
}

/**
 * Scan a free-text error message for every `Address not found: <hash>-<context>`
 * occurrence and return the parsed addresses, deduplicated.
 * @param {string} message
 * @returns {{hash: string, context: string}[]}
 */
export function extractAddressNotFoundAddresses(message) {
  const text = String(message ?? "");
  const seen = new Set();
  const result = [];
  for (const m of text.matchAll(ADDRESS_NOT_FOUND_RE)) {
    const key = `${m[1]}-${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ hash: m[1], context: m[2] });
  }
  return result;
}
