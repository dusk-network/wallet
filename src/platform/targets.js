// Build-time targets for the extension runtime.

export const EXTENSION_TARGET =
  typeof __DUSK_TARGET__ !== "undefined" ? __DUSK_TARGET__ : "chrome";

export const ENGINE_HOST =
  typeof __DUSK_ENGINE_HOST__ !== "undefined"
    ? __DUSK_ENGINE_HOST__
    : "offscreen";

export const IS_CHROME = EXTENSION_TARGET === "chrome";
export const IS_FIREFOX = EXTENSION_TARGET === "firefox";
