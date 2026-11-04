// Amounts follow the browser's language: in tests, English unless one says otherwise.
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { ...globalThis.navigator, language: "en-US" } });
