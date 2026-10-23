# The deployment half of the embedding switch. It is OFF, and it ships off.
#
# This file sets exactly one thing: the value of the CSP `frame-src` directive
# that security-headers.inc emits. It is the only file you edit to permit
# embedding, and the policy itself is never duplicated here -- there is one
# Content-Security-Policy in this deployment and it lives in
# security-headers.inc.
#
# `frame-src` is who WE may put in an iframe. It is unrelated to
# `frame-ancestors 'none'`, which is who may put US in an iframe; that stays
# 'none' always and is not configurable here.
#
# ---------------------------------------------------------------------------
# ENABLING EMBEDDING TAKES TWO CHANGES, AND ONE WITHOUT THE OTHER LOOKS BROKEN
# ---------------------------------------------------------------------------
#
#   1. this file, listing the origins you will embed, and
#   2. `embed: true` on the items in your own config ConfigMap.
#
# Do only (2) and the browser refuses the frame under this policy: the page
# reports it, because it can see its own CSP violation. Do only (1) and
# nothing happens at all, which is the safe half.
#
# To permit origins, replace the directive at the bottom with a space-separated
# list of origins:
#
#     set $quickportal_frame_src "https://dashboards.example.com https://logs.example.org";
#
# Rules that are easy to get subtly wrong, and whose only symptom is a blank
# rectangle:
#
#   * An origin is scheme://host[:port]. No trailing slash, no path. CSP
#     matches `https://app.example.com/grafana` as a path prefix, so an item
#     whose URL is a different path under the same host will NOT match, while
#     the bare origin matches every path on that host.
#   * Every origin you embed must be listed. A subdomain is a different origin,
#     and listing `https://example.com` does not permit `https://a.example.com`
#     (use `https://*.example.com` if you mean the wildcard, deliberately).
#   * http:// origins are blocked as mixed content when the portal is served
#     over https, whatever this policy says.
#   * Do NOT write `https:` or `*`. That permits framing anything the portal
#     can reach and throws away the point of having the directive.
#
# Check what you actually shipped, rather than what you meant to ship:
#
#     curl -sI http://127.0.0.1:8080/ | tr ';' '\n' | grep frame-
#
# Changing this file changes the server-config ConfigMap, which is
# content-hashed, so it rolls the pod. Browsers apply the new policy on the
# next page load.
set $quickportal_frame_src "'none'";
