# QuickPortal

A start page for your self-hosted services, driven entirely by a ConfigMap.

No image to build, no registry, no database, no build step. The app is a handful
of static files that kustomize turns into a ConfigMap and mounts into a stock
upstream nginx. Installing it is this repository plus your own config. Editing
your bookmarks is editing a ConfigMap, and the page picks the change up without
a pod restart and without a reload.

- **Folders**, nested as deep as you like, not a flat list of categories.
- **Sets**: "open these five tabs" in one click, with the blocked ones listed
  when your browser interferes instead of silently dropping them.
- **Live reload**: change the ConfigMap, the page re-renders in place, keeping
  your scroll position, open folders, search and focus.
- **YAML or JSON**, validated in the browser, with errors shown on the page
  naming the exact path rather than leaving you a blank screen.
- Usable at 320px and on a 4K display, light and dark, keyboard driven.
- **Appearance popup**: theme, high contrast, density and reduced motion,
  each following your operating system until you say otherwise, each
  remembered in your own browser and sent nowhere.
- **Optionally** open apps inside the page in a tab strip, off by default.
- **Optionally** an architecture diagram panel with pan, zoom and export, from
  an SVG you supply. Also off by default.
- No CDN, no telemetry, no analytics, no outbound request you did not configure.

## Install

### Flux

```yaml
# GitRepository + Kustomization; see examples/flux for the annotated version
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: quickportal
  namespace: flux-system
spec:
  interval: 1h
  url: https://git.example.com/example-org/quickportal.git
  ref:
    tag: v0.3.0
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: quickportal
  namespace: flux-system
spec:
  interval: 30m
  prune: true
  sourceRef:
    kind: GitRepository
    name: quickportal
  path: ./
  targetNamespace: quickportal
```

### Argo CD

```yaml
spec:
  source:
    repoURL: https://git.example.com/example-org/quickportal.git
    targetRevision: v0.3.0
    path: .
```

See `examples/argocd/application.yaml` for the version with your config patched
in.

### Plain kustomize

```yaml
# your-repo/quickportal/kustomization.yaml
resources:
  - https://git.example.com/example-org/quickportal.git//?ref=v0.3.0
  - ingress.yaml

configMapGenerator:
  - name: quickportal-config
    behavior: replace
    files:
      - config.yaml
    options:
      disableNameSuffixHash: true
```

`examples/kustomize/` is exactly this, ready to copy.

### Helm, if you prefer

```sh
helm install quickportal ./deploy/helm/quickportal \
  --set-file config.inline=./config.yaml \
  --set ingress.enabled=true --set ingress.hosts[0].host=portal.example.com
```

### What you get

A `Deployment`, a `ClusterIP` `Service` on port 80, and three ConfigMaps: the
app, the server config, and `quickportal-config`, which holds your `config.yaml`
and is the only one you edit. Expose it with your own Ingress, Gateway or
`LoadBalancer`; `examples/kustomize/ingress.yaml` is a starting point.

Pin a tag. The app ships as files, so tracking a branch means your start page
changes under you.

## Configure

```yaml
version: 1
title: Home
theme: auto

groups:
  - name: Infrastructure
    icon: "🧱"
    items:
      - name: Grafana
        url: https://grafana.example.com
        icon: auto
      - name: Argo CD
        url: https://argocd.example.com
    groups:
      - name: Storage
        items:
          - name: MinIO
            url: https://minio.example.com

sets:
  - name: Morning check
    targets: [infrastructure, "https://status.example.com"]
```

A set target is an item id, a group id (meaning everything beneath it), or a
bare URL. Ids are derived from names when you do not set them, so
`infrastructure/grafana` exists without you writing it.

`docs/CONFIGURATION.md` is the full reference. Validate before you commit:

```sh
node tools/validate-config.mjs config.yaml
```

## Live reload, and when it cannot work

kubelet reprojects a changed ConfigMap into the pod within about a minute. The
page revalidates the config with an `ETag` on an interval (`reload.interval`,
30s by default), compares a hash of the body so an unchanged file does nothing,
and re-renders in place when it really changed. It pauses while the tab is
hidden and polls once when you come back.

Two things break it, neither of which is a bug in QuickPortal:

- **A `subPath` mount is never updated by kubelet.** Our manifests never use
  `subPath`; if you add one, live reload stops working and only a pod restart
  will pick up a change.
- **An `immutable: true` ConfigMap can never change at all.** Do not set it on
  `quickportal-config`.

If the page is not picking up an edit, check those two before anything else.

## Embedding apps in the page

An item can open *inside* the portal, in a tab strip, rather than in a browser
tab:

```yaml
items:
  - name: Dashboards
    url: https://dashboards.example.com
    embed: true
```

Open tabs survive a config edit untouched, so changing your bookmarks does not
throw away a half-written form or a playing stream. Refresh and close work on
one tab or all of them, and a focus mode gives the app the whole viewport.

It is **off by default and takes two deliberate steps**, because framing another
app needs that app's permission:

1. The item sets `embed: true`.
2. The deployment widens the portal's `frame-src` policy, which ships as
   `'none'`. With Helm that is `embedding.frameOrigins`; with kustomize it is a
   patch, and `examples/kustomize/embedding/` is ready to copy.

And the app you are embedding must not refuse to be framed. **QuickPortal cannot
tell you whether it did**: a page can read nothing about a cross-origin frame,
not its status, not its headers, and the `load` event fires even on the
browser's own refusal page. So the portal never accuses the target. A few
seconds after a frame mounts, a dismissible strip offers to open the app in a
browser tab and states the headers required. It appears even when the app loaded
fine, and it never covers it.

[docs/EMBEDDING.md](docs/EMBEDDING.md) has the headers to hand to whoever owns
the app, the four ways an origin goes subtly wrong, and the third-party cookie
problem that makes an embedded app on an unrelated domain refuse to stay logged
in.

## An architecture diagram

The portal can show a diagram in a collapsible panel beside the bookmarks, with
pan, zoom, fit-to-view and export to SVG and PNG:

```yaml
diagram:
  title: Architecture
  src: ./config/diagram.svg     # another key of your own ConfigMap
```

Render it with whatever you already use — the portal displays an SVG and has no
opinion about where it came from — and commit it beside your config. A new
diagram takes effect without rolling the pod, like a bookmark edit. It is
inlined rather than put in an `<img>`, because pan and zoom need it in the
document, so it is parsed and rebuilt against an allowlist: an SVG is executable
content, and the panel tells you if anything was dropped rather than altering
your diagram silently.

### Why no renderer is bundled

The obvious version of this feature is to vendor a browser renderer so you could
write diagram source in your config and have it just work. That does not fit,
and it is worth being plain about why rather than calling it a design choice:

```
mermaid.min.js        2,748,992 bytes
ConfigMap hard limit  1,048,576 bytes
```

The renderer is 2.6 times the entire delivery envelope. QuickPortal has no image
to build and no registry; the app *is* files in a ConfigMap, and a ConfigMap
cannot hold 2.7MB. Every renderer worth having is in that order of magnitude,
because the hard part is graph layout. So the choice was never "bundle it or
not", it was "move the rendering to where there is no 1MiB limit", which is your
CI or your laptop. The SVG you get is the same SVG the renderer would have
produced.

In-page rendering is still available, and it is the path most people want: set
`diagram.renderer.url` to a renderer module **you** name and write `source` in
your config. That means the page imports code this project did not ship, which
`script-src 'self'` forbids, so like embedding it is off by default and takes a
deployment-level change — `diagram.rendererOrigins` with Helm, or the patch in
`examples/kustomize/diagram/`. Self-hosting the renderer beats a public CDN, and
serving it from the portal's own origin needs no policy change at all.

`style-src` stays `'self'` either way. A renderer's output depends on a
stylesheet it emits, and rather than widen the policy for a picture, the page
extracts that CSS, filters it, scopes it to the diagram and adopts it through
the CSSOM, which `style-src` does not govern.

[docs/DIAGRAM.md](docs/DIAGRAM.md) has both paths in full: the one-command CI
step for a diagram language, the renderer contract, the allowlist and why it
exists, the size budget, and why an exported PNG shows whatever font your
browser substituted.

## Why there are no status indicators

Every dashboard like this is asked for a green or red dot per service. QuickPortal
does not have one, on purpose.

A browser cannot read the status of a cross-origin response unless the target
sends CORS headers, which your services do not. The workarounds, an opaque
`no-cors` fetch or an image probe, cannot distinguish a 200 from a 403 from a
TLS failure: they report failure for services that are working and success for
some that are broken. The projects that do this well do it from a server, which
means a component that polls your services, which means an image to build and
run. That is the one thing this project exists to avoid.

If you want real status, run something built for it and bookmark it here.

## Security

The pod runs as a non-root user with a read-only root filesystem, all
capabilities dropped, no privilege escalation, `RuntimeDefault` seccomp, and no
service account token mounted. The page is served under a strict
Content-Security-Policy: `script-src 'self'`, `style-src 'self'`,
`frame-ancestors 'none'`, and images limited to this origin plus HTTPS so your
own favicons load.

Two directives are configurable, each in its own file, each shipping the value
that forbids the thing it gates: `frame-src 'none'` for embedding and
`script-src 'self'` for a diagram renderer. There is one copy of the policy in
the deployment and widening either directive does not touch it, so an install
that uses neither feature serves byte-identical headers to the release before
it existed — which CI asserts on the wire against the tag, not against a
fixture. `style-src` is deliberately not in that list.

There is no authentication. The page is static and visible to anyone who can
reach it, so put it behind whatever your ingress already does.

`javascript:` and `vbscript:` URLs in a config are rejected as errors: the CSP
does not stop an `href`, and configs get copied between people.

## Develop

```sh
node --test 'tests/**/*.test.mjs'    # 80 tests, no dependencies
node tools/validate-config.mjs examples/config/*.yaml
kubectl kustomize .                  # render what you would install
```

There is no `package.json`, no `node_modules` and no build. The one third-party
file, a vendored YAML parser, is listed in `THIRD-PARTY.md` with its hash.

To see it in a browser, serve a flat copy of `src/` (the served tree is flat
because a ConfigMap key cannot contain a slash) with `config/config.yaml`
alongside it.

## Licence

MIT. See `LICENSE`.
