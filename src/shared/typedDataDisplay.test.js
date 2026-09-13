import { createHash } from "node:crypto";
import { hashTypedDataHex } from "@dusk/typed-data";
import { checkPolicyLimits } from "@dusk/typed-data/policy";
import { describe, expect, it } from "vitest";
import * as display from "./typedDataDisplay.js";
import {
  TYPED_DATA_DISPLAY_MAX_STRING_CHARS,
  flattenTypedMessage,
  sanitizeStringForDisplay,
} from "./typedDataDisplay.js";

function disclosureInput(message, fields) {
  return {
    domain: { name: "Disclosure", version: "1", chainId: "dusk:0" },
    origin: "https://dapp.example",
    types: {
      DuskTypedDataDomain: [
        { name: "name", type: "string" }, { name: "version", type: "string" },
        { name: "chainId", type: "string" }, { name: "verifyingContract", type: "bytes32" },
      ],
      Message: fields, Empty: [],
    },
    primaryType: "Message", message,
  };
}

describe("complete typed-data disclosure", () => {
  it("exposes omitted array entries, long tails, empty structs and complete bytes without changing signed input", async () => {
    const input = disclosureInput({
      amounts: Array.from({ length: 210 }, (_, i) => i),
      text: "A".repeat(2048) + " ORIGINAL TAIL", blob: "0X00AB", marker: {},
    }, [
      { name: "amounts", type: "uint64[210]" }, { name: "text", type: "string" },
      { name: "blob", type: "bytes" }, { name: "marker", type: "Empty" },
    ]);
    const original = structuredClone(input);
    checkPolicyLimits(input);
    const digest = hashTypedDataHex(input);
    expect((await flattenTypedMessage(input)).rows).toHaveLength(200);
    const full = display.prepareTypedDataDisclosure(input, digest);
    expect(JSON.parse(full.json)).toEqual(original);
    expect(full.input).toEqual(original);
    expect(full.json).toContain("ORIGINAL TAIL");
    expect(full.input.message.amounts[209]).toBe(209);
    expect(input).toEqual(original);
    expect(hashTypedDataHex(full.input)).toBe(digest);
  });

  it("keeps Unicode, line breaks, formatting controls and literal escape spellings distinguishable", () => {
    const values = ["é", "e\u0301", "\\u00e9", "Alice", "Ali\u200bce", "👩‍💻", "A\nB\rC\u2028D\u2029E", "x\u061c\u202ey\u202c", "<script>bad()</script>"];
    const serialized = new Set();
    for (const text of values) {
      const input = disclosureInput({ text }, [{ name: "text", type: "string" }]);
      checkPolicyLimits(input);
      const digest = hashTypedDataHex(input);
      const full = display.prepareTypedDataDisclosure(input, digest);
      expect(full.json).not.toMatch(/[\u007f-\uffff]/);
      expect(JSON.parse(full.json)).toEqual(input);
      expect(hashTypedDataHex(full.input)).toBe(digest);
      serialized.add(full.json);
    }
    expect(serialized.size).toBe(values.length);
  });

  it("rejects a digest mismatch or a serialization that changes the signing input", () => {
    const input = disclosureInput({ text: "Alice" }, [{ name: "text", type: "string" }]);
    const digest = hashTypedDataHex(input);
    expect(() => display.prepareTypedDataDisclosure({ ...input, origin: "https://other.example" }, digest)).toThrow(/digest/i);
    input.message = Object.assign(Object.create({ toJSON: () => ({ text: "Mallory" }) }), input.message);
    expect(hashTypedDataHex(input)).toBe(digest);
    expect(() => display.prepareTypedDataDisclosure(input, digest)).toThrow(/digest/i);
    input.message = {};
    Object.defineProperty(input.message, "text", { value: "Alice", enumerable: false });
    expect(hashTypedDataHex(input)).toBe(digest);
    expect(() => display.prepareTypedDataDisclosure(input, digest)).toThrow();
  });

  it("does not authorize malformed names through the full-view path", () => {
    const input = disclosureInput({ "a.b": "value" }, [{ name: "a.b", type: "string" }]);
    expect(() => display.prepareTypedDataDisclosure(input, `0x${"00".repeat(32)}`)).toThrow(/field definition/);
  });

  it("supports the string resource floor but refuses a full view exceeding its display budget", () => {
    const input = disclosureInput({ text: "A".repeat(65_536) }, [{ name: "text", type: "string" }]);
    checkPolicyLimits(input);
    expect(display.prepareTypedDataDisclosure(input, hashTypedDataHex(input)).input).toEqual(input);
    // Unused schema metadata is not hashed or depth-limited by protocol policy.
    // Its compact transport fits policy, but pretty-printing it must stay bounded.
    let unused = [];
    for (let i = 0; i < 32; i++) unused = [unused];
    for (const count of [1000, 2000]) {
      input.types.Unused = Array(count).fill(unused);
      checkPolicyLimits(input);
      const digest = hashTypedDataHex(input);
      // Exercise both final text size and the earlier construction budget.
      expect(() => display.prepareTypedDataDisclosure(input, digest)).toThrow(/too large/i);
    }
  });
});

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

  it.each([
    ["Request", { note: "Sign in", approveAll: {} }, [
      ["note", "string", "Sign in"], ["approveAll", "Empty", "{}"],
    ]],
    ["Permissions", { permissions: [{}, {}] }, [
      ["permissions[0]", "Empty", "{}"], ["permissions[1]", "Empty", "{}"],
    ]],
    ["Empty", {}, [["(root)", "Empty", "{}"]]],
  ])("renders accepted empty structs in %s without changing signed input", async (primaryType, message, expected) => {
    const input = {
      domain: { name: "Preview", version: "1", chainId: "dusk:0" },
      origin: "https://dapp.example",
      types: {
        DuskTypedDataDomain: [
          { name: "name", type: "string" }, { name: "version", type: "string" },
          { name: "chainId", type: "string" }, { name: "verifyingContract", type: "bytes32" },
        ],
        Request: [{ name: "note", type: "string" }, { name: "approveAll", type: "Empty" }],
        Permissions: [{ name: "permissions", type: "Empty[2]" }],
        Empty: [],
      },
      primaryType, message,
    };
    const original = structuredClone(input);
    checkPolicyLimits(input);
    const digest = hashTypedDataHex(input);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await flattenTypedMessage(input)).toEqual({
      rows: expected.map(([path, type, display]) => ({ path, type, display, flags: [] })),
      truncated: null,
    });
    expect(input).toEqual(original);
    expect(hashTypedDataHex(input)).toBe(digest);
  });

  it("counts empty structs against the row budget, including an empty root", async () => {
    const input = {
      types: { Permissions: [{ name: "permissions", type: "Empty[2]" }], Empty: [] },
      primaryType: "Permissions", message: { permissions: [{}, {}] },
    };
    expect(await flattenTypedMessage(input, { maxRows: 1 })).toEqual({
      rows: [{ path: "permissions[0]", type: "Empty", display: "{}", flags: [] }],
      truncated: { omittedCount: 1, depthLimited: false },
    });
    expect(await flattenTypedMessage({ ...input, primaryType: "Empty", message: {} }, { maxRows: 0 })).toEqual({
      rows: [], truncated: { omittedCount: 1, depthLimited: false },
    });
    for (const message of [null, [], 42]) {
      expect((await flattenTypedMessage({ ...input, primaryType: "Empty", message })).rows).toEqual([
        { path: "(root)", type: "Empty", display: "(unexpected type)", flags: [] },
      ]);
    }
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

  it("neutralises every Unicode Bidi_Control, but preserves ordinary Arabic and emoji", () => {
    const controls = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      const char = String.fromCodePoint(code);
      if (/\p{Bidi_Control}/u.test(char)) controls.push(char);
    }
    expect(controls).toHaveLength(12);
    for (const char of controls) {
      expect(sanitizeStringForDisplay(`Amount: ${char}123 456`)).toEqual({
        display: "Amount: �123 456", flags: ["bidi_control"],
      });
    }
    const plain = "العربية 123 456 😀";
    expect(sanitizeStringForDisplay(plain)).toEqual({ display: plain, flags: [] });
  });

  it.each([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xad])("visibly escapes invisible formatting U+%s without losing it", code => {
    const raw = `A${String.fromCodePoint(code)}B`;
    expect(sanitizeStringForDisplay(raw)).toEqual({
      display: `A\\u${code.toString(16).padStart(4, "0")}B`, flags: ["invisible_format"],
    });
  });

  it.each([0x0a, 0x0d, 0x2028, 0x2029])("visibly escapes a line separator U+%s instead of fabricating a line", code => {
    expect(sanitizeStringForDisplay(`A${String.fromCodePoint(code)}B`)).toEqual({
      display: `A\\u${code.toString(16).padStart(4, "0")}B`, flags: ["line_separator"],
    });
  });

  it("flags non-NFC text without normalizing the original preview or emoji", () => {
    expect(sanitizeStringForDisplay("e\u0301")).toEqual({ display: "e\u0301", flags: ["non_nfc"] });
    expect(sanitizeStringForDisplay("é 😀")).toEqual({ display: "é 😀", flags: [] });
    expect(sanitizeStringForDisplay("👩‍💻")).toEqual({ display: "👩\\u200d💻", flags: ["invisible_format"] });
  });

  it("preserves surrogate pairs at the preview cap and escapes supplementary format controls", () => {
    expect(sanitizeStringForDisplay("😀X", 1)).toEqual({ display: "😀", flags: ["truncated"] });
    expect(sanitizeStringForDisplay("\ud800X\udfff")).toEqual({ display: "�X�", flags: ["invalid_surrogate"] });
    expect(sanitizeStringForDisplay("A\u{e0001}B")).toEqual({ display: "A\\udb40\\udc01B", flags: ["invisible_format"] });
    expect(sanitizeStringForDisplay("A\tB")).toEqual({ display: "A�B", flags: ["control_chars"] });
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

  it.each([["bytes", "00"], ["bytes32", "ab".repeat(32)], ["bytes", ""]])(
    "describes the signed bytes for every accepted hex spelling: %s %s",
    async (type, hex) => {
      const input = {
        domain: { name: "Preview", version: "1", chainId: "dusk:0" },
        origin: "https://dapp.example",
        types: {
          DuskTypedDataDomain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "string" },
            { name: "verifyingContract", type: "bytes32" },
          ],
          Blob: [{ name: "data", type }],
        },
        primaryType: "Blob",
        message: { data: `0x${hex}` },
      };
      const digest = hashTypedDataHex(input);
      const expectedHash = createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
      for (const value of [`0x${hex}`, `0X${hex.toUpperCase()}`, hex]) {
        const candidate = { ...input, message: { data: value } };
        expect(hashTypedDataHex(candidate)).toBe(digest);
        const { rows } = await flattenTypedMessage(candidate);
        expect(rows).toEqual([{
          path: "data", type, flags: [],
          display: `${hex.length / 2} bytes · sha256=${expectedHash.slice(0, 12)}…${expectedHash.slice(-8)}`,
        }]);
      }
    }
  );

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
