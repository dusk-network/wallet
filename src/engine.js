// Engine page entrypoint (Firefox fallback).
import "./engine/runtime.js";
import { startKeepOpenPage } from "./engine/keepOpenPage.js";

// The tab it runs in: the way back into the wallet, and the last payment's word.
startKeepOpenPage();
