# Patched dependencies

pnpm applies these patches on install (`patchedDependencies` in `pnpm-workspace.yaml`).

| Package | License | Why |
|---|---|---|
| `@novnc/novnc@1.7.0` | MPL-2.0 (core); source: <https://github.com/novnc/noVNC/tree/v1.7.0> | `core/util/browser.js` checked H.264 support with a top-level `await`, which makes the web app's bundler split every chunk differently (startup JS +12 KB). The patched file sets the flag when the check finishes instead. The patch is the modified source under MPL-2.0. |
