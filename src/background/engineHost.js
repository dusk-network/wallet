// Select the engine host implementation based on build-time target.

import { ENGINE_HOST } from "../platform/targets.js";
import * as offscreenHost from "./offscreen.js";
import * as enginePageHost from "./enginePage.js";

const host = ENGINE_HOST === "enginePage" ? enginePageHost : offscreenHost;

export const engineCall = (...args) => host.engineCall(...args);
export const ensureEngineConfigured = (...args) => host.ensureEngineConfigured(...args);
export const getEngineStatus = (...args) => host.getEngineStatus(...args);
export const getEngineStatusStrict = (...args) => host.getEngineStatusStrict(...args);
export const invalidateEngineConfig = (...args) =>
  host.invalidateEngineConfig(...args);
export const handleEngineReady = (...args) =>
  typeof host.handleEngineReady === "function"
    ? host.handleEngineReady(...args)
    : undefined;
// The engine's page closing, which ends the wallet open in it: Firefox's tab.
// Chrome's offscreen document closes only as the background closes it.
export const onEngineClosed = (...args) =>
  typeof host.onEngineClosed === "function"
    ? host.onEngineClosed(...args)
    : undefined;
