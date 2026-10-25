# My Layout (a Sail layout starter)

A layout pack changes how Sail is laid out and looks. It is only a manifest, CSS, images and fonts, with no code,
so anyone can install it safely. Library Layouts (the engine) builds the parts your pack asks for.

## Make it yours

1. Unzip this folder somewhere you keep your projects.
2. In `plugin.json`, change `id` to `yourname.layout-name` (lowercase, never reused for something else), and set
   `name`, `author` and `description`.
3. In Sail, open Library Layouts' settings (the gear at the bottom of the left panel), turn on **Developer mode**
   and pick this folder with **Choose folder…** in the panel that appears, or paste its path into **Layout folder**.
4. Edit `layout.css` and `plugin.json`. Every time you save, Sail shows the change. The developer panel lists
   anything the engine refused or ignored, and lets you try your options without saving them.

## What goes where

- `plugin.json` → `layout.blocks`: which parts the engine builds (`titleBar`, `tabs`, `gameList`, `home`,
  `gamePage`, `manageGame`, `profilePage`, `bottomBar`, `friendsPanel`). Leave one out and Sail's own interface
  stays in that spot.
- `layout.tokens`: `--sl-*` colours and fonts the engine's parts use.
- `layout.labels`: the engine's own words, such as `recentGames` or `allGames` (`{count}` is the number of games).
- `settings`: options people can change. A toggle that is on adds `sl-opt-<id>` to the page, a choice adds
  `sl-opt-<id>-<value>`, so your CSS can follow them, and a block value can follow one:
  `{ "setting": "shelf", "values": { "true": "recent", "false": "none" } }`.
- `layout.css`: your look. The comments at the top list every part of Sail you can style.
- `preview.png` (optional, add `"preview": "preview.png"` to `layout`): a picture of your layout, kept for a
  layout picker with pictures (Library Layouts doesn't show it yet).

## Share it

Zip the folder (the zip holds the folder itself, with `plugin.json` inside it) and upload it to Sail Hub as a
plugin. Keep the `requires` entry: it tells Sail to offer Library Layouts to anyone who doesn't have it yet.

The full guide is in the Sail Hub docs: https://sailhub.fyi/docs/sail-launcher/layouts/
