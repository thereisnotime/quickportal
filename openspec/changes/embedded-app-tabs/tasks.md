## 1. Config layer

- [ ] 1.1 Accept and validate `embed`, `allow` and `sandbox` on an item, plus top level `embedding.maxFrames`, with documented defaults
- [ ] 1.2 Reject `embed: true` on a scheme that cannot be framed, and warn on unknown `allow` tokens rather than passing them through
- [ ] 1.3 Expose which items are embedded through the normalized config so the view layer needs no second pass
- [ ] 1.4 Tests for every scenario in the `bookmark-config` delta

## 2. Frame host, outside the re-rendered tree

- [ ] 2.1 Add the frame container to `index.html` as a sibling of the bookmark tree, never a descendant of it
- [ ] 2.2 `src/assets/frames.js`: mount, focus, refresh, close, close-all, refresh-all, keyed by item id, with the frame cap and least-recently-focused eviction
- [ ] 2.3 Guarantee no reparenting: a test that re-renders with a frame mounted and asserts the element identity is unchanged, including when the item is renamed or moved between groups
- [ ] 2.4 Close the tab with a notice when its item disappears from the config
- [ ] 2.5 Tests for mounting, eviction order, the cap, and that nothing reloads on re-render, theme change, filter or set open

## 3. Tab strip and focus mode

- [ ] 3.1 Render the strip: selected state, count against the cap, close affordance per tab
- [ ] 3.2 Keyboard: arrow keys between tabs, close from the keyboard with predictable focus afterwards, correct roles and accessible names
- [ ] 3.3 Focus mode hiding the chrome, keeping the strip, reversible with Escape, unmounting nothing
- [ ] 3.4 The overlay offering the browser-tab escape after a frame has shown nothing, dismissible and worded as possible causes
- [ ] 3.5 Remember and restore the open set per browser, discarding entries whose items no longer exist

## 4. Serving and deployment

- [ ] 4.1 Make `frame-src` configurable in the server config, defaulting to `'none'`
- [ ] 4.2 Kustomize patch and Helm value for the permitted frame origins, neither enabled by default
- [ ] 4.3 Detect our own CSP refusing a frame and report the half-configured state with the header to change
- [ ] 4.4 CI assertion that with the feature unused the rendered manifests and headers are byte-identical to the previous release

## 5. Documentation

- [ ] 5.1 Configuration reference: the new fields, the cap, and the two-part switch
- [ ] 5.2 A page on what the target app must send for framing to work, written so it can be handed to someone who owns that app
- [ ] 5.3 The cross-site cookie limitation, next to the header requirements, since the symptom looks like an application bug
- [ ] 5.4 README: embedding is opt-in, why it is not the default, and that the portal cannot tell you whether a target refused

## 6. Release

- [ ] 6.1 Verify on a cluster: an embedded app that frames, one that refuses, and a config change while a frame is in use
- [ ] 6.2 Confirm an upgrade with no embedded items changes nothing on the wire
- [ ] 6.3 Tag the minor release and document the two steps to enable embedding
