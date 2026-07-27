// Error and event types shared by the SDK wrapper (sdk.mjs) and the HTTP layer
// (index.mjs).
//
// This module deliberately has ZERO imports. index.mjs needs `instanceof
// LoreVerbError` (see isAddressNotFound) but must not import sdk.mjs to get it:
// sdk.mjs pulls in @lore-vcs/sdk, which loads a 29 MB native library at import
// time. Keeping the class here lets both modules share one class identity while
// only sdk.mjs pays for the native load. See sdk-lazy.mjs for the full why.

/** A normalized Lore event: numeric tag resolved to its name plus the payload. */
/** @typedef {{ tag: string, tagRaw: number, data: any }} LoreEvt */

/** Raised when a Lore verb completes with a non-zero status. */
export class LoreVerbError extends Error {
  /** @param {string} message @param {{status?: number, code?: number, verb?: string}} [info] */
  constructor(message, info = {}) {
    super(message);
    this.name = "LoreVerbError";
    this.status = info.status ?? -1;
    this.code = info.code ?? info.status ?? -1;
    this.verb = info.verb;
  }
}
