## Why

Self-hosters who already run Flux or Argo CD have nowhere good to put a start page. The existing options either need a database (Flame), a build step and a rebuilt image per config change (Dashy), or a server-side runtime that reparses YAML on boot (Homepage). All of them mean an image to track, and none of them pick up a ConfigMap edit without a pod restart.

A start page is also the kind of thing that gets built once as a single HTML file with the bookmarks hard-coded into it, which works until someone wants a folder, or wants to change a URL without editing JavaScript, or wants the same page in a second cluster. The data model is usually a flat list of `{name, url, icon, category}`, which cannot express nesting and cannot express "open these five at once". That is the gap this fills: the same single-file simplicity, with the bookmarks moved out into a config that a non-author can safely edit.

## What Changes

- New public repository `quickportal`: a static, build-free start page driven entirely by a ConfigMap.
- **No image to build or track.** The app ships as files in this repo, mounted into a stock upstream nginx image. Users add a remote kustomize base plus their own ConfigMap, and that is the whole install.
- Bookmarks gain **arbitrary nesting**: a group can hold both items and further groups, replacing a flat single-level `category` string.
- **Bookmark sets**: a named collection of targets, drawn from anywhere in the tree, that opens in one action, with an explicit fallback when the browser blocks the popups.
- **Live config reload**: the page notices a changed ConfigMap and re-renders without a pod restart and without a page reload.
- Config accepted as **YAML or JSON**, validated in the browser, with errors shown in the page rather than failing silently to an empty screen.
- Responsive from a 320px phone to a wide desktop, with light/dark/auto theming, keyboard navigation and a search palette.
- Deployment artifacts for both **Flux** and **Argo CD**, a Helm chart for people who prefer one, and `kubeconform`-checked manifests in CI.

Not in this change: embedding apps in iframes. It forces `frame-ancestors` and `X-Frame-Options` changes on every embedded app, which is a per-deployment security decision and does not belong in a first release. Noted in design as a later capability.

## Capabilities

### New Capabilities
- `bookmark-config`: the config contract. Schema, YAML and JSON parsing, nesting rules, validation and error reporting, defaults.
- `portal-ui`: rendering the tree. Folders, collapse state, search and palette, responsive layout, theming, keyboard navigation, icon fallbacks.
- `bookmark-sets`: named sets of targets that open together, including popup-blocker fallback.
- `live-config-reload`: detecting a changed config at runtime and re-rendering without losing UI state.
- `kubernetes-deployment`: imageless deployment. Kustomize base, Helm chart, Flux and Argo examples, serving and cache-header requirements, pod hardening.

### Modified Capabilities

None. This is a new project.

## Impact

- New repository, no existing consumers, so no migration burden and no breaking changes to anyone.
- One third-party runtime dependency, a YAML parser, vendored rather than fetched from a CDN so the page works on an airgapped cluster and loads no third-party origin.
- Depends on an upstream public image (`nginxinc/nginx-unprivileged`) rather than one we publish. Users who object can swap the image in one patch.
- Every example, test fixture and default in this repository uses reserved placeholder domains (`example.com`, `example.org`). No real hostname, IP range or deployment detail from any private cluster belongs in this repo, including in specs and commit messages.
