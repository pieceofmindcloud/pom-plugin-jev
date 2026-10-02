# Project agent memory

- `src/lib.rs`: ABI entry `pom_jev_plugin_v1`, embedded assets, and the loopback upstream (`/status`, `/models`, `/decide`) that forwards to `<gateway>/systemone` with the `host.configure` key. The browser never receives the key.
- `ui/src/jev.ts` is the browser client; POST goes straight to `/api/ui/plugins/jev/proxy/decide` (the host SDK only offers GET). `ui/src/host/runtime.ts` is the only place that touches `__POM_HOST__`.
- One menu item and one route (`/jev`); `screens/JevApp.tsx` shows Playground and Demo as tabs. Both fill the viewport without page scroll: panes scroll internally.
- `ui/src/snake.ts` holds the pure game rules and the decision state/question, `ui/src/snakeArt.ts` the drawing; `Demo.tsx` runs the loop: one `plan` choice per request over paths of 1-3 moves (`enumeratePaths`), an optional prefetch keyed by `positionKey`, and no request when only one path survives.
- Menu icons must exist in the POM host map (`apps/frontend/src/components/nav.ts` in the POM repo).
- The release workflow publishes GitHub releases only (public plugin). `release/manifest.json` is the release contract, `ui/manifest.json` the UI contract.
- Check with `scripts/build-ui.sh && cargo test && cargo fmt --check`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project. Do not repeat what the codebase already shows; point to the authoritative file or command instead. Prefer rewriting or pruning existing entries over appending new ones.
