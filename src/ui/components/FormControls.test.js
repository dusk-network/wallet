import { afterEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, settle } from "../testing/fakeDom.js";
import { wrappingInput } from "./FormControls.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ADDRESS =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";

describe("a field that wraps as it grows (Send's To)", () => {
  it("fits its lines again when it gets narrower, as a contact's chip beside it or a turned phone makes it, so nothing is cut off", async () => {
    const dom = installFakeDom();
    // The browser's: told of each change of the field's size.
    const observers = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(fn) {
          this.fn = fn;
          observers.push(this);
        }
        observe(el) {
          this.el = el;
        }
      }
    );
    const field = wrappingInput({ value: ADDRESS });
    dom.document.body.appendChild(field);
    // Its lines: 20 px each, as many as the text needs at its width.
    let width = 320;
    Object.defineProperty(field, "scrollHeight", { get: () => Math.ceil((ADDRESS.length * 9) / width) * 20 });
    const resized = () => observers.forEach((o) => o.el === field && o.fn([{ contentRect: { width } }]));
    resized();
    await settle();
    expect(field.style.height).toBe("80px");

    // The chip of a saved contact takes room beside the text.
    width = 240;
    resized();
    expect(field.style.height).toBe(`${Math.ceil((ADDRESS.length * 9) / 240) * 20}px`);
  });
});
