# pom-plugin-jev

POM-JEV (plugin code `jev`): typed decisions (`noul`, `choice`, `score`) from the model
your POM serves, through the POM `/v1/systemone` endpoint. The plugin adds a
**POM-JEV** item to the POM sidebar. Its screen has two tabs:

- **Playground**: an editor to build typed questions over a state, run them
  against a model and read calibrated answers.
- **Demo**: Snake, steered by POM-JEV one decision per move from positions only.

See [docs/README.md](docs/README.md) for the API and how the POM computes the
answers.

## Layout

```text
src/lib.rs            Plugin ABI, embedded UI assets and the loopback server
                      (/status, /models, /decide) that forwards to the POM
                      gateway with the key from host.configure
ui/manifest.json      pom-plugin-ui/v1 menu, routes, screens and assets
ui/src/jev.ts         Browser client: decide(), listModels(), curl export
ui/src/builder.ts     Playground request model, validation and JSON round trip
ui/src/snake.ts       Snake rules, decision state and the move question
ui/src/snakeArt.ts    Snake drawing (grass, tapered snake, slide animation)
ui/src/screens/       JevApp (tab bar), Playground and Demo
i18n/                 en and pt-BR catalogs
release/manifest.json Release contract (plugin_code jev, feature jev.core)
scripts/              build-ui, build, package and CI plan
```

## Requirements

A POM whose gateway serves `/v1/systemone` (the logit probe). The POM shares
its gateway URL and a plugin API key through `host.configure`; without them
`/decide` answers 503.

## Build and test

```bash
scripts/build-ui.sh
cargo test
scripts/package.sh --platform linux-x86_64 --version 0.1.0
```

## Release

Run the **Publish plugin release** workflow
(`.github/workflows/publish-release.yml`) with the platforms and a `vX.Y.Z`
tag per platform. It builds, tests and attaches
`pom-plugin-jev-<platform>.*` and `pom-plugin-<platform>.json` to a GitHub
release; in the POM, Plugins -> Add from GitHub installs it.
