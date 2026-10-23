# Shared response headers, included from every location block.
#
# Why an include instead of one copy at server level: nginx's add_header is not
# additive across contexts. The moment a location block sets a single
# add_header, every add_header inherited from the server block is dropped. So
# any location that needs its own Cache-Control must also restate the security
# headers, and this file is the single copy of them.
#
# This file deliberately does not end in .conf: the stock nginx.conf includes
# /etc/nginx/conf.d/*.conf at http context, where these directives would be
# valid but would not survive a location-level add_header. It is pulled in
# explicitly instead.

# The CSP from the design. 'self' only for scripts and styles, which is why the
# app carries no inline <script>, no style= attribute and no onclick= handler.
# img-src allows https: because user-configured favicons are fetched from the
# user's own hosts, and data: for inlined placeholder icons.
#
# This is the ONLY Content-Security-Policy in the deployment. Do not add a
# second add_header for it anywhere: nginx would emit both and browsers enforce
# the intersection, which is the kind of bug you find months later.
#
# One directive is a variable: $quickportal_frame_src, which is who the portal
# may frame. Its value is set in frame-src.inc, which default.conf includes at
# server level, and it is "'none'" as shipped. The variable is deliberately not
# given a fallback here: if frame-src.inc is missing from the mounted
# conf.d, nginx refuses to start with `unknown "quickportal_frame_src"
# variable` rather than quietly serving a policy with a hole in it.
#
# frame-ancestors stays 'none' unconditionally. That is who may frame US, which
# is a different question from who we may frame, and it is not configurable.
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; form-action 'none'; frame-src $quickportal_frame_src; object-src 'none'; frame-ancestors 'none'; base-uri 'none'" always;

add_header X-Content-Type-Options "nosniff" always;
# frame-ancestors covers modern browsers; X-Frame-Options is for the rest.
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "no-referrer" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
add_header Permissions-Policy "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=()" always;
