// Address-parsing unit tests. Pure string parsing, no SDK.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAddress, extractAddressNotFoundAddresses } from "../server/address.mjs";

test("parseAddress splits hash-context", () => {
  const addr = parseAddress("6c5c10c6ebc4cd60cfe1b7dac5921b9f9672c4d6961fc13341992049534a40b8-019fa1db20277eb0b17c167e603aa947");
  assert.equal(addr.hash, "6c5c10c6ebc4cd60cfe1b7dac5921b9f9672c4d6961fc13341992049534a40b8");
  assert.equal(addr.context, "019fa1db20277eb0b17c167e603aa947");
});

test("parseAddress rejects malformed input", () => {
  assert.throws(() => parseAddress("not-an-address-!!"));
  assert.throws(() => parseAddress(""));
  assert.throws(() => parseAddress("onlyhash"));
});

test("extractAddressNotFoundAddresses finds the address in the real incident message", () => {
  const message =
    "Failed to sync file Content/Birds/Environment/Trees/Vegetation_Debris_002/T_Vegetation_Debris_002_D_R.uasset: Address not found: 6c5c10c6ebc4cd60cfe1b7dac5921b9f9672c4d6961fc13341992049534a40b8-019fa1db20277eb0b17c167e603aa947\n  at lore-revision\\src\\fs\\os.rs:309 - Failed to read file";
  const addrs = extractAddressNotFoundAddresses(message);
  assert.equal(addrs.length, 1);
  assert.equal(addrs[0].hash, "6c5c10c6ebc4cd60cfe1b7dac5921b9f9672c4d6961fc13341992049534a40b8");
  assert.equal(addrs[0].context, "019fa1db20277eb0b17c167e603aa947");
});

test("extractAddressNotFoundAddresses dedupes and ignores unrelated text", () => {
  const message = "Address not found: aa-bb\nsome other error\nAddress not found: aa-bb\nAddress not found: cc-dd";
  const addrs = extractAddressNotFoundAddresses(message);
  assert.deepEqual(addrs, [
    { hash: "aa", context: "bb" },
    { hash: "cc", context: "dd" },
  ]);
});

test("extractAddressNotFoundAddresses returns empty array for unrelated failures", () => {
  assert.deepEqual(extractAddressNotFoundAddresses("connection refused"), []);
  assert.deepEqual(extractAddressNotFoundAddresses(""), []);
  assert.deepEqual(extractAddressNotFoundAddresses(undefined), []);
});
