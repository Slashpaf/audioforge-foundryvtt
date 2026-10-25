# Contributing

Thanks for helping improve Audio Forge for Foundry VTT. See [ASSET_LICENSE.md](ASSET_LICENSE.md) for the licensing status of the Audio Forge name, branding and logo.

## Development setup

- Node.js and npm.
- Foundry VTT v13 or newer (the module has been run on v14).
- Audio Forge with the Local API enabled for runtime checks (default port `8329`).

```sh
npm install
npm test                        # client, profile and room logic against a mock Local API server
node scripts/verify-module.mjs  # module.json is installable, listed files exist, the changelog has this version
```

To try the module in Foundry, symlink this folder into `Data/modules/audioforge` and reload the world. Changes to `module.json` (for example the `socket` flag) only take effect after you return to setup and relaunch the world.

The code is plain ES modules with no build step. The root MIT `LICENSE` covers the module code and documentation; `ASSET_LICENSE.md` separates the Audio Forge name, branding and the bundled logo glyph from that grant.

## Translations

`lang/en.json` is the source. When you add or change a string, update the other files in `lang/` too, keeping `{placeholders}` such as `{name}` and `{max}` exactly as they are. If you cannot translate a string, say so in the pull request rather than leaving a different language in a file.

## Releasing

The workflow in `.github/workflows/` runs the checks on every push. On a `vX.Y.Z` tag it builds `module.zip` and a release `module.json` and creates a **draft** GitHub Release for review.

1. Set the new `version` in `module.json` and `package.json`, and use the same version in the `download` URL in `module.json` (the check fails if they differ).
2. Add a section for that version to `CHANGELOG.md` (the workflow takes the release notes from it and fails without one), then commit and push.
3. Push the matching tag, such as `v1.2.3`. The tag must match the version in `module.json`.
4. Review the draft release, then publish it. Publishing is what makes the `latest/download/module.json` manifest URL point to it.

## Pull requests

- Explain the user-visible change and any compatibility impact, including which Audio Forge version it needs.
- Add or update tests in `test/` for logic that does not need Foundry itself.
- Run `npm test` and `node scripts/verify-module.mjs`, and say if you could not try the change in Foundry.
- Do not commit API keys, passwords, local configuration or generated files.
- If screenshots or other artwork change, identify their source and redistribution terms.
