// Entry point for notification approval window.
// Implementation lives under src/ui/notification.

import { reloadOldWorker } from "./ui/lib/oldWorker.js";
import { mountNotification } from "./ui/notification/app.js";

reloadOldWorker().catch(() => {});
mountNotification();
