## Context

v0.1.0 opens bookmarks in browser tabs and says embedding is out of scope. The reason given was that framing another app requires that app to permit framing, and the headers that allows are a per-deployment security decision. That is still true, and it is why embedding stays off by default here. What changed is the realisation that the decision is not ours to withhold: an operator who has already permitted framing in their own cluster currently has to maintain a separate hand-written page to get a workspace, which is exactly the duplication this project was meant to end.

The hard part is not drawing a tab strip. It is that almost everything about a cross-origin frame is invisible to us, and that the state inside a frame is destroyed by any re-render that touches its node.

## Goals / Non-Goals

**Goals:**

- An item can open inside the portal, in a tab strip, instead of in a browser tab.
- Open frames survive a live config reload untouched.
- Refresh all, close all, and a focus mode that gives the frame the viewport.
- A bounded number of mounted frames, with the limit and the current count visible.
- When framing cannot work, say so and offer a real alternative instead of showing a blank rectangle.
- Nothing changes for anyone who does not opt in, including the CSP.

**Non-Goals:**

- **Embedding by default.** Not now, not later. It requires cooperation from the target app.
- **Detecting whether the target allowed framing.** The browser does not expose it; see Decisions.
- **Containing a hostile app.** A frame with cookies and storage is not a sandbox. Embedding is for apps you already trust enough to log into.
- **Making a cross-site app's cookies work.** Not in our gift.
- **Proxying apps through the portal to defeat their headers.** That would mean a backend, which is the thing this project does not have, and it would strip protections the app's author chose on purpose.

## Decisions

### Opt-in per item, with `embed`

```yaml
items:
  - name: Dashboards
    url: https://dashboards.example.com
    embed: true                      # default false
    allow: [fullscreen, clipboard-write]   # optional, maps to the iframe allow attribute
    sandbox: []                      # optional, opt-in only; empty or absent means no sandbox
```

`embed: false` is the default and the entire v0.1.0 behaviour is unchanged. An item with `embed: true` renders with a primary action that mounts it as a tab, and keeps a secondary action that opens it in a browser tab.

*Alternatives:* a group-level or global `embedAll` (too blunt: within one group some apps will frame and others will not); a separate top-level `tabs` list (duplicates urls already in the tree, and sets would then need to know which list a target came from).

### We cannot tell whether framing worked, so we never pretend to

A frame refused by `X-Frame-Options` or by the target's `frame-ancestors` renders the browser's own error content. The parent document gets a `load` event in some browsers and nothing in others, cannot read the frame's status, cannot read its document, and cannot distinguish refusal from a slow app or a 500. Every "detect a blocked iframe" technique is a guess, and a wrong guess here is worse than no guess: telling someone their app refused framing when it was actually down sends them to edit headers for no reason.

So: no detection, and instead a frame that has not reported anything useful within a few seconds gets a non-blocking overlay offering "open in a new tab" and a link to the documented header requirements, worded as *possible* causes. The overlay is dismissible, because a slow app would otherwise be accused unfairly.

*Alternatives:* a `HEAD` probe before mounting (cross-origin, so the response is opaque and the headers unreadable); a timing heuristic (flaky, and the failure mode is a false accusation); requiring the user to declare that the app frames (more honest but no better, since they find out by trying anyway).

### Mounted frames are never unmounted by a re-render

`render.js` already reconciles by key rather than rewriting `innerHTML`, which is what lets focus and scroll survive. Frames raise the stakes: moving an `iframe` in the DOM reloads it in every browser, so a re-render that reparents a frame destroys the session inside it. Half-finished forms, open consoles, playing media.

Therefore the frame container lives **outside** the part of the tree that re-renders, as a sibling of the bookmark tree rather than a descendant of any group, and frames are addressed by item id. A config change can rename the item, move it between groups, or delete it, and the mounted frame is unaffected, except that deleting the item closes its tab with a notice saying why. This is a constraint on the DOM structure, not a nicety, and it should be asserted by a test that re-renders while a frame is mounted and checks the element identity is the same node.

### A cap, and eviction with a warning

Default limit: four mounted frames, configurable. Each frame is an entire application; four heavy ones is already a lot of memory, and an unbounded tab strip is a way to make a laptop unusable while looking like a feature.

Opening beyond the limit evicts the least recently focused frame and says so. The strip shows the count against the limit. Eviction is a close, with the same consequence for state as closing, so it has to be visible rather than silent.

*Alternatives:* unmount a frame when its tab is not focused (that is the behaviour embedding exists to avoid); no limit and trust the user (the failure mode is a hung browser with no explanation).

### Refresh and close, as a group and individually

Refreshing a frame means reassigning its `src`, which is a real navigation and loses state, so refresh is explicit and never automatic. "Refresh all" and "close all" act on mounted frames, with "close all" confirming when more than one is open, for the same reason sets confirm above ten targets.

Focus mode hides the portal's chrome, keeps the tab strip, and is reversible by `Escape` as well as by its own control. Nothing about focus mode may unmount a frame.

### The portal's own CSP has to allow framing, and that is a second switch

The shipped server config sends `frame-src 'none'` and `frame-ancestors 'none'`. Embedding needs `frame-src` widened to the origins being embedded. That lives in the server config ConfigMap, not in the bookmark config, so enabling embedding is two changes: the item opts in, and the deployment widens the policy.

This is a coupling users will get half-right, so the page must detect the half-state it *can* see: a config with embedded items while `frame-src` forbids framing is visible to the page through a CSP violation event, and that gets a specific message naming the header to change, rather than a blank frame. A deliberately narrow use of a CSP report: it says nothing about whether the target allows framing, only whether we do.

The default stays `'none'`. The kustomize path gets a documented patch, and the chart gets a value that lists the permitted frame origins. Neither ships enabled.

*Alternatives:* defaulting to `frame-src https:` (weakens the policy for every user to benefit the few who opt in); omitting `frame-src` so it falls back to `default-src 'self'` (same effect as 'none' and less obvious to a reader).

### Cross-site cookies are a documented limitation

An embedded app on a different site may not receive its own session cookies, because a cookie without `SameSite=None; Secure` is not sent in a third-party context, and browsers are restricting third-party cookies further. Apps on sibling subdomains of one site are usually fine. Apps on an unrelated domain may show a login screen forever inside the frame while working perfectly in a browser tab.

Nothing in the page can fix this. It goes in the documentation next to the header requirements, because it is the second most likely reason an embedded app appears broken, and the symptom looks like an application bug rather than a browser policy.

### State across reloads

Which tabs were open is remembered per browser, like theme and collapse state, and restored on load. Restoring is a fresh mount, so the apps start from scratch: remembering *which* apps were open is useful, and pretending their state survived a page reload would be a lie.

### Module and DOM contract

Written here first so the pieces can be built independently, as in the previous
change.

**DOM, already in `index.html`:** `#tab-strip` (`role="tablist"`) and
`#frame-host` are siblings of `<main id="portal">`. Nothing that re-renders may
contain them. Focus mode is `document.body.dataset.focusMode = "on"`.

**`src/assets/frames.js`** owns every frame and knows nothing about rendering:

- `FRAME_DEFAULT_MAX = 4`
- `createFrameHost(hostEl, {maxFrames, onChange, deps}) -> host`
- `host.open(item)` mounts or focuses, returns `{mounted, focused, evicted}`
- `host.focus(id)`, `host.close(id)`, `host.closeAll()`
- `host.refresh(id)`, `host.refreshAll()`
- `host.list()` returns `[{id, item, focused, mountedAt, lastFocusedAt}]` in
  strip order
- `host.has(id)`, `host.count()`, `host.max`, `host.setMax(n)`
- `host.restore(ids, itemsById)` mounts a remembered set, skipping unknown ids
- `host.destroy()` removes every frame and listener
- `onChange(list)` fires after any change, and is the only thing the strip
  renders from
- `watchFramePolicy(onBlocked, deps) -> stop()` listens for
  `securitypolicyviolation` with `violatedDirective` of `frame-src` and reports
  the blocked URI. This detects **our own** policy refusing a frame, which is
  knowable, and says nothing about whether the target allows framing, which is
  not.

**The view layer** renders the strip from `onChange`, calls the host for every
action, and owns focus mode. It must never create, move or remove a frame
element itself.

**`state.js`** gains `getOpenTabs()` / `setOpenTabs(ids)`, stored like the other
per-viewer preferences and wrapped the same way.

## Risks / Trade-offs

- **A re-render reparents a frame and silently destroys a session** → the frame container is outside the re-rendered subtree, asserted by a test on element identity across a re-render.
- **Users will blame the portal when a target refuses framing** → no detection, an overlay offering the new-tab escape with *possible* causes, and documentation naming the exact headers.
- **Users enable `embed` without widening `frame-src`** → the CSP violation for our own policy is observable, so that specific half-state gets a specific message.
- **Memory exhaustion** → a default cap of four, a visible count, and visible eviction.
- **Cross-site cookie breakage looks like an app bug** → documented beside the header requirements.
- **Embedding makes the portal a more attractive target**: it now loads other origins' documents in the same browsing context group. `frame-ancestors 'none'` on our own page stays, the frames get no `allow-same-origin` relaxation of anything, and the default remains off.
- **Scope creep toward being a browser** → explicitly: no back/forward per tab, no address bar, no session persistence inside frames.

## Migration Plan

Additive and opt-in. An existing deployment that does not set `embed` on any item renders byte-identically and keeps `frame-src 'none'`; a test should assert that the rendered manifests and the CSP are unchanged when the feature is unused. Ships as a minor release, documented as two steps: widen the policy, then opt an item in.

## Open Questions

- Whether the frame cap should default to four or to two. Four is a guess and should be revisited once someone has run it on a laptop with a handful of real apps.
- Whether a `embed: auto` that opens inside the portal on a wide viewport and in a browser tab on a phone is worth it, or is the kind of cleverness that makes behaviour unpredictable. Leaning towards leaving it out.
- Whether to remember the focused tab as well as the open set. Probably, but it interacts with restoring tabs the user had forgotten were open.
