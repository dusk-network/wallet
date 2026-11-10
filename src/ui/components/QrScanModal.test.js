import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeEvent, installFakeDom, settle } from "../testing/fakeDom.js";

vi.mock("../../wallet/bus.js", () => ({ send: vi.fn() }));

const REQUEST = "dusk:public-request";
const FAILED = "The QR scanner couldn't load. Close the wallet and open it again.";

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
const message = () => [...modal().querySelectorAll(".qrscan-hint")].map((n) => n.textContent).filter(Boolean).at(-1);
const button = (text) => modal().querySelectorAll("button").find((b) => b.textContent === text);
const close = async () => {
  button("Cancel").click();
  await settle();
};
// The decoder's load, and what follows it, done.
const loaded = async () => {
  for (let i = 0; i < 10; i++) await settle();
};

// An image chosen: it loads, and the modal reads it.
async function chooseImage() {
  vi.stubGlobal("URL", { createObjectURL: () => "blob:qr", revokeObjectURL: () => {} });
  vi.stubGlobal("Image", class {
    set src(url) {
      Object.assign(this, { naturalWidth: 300, naturalHeight: 300 });
      setTimeout(() => this.onload?.(url));
    }
  });
  const input = modal().querySelector('input[type="file"]');
  input.files = [{ name: "request.png" }];
  input.dispatchEvent(fakeEvent("change"));
  await loaded();
}

describe("the QR scan", () => {
  it("loads no QR decoder with the popup, then loads it when a scan opens and reads a chosen image with it", async () => {
    await import("../popup/app.js");
    const { openQrScanModal } = await import("./QrScanModal.js");
    expect(decoder.loads).toBe(0);

    const scan = openQrScanModal({ title: "Scan request" });
    await loaded();
    expect(decoder.loads).toBe(1);
    await chooseImage();
    await expect(scan).resolves.toBe(REQUEST);
    expect(decoder.read).toHaveBeenCalledWith(expect.any(Uint8ClampedArray), 300, 300, { inversionAttempts: "attemptBoth" });
  });

  // Sofía's: a big broken "Unable to play media" player over the message, without a camera.
  it("shows only its message and Choose image where there's no camera, and the camera once it plays", async () => {
    const { isShown, visibleText } = await import("../testing/fakeDom.js");
    vi.stubGlobal("navigator", { ...globalThis.navigator, mediaDevices: { getUserMedia: vi.fn(async () => Promise.reject(new DOMException("denied", "NotAllowedError"))) } });
    const { openQrScanModal } = await import("./QrScanModal.js");
    const scan = openQrScanModal();
    await loaded();
    expect(isShown(modal().querySelector(".qrscan-video-wrap"))).toBe(false);
    expect(visibleText(modal().querySelector(".qrscan-body"))).toBe("Camera permission denied or unavailable. You can still choose an image.Choose imageCancel");
    await close();
    await expect(scan).resolves.toBeNull();

    const { stream } = camera();
    // A camera that sees no code yet.
    decoder.read.mockImplementation(() => null);
    vi.stubGlobal("navigator", { ...globalThis.navigator, mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
    const live = openQrScanModal({ hint: "Point your camera at a QR code" });
    await loaded();
    expect(isShown(modal().querySelector(".qrscan-video-wrap"))).toBe(true);
    expect(visibleText(modal().querySelector(".qrscan-body"))).toBe("Point your camera at a QR codeChoose imageCancel");
    await close();
    await live;
  });

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
      button("Choose image").click();
      expect(steppedAway()).toBe(true);
      await close();
      await scan;
      expect(steppedAway()).toBe(false);
    }
  });

  it("says the scanner couldn't load and offers no image when its decoder doesn't come, until the wallet opens again", async () => {
    let { openQrScanModal } = await import("./QrScanModal.js");
    decoder.fail = true;
    const scan = openQrScanModal();
    await loaded();
    expect(message()).toBe(FAILED);
    expect(button("Choose image").disabled).toBe(true);
    await close();
    await expect(scan).resolves.toBeNull();

    // The next scan in this page says so at once.
    openQrScanModal();
    await loaded();
    expect([message(), button("Choose image").disabled, decoder.loads]).toEqual([FAILED, true, 1]);
    await close();

    // The wallet opened again, a new page: it loads.
    decoder.fail = false;
    vi.resetModules();
    ({ openQrScanModal } = await import("./QrScanModal.js"));
    const again = openQrScanModal();
    await loaded();
    expect([button("Choose image").disabled, decoder.loads]).toEqual([false, 2]);
    await chooseImage();
    await expect(again).resolves.toBe(REQUEST);
  });

  it("turns the camera off when its decoder doesn't come, and when the scan closes before the camera starts", async () => {
    let { openQrScanModal } = await import("./QrScanModal.js");
    const first = camera();
    decoder.fail = true;
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => first.stream } });
    openQrScanModal();
    await loaded();
    expect(first.track.stop).toHaveBeenCalled();
    expect(message()).toBe(FAILED);
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
