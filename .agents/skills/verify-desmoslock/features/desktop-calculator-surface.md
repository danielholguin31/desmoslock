# Isolated calculator surface

Surface: apps/desktop. Verification status on the Mac Mini: **exercised (`electron-suite`)**.

The graphing calculator used during an assessment. It runs in its own `WebContentsView`, served from `desmoslock-calculator://host/index.html`, with no preload and a network policy that allows only its own resources.

Source: `apps/desktop/src/main/electron-calculator-surface.ts`, `apps/desktop/src/main/calculator-assets.ts`, `apps/desktop/src/main/assessment-session-policy.ts`, `apps/desktop/src/calculator/host.ts`, `tests/e2e/electron/calculator-isolation.spec.ts`.

## Sub-features

- Assets: `desmoslock-calculator://host/{index.html,host.js,styles.css}` (`main/calculator-assets.ts`), host renderer `apps/desktop/src/calculator/host.ts`.
- Attach and teardown: `prepareElectronCalculatorSurface` (`main/electron-calculator-surface.ts`), called only from the Start pipeline.
- Resource and navigation policy: `main/assessment-session-policy.ts`.

## How to get to it (user POV)

Only visible while an assessment is protected. There is no direct user entry.

## Driving it with verify-desmoslock

`node .agents/skills/verify-desmoslock/scripts/verify-desmoslock.mjs electron-suite` runs `tests/e2e/electron/calculator-isolation.spec.ts` (preload isolation, plotting and zoom, hostile network/popup/navigation/download/permission attempts, legacy-bridge refusal, teardown), `calculator-startup.spec.ts`, and `calculator-close.spec.ts` with the repo fixtures in `tests/e2e/electron/fixtures/`. Evidence: `electron-suite/playwright.log` (9 passed).

## Gotchas

- The specs use synthetic fixtures that mount the production calculator surface. They do not go through the Student Start flow.
