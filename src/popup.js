// Entry point for popup/full/options pages.
// UI implementation lives under src/ui/popup.

import { reloadOldWorker } from "./ui/lib/oldWorker.js";
import { mountPopup } from "./ui/popup/app.js";

reloadOldWorker().catch(() => {});
mountPopup();
