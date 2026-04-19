# Contributing

> Guidelines for contributing to Dusk Wallet.

Thank you for your interest in contributing! This document will help you get started.

---

## Quick Start

```bash
# Clone the repository
git clone https://github.com/dusk-network/wallet.git
cd wallet

# Install dependencies
npm install

# Build in watch mode
npm run dev

# Load extension in Chrome
# 1. Navigate to chrome://extensions
# 2. Enable "Developer mode"
# 3. Click "Load unpacked"
# 4. Select the `dist/` folder
```

---

## Development Workflow

### Branch Naming

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feature/description` | `feature/multi-account` |
| Bug fix | `fix/description` | `fix/gas-estimation` |
| Documentation | `docs/description` | `docs/security-model` |
| Test | `test/description` | `test/wallet-engine` |
| Refactor | `refactor/description` | `refactor/message-bus` |

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description

[optional body]

[optional footer]
```

Types:
- `feat` — New feature
- `fix` — Bug fix
- `docs` — Documentation only
- `test` — Adding or updating tests
- `refactor` — Code change that neither fixes a bug nor adds a feature
- `chore` — Build, CI, dependencies

Examples:
```
feat(rpc): add dusk_estimateGas method
fix(vault): increase PBKDF2 iterations to 900k
docs: add security threat model
test(txDefaults): add coverage for edge cases
```

### Pull Requests

1. Create a feature branch from `main`
2. Make your changes
3. Run tests: `npm run test`
4. Push and open a PR
5. Fill out the PR template
6. Request review

---

## Code Style

### JavaScript

- ES modules (`import`/`export`)
- Prefer `const` over `let`
- Use async/await (not raw promises)
- No semicolons (project style)
- 2-space indentation

### Naming

| Type | Convention | Example |
|------|------------|---------|
| Files | camelCase | `walletEngine.js` |
| Components | PascalCase | `GasEditor.js` |
| Functions | camelCase | `getPublicBalance()` |
| Constants | SCREAMING_SNAKE | `DEFAULT_GAS_LIMIT` |
| Enums | SCREAMING_SNAKE | `TX_KIND.TRANSFER` |

### Documentation

- JSDoc for exported functions
- Inline comments for complex logic
- Update docs/ when changing APIs

```js
/**
 * Get cached gas price from node.
 * @param {Object} [opts]
 * @param {boolean} [opts.forceRefresh=false] - Bypass cache.
 * @returns {Promise<{average: string, max: string, median: string, min: string}>}
 */
export async function getCachedGasPrice({ forceRefresh = false } = {}) {
  // ...
}
```

---

## Testing

### Running Tests

```bash
# Run all tests
npm run test

# Run with coverage
npm run test:coverage

# Watch mode (for development)
npm run test -- --watch

# Run specific file
npm run test -- src/shared/amount.test.js
```

### Writing Tests

Tests live alongside source files:

```
src/shared/
├── amount.js
├── amount.test.js
├── chain.js
└── chain.test.js
```

Use Vitest:

```js
import { describe, it, expect } from "vitest";
import { formatAmount } from "./amount.js";

describe("formatAmount", () => {
  it("formats whole DUSK", () => {
    expect(formatAmount("1000000000")).toBe("1");
  });

  it("handles zero", () => {
    expect(formatAmount("0")).toBe("0");
  });
});
```

### Coverage Requirements

- Aim for 80%+ on new code
- Don't decrease overall coverage
- Focus on critical paths (crypto, transactions)

---

## Project Structure

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed structure.

Key areas:

| Directory | Purpose |
|-----------|---------|
| `src/shared/` | Platform-agnostic core logic |
| `src/background/` | Extension service worker |
| `src/ui/` | User interface components |
| `src/platform/` | Platform abstraction |
| `docs/` | Documentation |

---

## Adding Features

### New RPC Method

1. Add case in `src/background/rpc.js`:
```js
case "dusk_myMethod": {
  // validation
  return await engineCall("dusk_myMethod", params);
}
```

2. Add handler in `src/offscreen.js`:
```js
case "dusk_myMethod": {
  const result = await myFunction(params);
  sendResponse({ id, result });
  return;
}
```

3. Add logic in `src/shared/walletEngine.js`

4. Update `docs/provider-api.md`

5. Add tests

### New Transaction Type

1. Add to `TX_KIND` in `src/shared/constants.js`
2. Add defaults in `src/shared/txDefaults.js`
3. Add handler in `walletEngine.sendTransaction()`
4. Update tests

### New UI View

1. Create `src/ui/popup/views/myview.js`
2. Export render function
3. Add route in `src/ui/popup/app.js`
4. Add navigation if needed

---

## Building

### Extension

```bash
# Development (with watch)
npm run dev

# Production
npm run build
```

Output: `dist/`

### Tauri Desktop

```bash
cd apps/tauri

# Development
npm run tauri dev

# Production
npm run tauri build
```

### Tauri Mobile

```bash
cd apps/tauri

# Android
npm run tauri android dev
npm run tauri android build

# iOS
npm run tauri ios dev
npm run tauri ios build
```

---

## Debugging

### Extension

1. Open `chrome://extensions`
2. Click "Inspect views: service worker"
3. Use DevTools console and debugger

For popup:
1. Right-click extension icon
2. "Inspect popup"

### Tauri

```bash
# Run with DevTools enabled
npm run tauri dev
```

Press F12 or right-click → Inspect.

---

## Common Issues

### "Module not found"

Check import paths — use relative paths for local modules:
```js
import { foo } from "./shared/foo.js";  // ✓
import { foo } from "shared/foo.js";    // ✗
```

### "BigInt cannot be serialized"

Convert BigInt to string before message passing:
```js
sendResponse({ value: balance.toString() });
```

### Tests failing after changes

Run `npm run test` before committing. Check:
- Did you update test expectations?
- Did you break an API contract?

---

## Getting Help

- **Documentation**: Check `docs/` folder
- **Issues**: Search existing GitHub issues
- **Discord**: Join Dusk community

---

## Code of Conduct

Be respectful and constructive. We're all here to build great software.

---

## License

By contributing, you agree that your contributions will be licensed under the project's license.
