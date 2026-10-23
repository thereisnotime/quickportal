# The deployment half of the diagram renderer switch. It is OFF, and it ships
# off.
#
# This file sets exactly one thing: the value of the CSP `script-src` directive
# that security-headers.inc emits. It is the only file you edit to let the page
# import a diagram renderer, and the policy itself is never duplicated here --
# there is one Content-Security-Policy in this deployment and it lives in
# security-headers.inc.
#
# As shipped the value is `'self'`, which is what the policy said literally
# before this file existed: the page runs the modules that came out of this
# repository's own ConfigMap, and nothing else.
#
# ---------------------------------------------------------------------------
# WHY THIS IS CONFIGURABLE AT ALL, AND WHAT IT COSTS
# ---------------------------------------------------------------------------
#
# The diagram panel can render diagram source from your config in the browser,
# but the project cannot ship the renderer that does it: the usual one is
# 2.7MB against a 1MiB ConfigMap limit, so it does not fit in the delivery
# model at all. The page therefore imports a renderer module whose URL you
# name in `diagram.renderer.url`, and importing a module from somewhere else
# is exactly what `script-src 'self'` forbids.
#
# That is a real concession and the only one of its kind here: the page runs
# code this project did not ship and cannot vouch for. It is off until you
# turn it on, and turning it on is a deployment-level change, deliberately,
# for the same reason embedding is.
#
# You do NOT need this file if you supply an already-rendered SVG in
# `diagram.src`. That path imports nothing and needs no policy change. Prefer
# it when you can.
#
# ---------------------------------------------------------------------------
# ENABLING IT TAKES TWO CHANGES, AND ONE WITHOUT THE OTHER LOOKS BROKEN
# ---------------------------------------------------------------------------
#
#   1. this file, listing the origin the renderer is served from, and
#   2. `diagram.renderer.url` plus `diagram.source` in your own config
#      ConfigMap.
#
# Do only (2) and the browser refuses the import under this policy: the panel
# reports it and names the server config, because the page can see its own CSP
# violation. Do only (1) and nothing happens at all, which is the safe half.
#
# To permit an origin, replace the directive at the bottom, keeping `'self'`:
#
#     set $quickportal_script_src "'self' https://cdn.example.com";
#
# Rules that are easy to get subtly wrong, and whose only symptom is a panel
# saying the diagram needs an origin:
#
#   * KEEP `'self'`. It is not optional and it is not a default underneath
#     this value: the whole application is served from this origin, so
#     dropping it stops the portal itself from running.
#   * An origin is scheme://host[:port]. No trailing slash, no path. CSP
#     matches a path as a prefix, so `https://cdn.example.com/npm/pkg@1/` will
#     NOT cover a chunk the renderer pulls from a sibling path, while the bare
#     origin covers every path on that host.
#   * A renderer loads further chunks on demand, from its own origin. Listing
#     the entry module's origin covers them; listing a path may not.
#   * Do NOT write `https:` or `*`. That permits the page to execute anything
#     it can reach and throws away the point of having the directive.
#   * This directive governs imports, not the diagram file. An SVG you supply
#     in `diagram.src` is fetched under `default-src 'self'` and sanitised; it
#     never needs a mention here.
#
# Self-hosting the renderer beats a public CDN and is covered in
# docs/DIAGRAM.md. If you serve it from the portal's own origin, `'self'`
# already covers it and you do not need to edit this file at all.
#
# Check what you actually shipped, rather than what you meant to ship:
#
#     curl -sI http://127.0.0.1:8080/ | tr ';' '\n' | grep script-
#
# Changing this file changes the server-config ConfigMap, which is
# content-hashed, so it rolls the pod. Browsers apply the new policy on the
# next page load.
set $quickportal_script_src "'self'";
