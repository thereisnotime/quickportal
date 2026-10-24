## Why

An item whose `icon` is a URL rendered that icon at the full width of its card, pushing the name into a one-letter-per-line column beside it. One such item made a row of bookmarks unreadable; a portal where every item has a favicon, which is the normal case for a self-hosted stack, was unusable.

The cause: `.icon-img` set `width: 100%`, and because `.icon-slot` is `display: contents` the percentage resolved against the card rather than against the icon box. The img was never nested inside `.icon`, it *is* `.icon`, so it overrode the box it was supposed to fill.

This shipped in v0.1.0 and survived three releases. Nothing caught it because every example config and every screenshot used an emoji or the initials fallback, and neither variant sizes itself.

## What Changes

- The icon box owns its size, through a `--icon-size` custom property on `.icon`. The emoji, initials and image variants set no width or height at all.
- The two places that want a smaller icon, a group heading and an app tab, set `--icon-size` instead of restating width and height.
- A CI invariant fails the build if any `.icon-*` variant sizes itself again.

Not in this change: changing how large icons are, how they are fetched, or the initials fallback.

## Capabilities

### Modified Capabilities
- `portal-ui`: icon rendering gains a size requirement, alongside the existing one about degrading gracefully.

## Impact

- Any portal using URL or `auto` icons: those icons stop filling the card. No config change needed.
- Portals using only emoji or initials: no visible change, because those variants were never affected.
