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
- **Optionally** open apps inside the page in a tab strip, off by default.
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
    tag: v0.2.0
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
    targetRevision: v0.2.0
    path: .
```

See `examples/argocd/application.yaml` for the version with your config patched
in.

### Plain kustomize

```yaml
# your-repo/quickportal/kustomization.yaml
resources:
  - https://git.example.com/example-org/quickportal.git//?ref=v0.2.0
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
