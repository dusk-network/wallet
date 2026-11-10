import { h } from "../lib/dom.js";
import { parsePaymentLink } from "@dusk-network/app-core/payment-links";
import { iconSvg } from "./ActionIcon.js";
import { stepAway } from "../../platform/native.js";

const DECODER_FAILED = "The QR scanner couldn't load. Close the wallet and open it again.";

// The QR decoder loads with the first scan, not with the popup. A failed load
// stays failed in this page, as the browser keeps it: the wallet opened again
// loads it afresh.
let decoderLoad = null;
const loadDecoder = () => (decoderLoad ??= import("jsqr").then((mod) => mod.default));

function clamp(n, a, b) {
  return Math.min(b, Math.max(a, n));
}

/**
 * Read a request link or a recipient, as a QR code holds or a person pastes it:
 * a `dusk:` link, an https link to the web wallet's Send, or a recipient as it is.
 */
export function parseDuskQrPayload(input) {
  return parsePaymentLink(input);
}

async function decodeFromImageEl(img, jsQR) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas not supported");

  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return null;

  // Downscale very large images for performance
  const maxSide = 1000;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  canvas.width = Math.max(1, Math.floor(w * scale));
  canvas.height = Math.max(1, Math.floor(h * scale));
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const res = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: "attemptBoth",
  });
  return res?.data || null;
}

function stopStream(stream) {
  if (!stream) return;
  try {
    for (const t of stream.getTracks()) {
      try {
        t.stop();
      } catch {}
    }
  } catch {}
}

/**
 * Opens a modal that scans a QR code.
 *
 * - Uses camera (getUserMedia) when available.
 * - Offers an image upload / camera capture fallback.
 *
 * Resolves with the raw QR string, or `null` if cancelled.
 */
export function openQrScanModal({ title = "Scan QR", hint = "Point your camera at a QR code" } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let stream = null;
    let raf = 0;
    let lastScan = 0;
    const decoder = loadDecoder();
    // Without the decoder nothing scans: its message stays.
    let unavailable = false;

    const err = h("div", { class: "qrscan-hint", style: "display:none" });
    const setErr = (txt) => {
      if (unavailable) return;
      if (!txt) {
        err.style.display = "none";
        err.textContent = "";
        return;
      }
      err.style.display = "block";
      err.textContent = String(txt);
    };

    const overlay = h("div", { class: "qrscan-overlay" });
    const modal = h("div", { class: "qrscan-modal" });
    const head = h("div", { class: "qrscan-head" }, [
      h("div", { class: "qrscan-title", text: title }),
      h("button", {
        class: "icon-btn icon-only",
        type: "button",
        html: iconSvg("close"),
        onclick: () => finish(null),
        title: "Close",
        "aria-label": "Close",
        "data-back": "",
      }),
    ]);

    const video = h("video", {
      class: "qrscan-video",
      autoplay: "true",
      muted: "true",
      playsinline: "true",
    });
    video.setAttribute("playsinline", "true");

    // Shown once the camera plays: without one, an empty player says only
    // "Unable to play media" (the app's WebView).
    const videoWrap = h("div", { class: "qrscan-video-wrap", hidden: true }, [video]);
    const hintEl = h("div", { class: "qrscan-hint", text: hint, hidden: true });
    // No camera: its message and Choose image, nothing that waits for one.
    const noCamera = (text) => {
      videoWrap.hidden = true;
      hintEl.hidden = true;
      setErr(text);
    };

    const fileInput = h("input", {
      type: "file",
      accept: "image/*",
      capture: "environment",
      style: "display:none",
    });

    // The step away the phone's picker or camera question is: over once the
    // scan closes, whatever came of it.
    let backFromAway = () => {};
    const chooseBtn = h("button", {
      class: "btn-outline",
      text: "Choose image",
      onclick: () => {
        // The phone's picker, a moment away from the wallet.
        backFromAway = stepAway();
        fileInput.click();
      },
    });

    const cancelBtn = h("button", {
      class: "btn-outline",
      text: "Cancel",
      onclick: () => finish(null),
    });

    const actions = h("div", { class: "qrscan-actions" }, [chooseBtn, cancelBtn]);
    const body = h("div", { class: "qrscan-body" }, [videoWrap, hintEl, err, actions, fileInput]);

    modal.appendChild(head);
    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function finish(value) {
      if (done) return;
      done = true;
      backFromAway();
      if (raf) cancelAnimationFrame(raf);
      stopStream(stream);
      try {
        overlay.remove();
      } catch {}
      resolve(value);
    }

    // Close when clicking outside the modal
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });

    decoder.catch(() => {
      if (done) return;
      setErr(DECODER_FAILED);
      unavailable = true;
      chooseBtn.disabled = true;
      stopStream(stream);
    });

    // Decode from uploaded/captured image
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;

      setErr("");
      let jsQR;
      try {
        jsQR = await decoder;
      } catch {
        return;
      }
      try {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = async () => {
          try {
            const data = await decodeFromImageEl(img, jsQR);
            URL.revokeObjectURL(url);
            if (data) finish(data);
            else setErr("No QR code found in image");
          } catch (e) {
            URL.revokeObjectURL(url);
            setErr(e?.message ?? String(e));
          }
        };
        img.onerror = () => {
          try {
            URL.revokeObjectURL(url);
          } catch {}
          setErr("Failed to load image");
        };
        img.src = url;
      } catch (e) {
        setErr(e?.message ?? String(e));
      }
    });

    // Camera scanning
    async function startCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        noCamera("Camera not available. You can still choose an image.");
        return;
      }

      // The phone may ask about the camera, over the wallet: a camera allowed
      // or refused already asks nothing, and the step away ends with the answer.
      const asked = (backFromAway = stepAway());
      try {
        const baseVideo = {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        };

        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { ...baseVideo, facingMode: { exact: "environment" } },
            audio: false,
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { ...baseVideo, facingMode: { ideal: "environment" } },
            audio: false,
          });
        } finally {
          asked();
        }

        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        video.setAttribute("webkit-playsinline", "true");
        await video.play();
        // Closed meanwhile: the camera goes with it.
        if (done) {
          stopStream(stream);
          return;
        }
        videoWrap.hidden = false;
        hintEl.hidden = false;
      } catch {
        stopStream(stream);
        noCamera("Camera permission denied or unavailable. You can still choose an image.");
        return;
      }

      let jsQR;
      try {
        jsQR = await decoder;
      } catch {
        stopStream(stream);
        return;
      }
      // Closed meanwhile: the camera goes with it.
      if (done) {
        stopStream(stream);
        return;
      }

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        setErr("Canvas not supported");
        return;
      }

      const tick = (now) => {
        if (done) return;

        // Limit scan rate for performance (~12fps)
        if (now - lastScan < 80) {
          raf = requestAnimationFrame(tick);
          return;
        }
        lastScan = now;

        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (vw && vh) {
          const vMax = Math.max(vw, vh);
          const targetMax = clamp(vMax, 320, 900);
          const scale = targetMax / vMax;
          canvas.width = Math.max(1, Math.floor(vw * scale));
          canvas.height = Math.max(1, Math.floor(vh * scale));

          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const res = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: "attemptBoth",
          });
          if (res?.data) {
            finish(res.data);
            return;
          }
        }
        raf = requestAnimationFrame(tick);
      };

      raf = requestAnimationFrame(tick);
    }

    startCamera().catch(() => {
      noCamera("Camera not available. You can still choose an image.");
    });
  });
}
