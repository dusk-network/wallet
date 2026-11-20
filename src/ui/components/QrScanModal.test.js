import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, settle } from "../testing/fakeDom.js";

vi.mock("../../wallet/bus.js", () => ({ send: vi.fn() }));

const REQUEST = "dusk:public-request";

let dom;
// The QR decoder, as the scan loads it: each load counted, a load that fails
// when asked, and a decoder that reads one request.
const decoder = { loads: 0, fail: false, read: null };
// A camera's stream, its one track stopped or not.
const camera = () => {
  const track = { stop: vi.fn() };
  return { track, stream: { getTracks: () => [track] } };
};

beforeEach(() => {
  vi.resetModules();
  Object.assign(decoder, { loads: 0, fail: false, read: vi.fn(() => ({ data: REQUEST })) });
  vi.doMock("jsqr", () => {
    decoder.loads++;
    if (decoder.fail) throw new TypeError("Failed to fetch dynamically imported module");
    return { default: decoder.read };
  });
  dom = installFakeDom({
    elements: {
      canvas: (el) => {
        el.getContext = () => ({
          drawImage() {},
          getImageData: (x, y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
        });
      },
      video: (el) => {
        el.play = async () => {};
        el.videoWidth = 640;
        el.videoHeight = 480;
      },
    },
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const modal = () => dom.document.body.querySelector(".qrscan-modal");
// Choose image, the first of the scan's actions, by where it sits rather than by what it says.
const chooseImage = () => modal().querySelectorAll(".qrscan-actions > button")[0];
// The scan closed from its close, the button that takes you back.
const close = async () => {
  modal().querySelector("[data-back]").click();
  await settle();
};
// The decoder's load, and what follows it, done.
const loaded = async () => {
  for (let i = 0; i < 10; i++) await settle();
};

describe("the QR scan", () => {
  // Astra's: with Auto-lock's Immediately, a camera allowed or refused already asks nothing, so the
  // wallet never went to the background, and the step away for its question stayed: the next leaving didn't lock.
  it("leaves no step away once the camera's answer comes without a question, nor once the scan closes", async () => {
    const { steppedAway } = await import("../../platform/native.js");
    const { openQrScanModal } = await import("./QrScanModal.js");
    for (const getUserMedia of [async () => camera().stream, async () => Promise.reject(new DOMException("denied", "NotAllowedError"))]) {
      decoder.read.mockImplementation(() => null);
      vi.stubGlobal("navigator", { ...globalThis.navigator, mediaDevices: { getUserMedia: vi.fn(getUserMedia) } });
      const scan = openQrScanModal();
      await loaded();
      expect(steppedAway()).toBe(false);
      // The phone's picker, then the scan closed without the wallet going anywhere.
      chooseImage().click();
      expect(steppedAway()).toBe(true);
      await close();
      await scan;
      expect(steppedAway()).toBe(false);
    }
  });

  it("turns the camera off when its decoder doesn't come, and when the scan closes before the camera starts", async () => {
    let { openQrScanModal } = await import("./QrScanModal.js");
    const first = camera();
    decoder.fail = true;
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => first.stream } });
    openQrScanModal();
    await loaded();
    expect(first.track.stop).toHaveBeenCalled();
    // The scanner couldn't load: it reads nothing, an image chosen either.
    expect(chooseImage().disabled).toBe(true);
    await close();

    // Closed while the camera is asked for, the decoder there: the camera it gets goes too.
    decoder.fail = false;
    vi.resetModules();
    ({ openQrScanModal } = await import("./QrScanModal.js"));
    const late = camera();
    const asked = Promise.withResolvers();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => asked.promise } });
    const scan = openQrScanModal();
    await close();
    await expect(scan).resolves.toBeNull();
    asked.resolve(late.stream);
    await loaded();
    expect(late.track.stop).toHaveBeenCalled();
  });
});
