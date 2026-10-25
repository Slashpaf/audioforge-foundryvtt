# Changelog

All notable changes to this module. Versions follow `module.json`; each release has a matching `vX.Y.Z` tag.

## 0.2.2 - 2026-10-25

- Online rooms: the room opens when the first player connects and closes a minute after the last listener leaves, including guests who joined with the link. A room you open yourself is never closed for you, and one you close by hand stays closed until everyone has left once.
- The panel and the profile editor list the categories enabled for the anvil in the app, so a disabled category no longer shows. A category that is also an echo (such as Ghost) shows in both lists.
- Online rooms recover when Audio Forge is closed and reopened: the dead room is closed for the players and a new one opens, which they join on their own.
- Download link to Audio Forge in the panel and the room window while it is not connected, and a short note with the link in the player's room window.

## 0.2.1 - 2026-10-25

- Online rooms: Audio Forge opens an online room when it connects (a setting turns that off), and players join automatically and listen inside Foundry. The GM sees who is in and who was turned away because the room is full (with a reminder that subscribing to Audio Forge removes the limit), and can remove players or connect them on demand. With an older Audio Forge the room still opens and plays, but the player list and removal are not available.
- The panel and the scene and combat profile editor list only categories that can be played (those with tracks).
- The control panel scrolls when it is taller than the window.
- Translations of the online room and its settings: French, Italian, Dutch, German, Spanish and Brazilian Portuguese.

## 0.1.3 - 2026-10-25

- Translations: French, Italian, Dutch, German, Spanish and Brazilian Portuguese.

## 0.1.2 - 2026-10-25

First public release.

- GM control panel: play, pause, stop and next per section, volumes, category toggles, echoes, saved states and library switching. Open it from the sound controls, a macro, or `Alt+A`.
- Scene audio: attach a profile to a scene that restores a saved Audio Forge state or picks music and ambiance. It runs when the scene is activated or on demand.
- Combat audio: profiles for combat start and combat end.
- Macro API at `game.modules.get("audioforge").api`, plus the `audioforge.connection` and `audioforge.state` hooks.
- Connects to Audio Forge's Local API over WebSocket with automatic reconnect. Only GM clients connect.
- Requires Foundry VTT v13 or newer. Tested on v14.
