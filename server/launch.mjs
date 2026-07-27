// Shared clock for the startup phase timings.
//
// Anchored to process.uptime() rather than a module-load timestamp so every
// phase is measured from the real process launch — including the Node boot and
// module resolution that happen before any of our code runs. Those are a
// meaningful part of cold-start cost, so they belong inside the numbers.

/**
 * Milliseconds since this process launched.
 * @returns {number}
 */
export function sinceLaunch() {
  return Math.round(process.uptime() * 1000);
}
