# Changelog

All notable changes to this module. Versions follow `module.json`; each release has a matching `vX.Y.Z` tag.

## 0.1.3 - 2026-10-25

- Translations: French, Italian, Dutch, German, Spanish and Brazilian Portuguese.
- The panel and the scene and combat profile editor list categories that have no tracks yet, so profiles can be set up before the sounds are added.

## 0.1.2 - 2026-10-25

First public release.

- GM control panel: play, pause, stop and next per section, volumes, category toggles, echoes, saved states and library switching. Open it from the sound controls, a macro, or `Alt+A`.
- Scene audio: attach a profile to a scene that restores a saved Audio Forge state or picks music and ambiance. It runs when the scene is activated or on demand.
- Combat audio: profiles for combat start and combat end.
- Macro API at `game.modules.get("audioforge").api`, plus the `audioforge.connection` and `audioforge.state` hooks.
- Connects to Audio Forge's Local API over WebSocket with automatic reconnect. Only GM clients connect.
- Requires Foundry VTT v13 or newer. Tested on v14.
