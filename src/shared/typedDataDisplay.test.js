import { describe, expect, it } from "vitest";

import { sha256Hex, toBytes } from "./bytes.js";
import {
  TYPED_DATA_DISPLAY_MAX_STRING_CHARS,
  flattenTypedMessage,
} from "./typedDataDisplay.js";

function rowsByPath(rows) {
  const out = {};
  for (const r of rows) out[r.path] = r;
  return out;
}

describe("flattenTypedMessage", () => {
  it("flattens a flat struct with one row per leaf", async () => {
    const types = {
      Person: [
        { name: "name", type: "string" },
        { name: "age", type: "uint8" },
      ],
    };
    const { rows, truncated } = await flattenTypedMessage({
      types,
      primaryType: "Person",
      message: { name: "Bob", age: 30 },
    });

    expect(truncated).toBeNull();
    expect(rows).toEqual([
      { path: "name", type: "string", display: "Bob", flags: [] },
      { path: "age", type: "uint8", display: "30", flags: [] },
    ]);
  });

  it("flattens a nested struct using dotted paths", async () => {
    const types = {
      Person: [
        { name: "name", type: "string" },
        { name: "wallet", type: "bytes32" },
      ],
      Mail: [
        { name: "from", type: "Person" },
        { name: "to", type: "Person" },
        { name: "contents", type: "string" },
      ],
    };
    const wallet = `0x${"ab".repeat(32)}`;
    const { rows } = await flattenTypedMessage({
      types,
      primaryType: "Mail",
      message: {
        from: { name: "Alice", wallet },
        to: { name: "Bob", wallet },
        contents: "hi",
      },
    });

    const byPath = rowsByPath(rows);
    expect(Object.keys(byPath)).toEqual([
      "from.name",
      "from.wallet",
      "to.name",
      "to.wallet",
      "contents",
    ]);
    expect(byPath["from.name"]).toMatchObject({ type: "string", display: "Alice" });
    expect(byPath["contents"]).toMatchObject({ type: "string", display: "hi" });
  });

  it("flattens a fixed array element by element", async () => {
    const types = {
      Group: [{ name: "members", type: "uint8[3]" }],
    };
    const { rows } = await flattenTypedMessage({
      types,
      primaryType: "Group",
      message: { members: [1, 2, 3] },
    });

    expect(rows).toEqual([
      { path: "members[0]", type: "uint8", display: "1", flags: [] },
      { path: "members[1]", type: "uint8", display: "2", flags: [] },
      { path: "members[2]", type: "uint8", display: "3", flags: [] },
    ]);
  });

  it("flattens nested fixed arrays with bracketed paths per dimension", async () => {
    const types = {
      Matrix: [{ name: "cell", type: "uint8[2][2]" }],
    };
    const { rows } = await flattenTypedMessage({
      types,
      primaryType: "Matrix",
      message: { cell: [[1, 2], [3, 4]] },
    });

    const byPath = rowsByPath(rows);
    expect(byPath["cell[0][0]"].display).toBe("1");
    expect(byPath["cell[0][1]"].display).toBe("2");
    expect(byPath["cell[1][0]"].display).toBe("3");
    expect(byPath["cell[1][1]"].display).toBe("4");
  });

  it("flattens a struct inside an array element", async () => {
    const types = {
      Person: [
        { name: "name", type: "string" },
        { name: "wallet", type: "bytes32" },
      ],
      Group: [{ name: "members", type: "Person[2]" }],
    };
    const wallet = `0x${"cd".repeat(32)}`;
    const { rows } = await flattenTypedMessage({
      types,
      primaryType: "Group",
      message: { members: [{ name: "A", wallet }, { name: "B", wallet }] },
    });

    const byPath = rowsByPath(rows);
    expect(byPath["members[0].name"].display).toBe("A");
    expect(byPath["members[1].name"].display).toBe("B");
    expect(byPath["members[0].wallet"].type).toBe("bytes32");
  });

  it("always reports the declared schema type, not something inferred from the value", async () => {
    const types = {
      Order: [
        { name: "amount", type: "uint64" },
        { name: "note", type: "string" },
        { name: "flag", type: "bool" },
      ],
    };
    // `amount` is passed as a decimal string, which alone looks identical to
    // a `string` value - the row's declared `type` is what disambiguates it.
    const { rows } = await flattenTypedMessage({
      types,
      primaryType: "Order",
      message: { amount: "42", note: "42", flag: true },
    });

    const byPath = rowsByPath(rows);
    expect(byPath["amount"]).toMatchObject({ type: "uint64", display: "42" });
    expect(byPath["note"]).toMatchObject({ type: "string", display: "42" });
    expect(byPath["flag"]).toMatchObject({ type: "bool", display: "true" });
  });

  it("marks the cut point when a whole message is nested past the depth cap", async () => {
    // A hostile payload can nest past the cap immediately. Without a marker row
    // the approval screen would render zero fields and a "1 more field" notice,
    // showing the user nothing while understating how much is hidden.
    const types = { Node: [{ name: "next", type: "Node" }] };
    let message = { next: null };
    for (let i = 0; i < 12; i++) message = { next: message };

    const { rows, truncated } = await flattenTypedMessage(
      { types, primaryType: "Node", message },
      { maxDepth: 2 }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].flags).toContain("depth_limited");
    expect(rows[0].display).toBe("(nested too deep to display)");
    expect(truncated.depthLimited).toBe(true);
  });

  it("stops recursing past the depth cap and reports an omitted count", async () => {
    // Node -> next -> next -> next -> ... A maxDepth of 3 means struct fields
    // reachable at depth 4 (i.e. nested three levels past the root) get cut.
    const types = {
      Node: [
        { name: "value", type: "uint8" },
        { name: "next", type: "Node" },
      ],
    };
    const message = { value: 1, next: { value: 2, next: { value: 3, next: { value: 4, next: { value: 5, next: null } } } } };

    const { rows, truncated } = await flattenTypedMessage(
      { types, primaryType: "Node", message },
      { maxDepth: 3 }
    );

    // The cut subtree surfaces as a depth_limited marker row rather than a count.
    expect(rows.filter((r) => !r.flags.includes("depth_limited")).map((r) => r.path)).toEqual([
      "value",
      "next.value",
      "next.next.value",
    ]);
    expect(truncated.depthLimited).toBe(true);
  });

  it("stops adding rows past the row cap and reports the omitted count", async () => {
    const types = {
      Flat: Array.from({ length: 10 }, (_, i) => ({ name: `f${i}`, type: "uint8" })),
    };
    const message = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, i]));

    const { rows, truncated } = await flattenTypedMessage(
      { types, primaryType: "Flat", message },
      { maxRows: 5 }
    );

    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.path)).toEqual(["f0", "f1", "f2", "f3", "f4"]);
    expect(truncated).toEqual({ omittedCount: 5, depthLimited: false });
  });

  it("truncates an oversized string field and flags it", async () => {
    const types = { Note: [{ name: "text", type: "string" }] };
    const text = "a".repeat(TYPED_DATA_DISPLAY_MAX_STRING_CHARS + 50);

    const { rows } = await flattenTypedMessage({
      types,
      primaryType: "Note",
      message: { text },
    });

    expect(rows[0].display).toHaveLength(TYPED_DATA_DISPLAY_MAX_STRING_CHARS);
    expect(rows[0].flags).toContain("truncated");
  });

  it("neutralises and flags a bidi override character", async () => {
    const types = { Note: [{ name: "text", type: "string" }] };
    const raw = "send‮1 DUSK";

    const { rows } = await flattenTypedMessage({
      types,
      primaryType: "Note",
      message: { text: raw },
    });

    expect(rows[0].flags).toContain("bidi_control");
    expect(rows[0].display).not.toContain("‮");
    expect(rows[0].display).toContain("�");
  });

  it("neutralises and flags a control character", async () => {
    const types = { Note: [{ name: "text", type: "string" }] };
    const raw = "a\x07b";

    const { rows } = await flattenTypedMessage({
      types,
      primaryType: "Note",
      message: { text: raw },
    });

    expect(rows[0].flags).toContain("control_chars");
    expect(rows[0].display).toBe("a�b");
  });

  it("renders a missing field honestly instead of throwing", async () => {
    const types = { Person: [{ name: "name", type: "string" }] };

    const { rows } = await flattenTypedMessage({
      types,
      primaryType: "Person",
      message: {},
    });

    expect(rows[0]).toMatchObject({ path: "name", display: "(missing)", flags: [] });
  });

  it("renders a wrong-typed value honestly instead of throwing", async () => {
    const types = { Person: [{ name: "age", type: "uint8" }] };

    const { rows } = await flattenTypedMessage({
      types,
      primaryType: "Person",
      message: { age: { unexpected: true } },
    });

    expect(rows[0]).toMatchObject({ path: "age", display: "(unexpected type)" });
  });

  it("formats bytes/bytes32 leaves as a byte count plus sha256 preview", async () => {
    const types = { Blob: [{ name: "data", type: "bytes" }] };
    const hex = "0xdeadbeef";

    const { rows } = await flattenTypedMessage({
      types,
      primaryType: "Blob",
      message: { data: hex },
    });

    const expectedHash = await sha256Hex(toBytes(hex));
    expect(rows[0].display).toBe(
      `4 bytes · sha256=${expectedHash.slice(0, 12)}…${expectedHash.slice(-8)}`
    );
  });

  it("renders an empty string leaf without flags", async () => {
    const types = { Note: [{ name: "text", type: "string" }] };

    const { rows } = await flattenTypedMessage({
      types,
      primaryType: "Note",
      message: { text: "" },
    });

    expect(rows[0]).toEqual({ path: "text", type: "string", display: "", flags: [] });
  });

  it("renders uint64 identically whether given as a JSON number or a decimal string", async () => {
    const types = {
      Pair: [
        { name: "asNumber", type: "uint64" },
        { name: "asString", type: "uint64" },
      ],
    };

    const { rows } = await flattenTypedMessage({
      types,
      primaryType: "Pair",
      message: { asNumber: 42, asString: "42" },
    });

    const byPath = rowsByPath(rows);
    expect(byPath["asNumber"].display).toBe("42");
    expect(byPath["asString"].display).toBe("42");
  });
});
