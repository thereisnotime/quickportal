## Why

QuickPortal opens a bookmark in a browser tab. That is the right default, and it is also why it cannot replace the kind of start page that keeps several apps open inside itself: a tab strip where each app is loaded in place, refreshed as a group, and closed as a group, without leaving the page.

Embedding was ruled out of v0.1.0 deliberately, because framing someone else's app requires that app to permit framing, and the header changes that enables are a security decision that does not belong in a default. That reasoning still holds for the default. It does not hold as a reason to refuse the capability to people who have already made that decision for their own cluster, and who currently have to keep a separate hand-written page to get it.

## What Changes

- New opt-in **embedding**: an item may declare that it opens inside the portal rather than in a browser tab, in a tab strip above the content area.
- **Open tabs survive a live config reload.** A config edit must not remount a frame, because remounting throws away whatever state the embedded app held, which is the one thing that makes embedding worth having.
- **Group operations** on open tabs: refresh all, close all, and a focus mode that hides the portal's own chrome so the embedded app gets the viewport.
- **A cap on concurrently mounted frames**, with the oldest evicted and a visible count, because each frame is a full application and a dozen of them will exhaust a laptop.
- **An honest escape hatch.** A frame that the target refuses renders blank and tells us nothing we can read, so every embedded item keeps a visible "open in a new tab" action, and the documentation states plainly what the target must send for embedding to work at all.
- **The portal's own CSP has to allow framing**, which the shipped server config currently forbids. Embedding therefore becomes a two-part switch: the item opts in, and the deployment widens `frame-src`. Both are documented together, and neither default changes. **BREAKING for nobody**: with no embedded items and no server-config change, the rendered output and the CSP are byte-identical to v0.1.0.

Not in this change: embedding as a default, iframe sandboxing strong enough to contain a hostile app, or any attempt to detect whether the target allowed framing, because the browser does not expose that cross-origin.

## Capabilities

### New Capabilities
- `app-embedding`: declaring an item as embedded, the tab strip, mounting and eviction, group refresh and close, focus mode, the new-tab escape hatch, and the behaviour when a target refuses framing.

### Modified Capabilities
- `bookmark-config`: new per-item fields for embedding, and their validation.
- `portal-ui`: a re-render must preserve mounted frames, and the tab strip has to be keyboard operable like the rest of the page.
- `kubernetes-deployment`: `frame-src` becomes configurable, with framing still forbidden by default.
- `live-config-reload`: a config change must not interrupt an embedded session.

## Impact

- No change for anyone who does not opt in: same manifests, same CSP, same rendered output.
- A new coupling between the bookmark config and the server config that users can get half-right. A config asking for embedding while the CSP still forbids it must say so on the page rather than silently showing a blank frame.
- Cross-site cookies are the known sharp edge: an app on an unrelated site may lose its session inside a frame under current browser cookie rules, which is nothing QuickPortal can fix and must be documented rather than discovered.
- Memory and CPU become a user-visible concern for the first time, so the frame cap and the count are part of the feature, not a later optimisation.
