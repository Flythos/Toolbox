# Toolbox

A floating toolbox for SillyTavern: move tools **out** of the hamburger options menu (☰) and the wand menu (✨) **into** one draggable launcher — per-tool, reversible, and with custom stscript buttons on top.

## What it does

- Adds a floating toolbox button (draggable, position remembered) that opens a resizable toolbox panel with a grid of tool buttons.
- Settings control (**Extensions → Toolbox**) lists every entry discovered in the two menus:
  - **checked** → the tool leaves its menu (hidden with a persistent stylesheet rule) and lives in the toolbox;
  - **unchecked** → the tool returns to its original menu.
- Re-homed tools keep working exactly as before: the toolbox triggers the original (hidden) menu entry, the same way SillyTavern's own slash commands do.
- Tools that only make sense in some contexts (Save checkpoint, Back to parent chat, TTS…) appear in the toolbox only while their original menu entry is currently visible.
- **Custom tools**: your own buttons (label + FontAwesome icon + slash-command script). Plugin actions that register slash commands can be driven this way. Custom tools never touch any menu.
- "Toolbox contents" section reorders the tools (up/down arrows).

Notes:

- When every wand-menu entry is re-homed, SillyTavern hides the wand button itself — that's core behavior, and usually exactly the decluttering you wanted.
- The toolbox hides menu entries via CSS (`!important` rules), so the hiding survives re-renders, chat changes, and core's own show/hide calls.
- Disabling/deleting an extension while one of its tools is re-homed is safe: the settings row is marked "missing" and the tool reappears in the wand menu when the extension comes back.

## Install

Extensions → Install extension → paste:

```
https://github.com/Flythos/Toolbox
```

Restart SillyTavern and hard-refresh the browser (Ctrl+F5).

## How it works

- Discovery: options-menu items are the stable `#option_*` anchors; wand entries are the uniquely-id'd `list-group-item` items that extensions append once at init. A `MutationObserver` on the wand menu keeps the catalogs current for late-loading extensions.
- Hiding: one `<style>` element regenerated from the settings — `#options a#id{display:none!important}` / `#extensionsMenu #id{display:none!important}`. The original elements stay in the DOM and remain clickable.
- Execution: jQuery `.trigger('click', { fromSlashCommand: true })` on the original element (the visible copy for duplicate ids); custom tools run via `executeSlashCommands`.
- Panel: standard `#movingDivs` floating panel (`dragElement` + moving-UI state); opener button uses pointer-event drag with a 5 px click threshold and stores its position in the extension settings.

## Development

```
npm test        # registry logic (pure, DOM-free) tests
npm run audit   # verifies every named import against the SillyTavern 1.19.0 clone
```
