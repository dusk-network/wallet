import { isTauriRuntime } from "../../platform/runtime.js";

/**
 * Whether this is a phone or a tablet, whose keyboard is on the screen: by the
 * browser's own name for its system, as touch media queries vary with what an
 * emulator or a tablet has plugged in.
 * @param {Navigator} [nav]
 */
export const isPhone = (nav = globalThis.navigator) => /Android|iPhone|iPad|iPod/i.test(String(nav?.userAgent ?? ""));

/** Where the wallet keeps its data, in words: "this browser", or in the app "this phone" or "this computer". */
export const thisDevice = () => (!isTauriRuntime() ? "this browser" : isPhone() ? "this phone" : "this computer");
