## Why

The toolbar has grown one button per preference. Theme is a three-state cycle button: to reach dark from auto you press it once and read the label to find out where you landed, and there is no way to see the three options at all. It is the only appearance preference the viewer can change, and it already costs a permanent toolbar slot plus its own label.

Two preferences that belong next to it have nowhere to go. **Contrast** is not offered at all, so a viewer who needs stronger separation between a card and its background has no recourse. **Density** exists, but only the operator can set it, in the config, for everybody: the person reading a 40-item portal on a 13-inch laptop cannot tighten it for themselves, and the operator cannot pick a value that suits both them and a phone.

Adding each of those as another toolbar button does not scale, and on a 320px screen the toolbar is already the tightest row on the page.

## What Changes

- A **settings menu**: one popup, opened from a single toolbar button, holding every appearance preference as a visible set of choices rather than a cycle.
- **Theme** moves into it, as three explicit options (auto, light, dark) with the current one marked, so all three are visible and reachable in one press.
- **Contrast** becomes a viewer preference: normal, or high contrast with stronger borders, stronger text and a flatter surface treatment, in both light and dark.
- **Density** becomes a viewer preference too, layered over the operator's `layout.density` default rather than replacing it: the config still decides what a fresh browser gets.
- **Motion** becomes a viewer preference: follow the system, or force reduced motion for a viewer whose OS setting does not match how they want this page to behave.
- Every preference persists per browser, and a viewer's choice beats the config value, as the theme already does.
- The command palette keeps a one-press path to each preference, so the popup is never the only way in.

Not in this change: a font size or typeface preference, per-item or per-group appearance overrides, syncing preferences anywhere (there is no server), or new config keys for contrast and motion. The operator sets neither: both are accessibility preferences that belong to the person reading, not to the person deploying.

## Capabilities

### Modified Capabilities
- `portal-ui`: the settings popup, its keyboard and accessibility behaviour, the theme requirement restated as an explicit choice, and new contrast, density-override and motion requirements.

## Impact

- The theme cycle button is gone from the toolbar. Anyone who used it will find the same choice one press away in the settings popup, with the other two states visible instead of guessed at.
- One more toolbar button is removed than added, so the tightest row on a 320px screen gets tighter rather than wider.
- High contrast is a second colour pass over the token set, which means every component is now rendered under four combinations (light, dark, and each at high contrast) rather than two. That is the real cost in this change and it falls on the stylesheet, not the markup.
- No config change, no new policy, nothing new fetched. Existing deployments see a different toolbar and nothing else until a viewer opens the popup.
