import jsQR from "jsqr";
import { h } from "../lib/dom.js";
import { parseDuskUri } from "../../shared/duskUri.js";

function clamp(n, a, b) {
  return Math.min(b, Math.max(a, n));
}

/**
 * Parse a scanned QR payload.
 *
 * Supported inputs:
 * - Raw base58 recipient string
 * - Canonical Dusk URI: `dusk:public-<recipient>@<chain>?amount=...&memo=...`
 * - Canonical Dusk URI: `dusk:shielded-<recipient>@<chain>?amount=...&memo=...`
 */
export function parseDuskQrPayload(input) {
  return parseDuskUri(input);
}

async function decodeFromImageEl(img) {
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

    const err = h("div", { class: "qrscan-hint", style: "display:none" });
    const setErr = (txt) => {
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
        text: "✕",
        onclick: () => finish(null),
        title: "Close",
        "aria-label": "Close",
      }),
    ]);

    const video = h("video", {
      class: "qrscan-video",
      autoplay: "true",
      muted: "true",
      playsinline: "true",
    });
    video.setAttribute("playsinline", "true");

    const videoWrap = h("div", { class: "qrscan-video-wrap" }, [video]);
    const hintEl = h("div", { class: "qrscan-hint", text: hint });

    const fileInput = h("input", {
      type: "file",
      accept: "image/*",
      capture: "environment",
      style: "display:none",
    });

    const chooseBtn = h("button", {
      class: "btn-outline",
      text: "Choose image",
      onclick: () => fileInput.click(),
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

    // Decode from uploaded/captured image
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;

      setErr("");
      try {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = async () => {
          try {
            const data = await decodeFromImageEl(img);
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
        setErr("Camera not available. You can still choose an image.");
        return;
      }

      try {
        // Prefer back camera on mobile.
        // Some WebViews ignore `ideal`, so we attempt `exact` first and fall back otherwise.
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
        }

        video.srcObject = stream;
        // iOS/Safari/WebView friendliness (no-op elsewhere)
        video.setAttribute("playsinline", "true");
        video.setAttribute("webkit-playsinline", "true");
        await video.play();
      } catch (e) {
        setErr("Camera permission denied or unavailable. You can still choose an image.");
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

        // Limit scan rate for performance (about ~12fps)
        if (now - lastScan < 80) {
          raf = requestAnimationFrame(tick);
          return;
        }
        lastScan = now;

        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (vw && vh) {
          // Downscale so the largest side is <= 900px for decode speed
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

    startCamera().catch(() => {});
  });
}
