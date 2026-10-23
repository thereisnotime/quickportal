{{/* Chart name, overridable. */}}
{{- define "quickportal.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully qualified release name. */}}
{{- define "quickportal.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "quickportal.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "quickportal.labels" -}}
helm.sh/chart: {{ include "quickportal.chart" . }}
{{ include "quickportal.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/component: portal
app.kubernetes.io/part-of: quickportal
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "quickportal.selectorLabels" -}}
app.kubernetes.io/name: {{ include "quickportal.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Image reference, pinned by digest when one is set. */}}
{{- define "quickportal.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s:%s@%s" .Values.image.repository .Values.image.tag .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{/* Name of the ConfigMap holding the user's config. */}}
{{- define "quickportal.configMapName" -}}
{{- if .Values.config.existingConfigMap -}}
{{- .Values.config.existingConfigMap -}}
{{- else -}}
{{- printf "%s-config" (include "quickportal.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
The value of the CSP `frame-src` directive: which origins the portal may put in
an iframe. "'none'" unless embedding.frameOrigins lists something.

This renders a value, never a policy. The policy itself exists once, in
files/nginx/security-headers.inc, shared byte for byte with the kustomize base.

The validation is deliberate. Every way of getting this wrong produces the same
symptom -- an empty frame with nothing in the console that names the cause -- so
the mistakes that can be caught are caught here, at template time, where the
message can say what to do.
*/}}
{{- define "quickportal.frameSrc" -}}
{{- $embedding := .Values.embedding | default dict -}}
{{- $origins := $embedding.frameOrigins | default (list) -}}
{{- if not (kindIs "slice" $origins) -}}
{{- fail "embedding.frameOrigins must be a list of origins, for example [\"https://dashboards.example.com\"]" -}}
{{- end -}}
{{- if eq (len $origins) 0 -}}
{{- "'none'" -}}
{{- else -}}
{{- range $o := $origins -}}
{{- if not (kindIs "string" $o) -}}
{{- fail (printf "embedding.frameOrigins: %v is not a string; each entry is an origin like \"https://dashboards.example.com\"" $o) -}}
{{- end -}}
{{- if not (regexMatch "^(?:'self'|https?://(?:\\*\\.)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?)$" $o) -}}
{{- fail (printf "embedding.frameOrigins: %q is not an origin.\n  An origin is scheme://host[:port] -- no trailing slash and no path, because CSP matches a path as a prefix and an item at another path on that host would then not match.\n  A subdomain is a different origin; write \"https://*.example.com\" if the wildcard is what you mean.\n  \"https:\" and \"*\" are refused on purpose: they permit framing anything the portal can reach, which is the whole thing this directive exists to stop.\n  \"'self'\" is accepted, for an app served from the portal's own origin." $o) -}}
{{- end -}}
{{- end -}}
{{- join " " $origins -}}
{{- end -}}
{{- end -}}

{{/*
Walks config.inline and returns the URLs of items marked `embed: true` whose
origin no entry of embedding.frameOrigins permits. Recurses, because groups
nest.

`'self'` disables the check: it permits the portal's own origin, which is not
knowable at template time, so guessing here would mean false alarms.
*/}}
{{- define "quickportal.uncoveredEmbeds" -}}
{{- $origins := .origins -}}
{{- range $g := (.groups | default list) -}}
{{- range $i := ($g.items | default list) -}}
{{- if $i.embed -}}
{{- $origin := regexFind "^https?://[^/]+" ($i.url | default "") -}}
{{- $ok := false -}}
{{- range $o := $origins -}}
{{- if or (eq $o "'self'") (eq $o $origin) -}}
{{- $ok = true -}}
{{- else if contains "://*." $o -}}
{{- $parts := splitList "://" $o -}}
{{- if and (hasPrefix (printf "%s://" (first $parts)) $origin) (hasSuffix (trimPrefix "*" (index $parts 1)) $origin) -}}
{{- $ok = true -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if not $ok }} {{ $i.url }}{{ end -}}
{{- end -}}
{{- end -}}
{{- include "quickportal.uncoveredEmbeds" (dict "groups" ($g.groups | default list) "origins" $origins) -}}
{{- end -}}
{{- end -}}

{{/*
Refuses to render the half-configured state, which is the one mistake this
feature invites: an item asking to be embedded under a policy that forbids it.
The browser's version of this message is an empty rectangle and nothing in the
console that names a cause, so it is worth failing a template over.

Only checked when the chart renders the config itself. With
config.existingConfigMap the config is not ours to read, and the page's own CSP
violation report is then the only warning available.
*/}}
{{- define "quickportal.assertEmbedding" -}}
{{- $cfgValues := .Values.config | default dict -}}
{{- $origins := (.Values.embedding | default dict).frameOrigins | default (list) -}}
{{- if and $cfgValues.create (not $cfgValues.existingConfigMap) -}}
{{- $cfg := fromYaml ($cfgValues.inline | default "{}") -}}
{{- if and (kindIs "map" $cfg) (not (hasKey $cfg "Error")) -}}
{{- $bad := include "quickportal.uncoveredEmbeds" (dict "groups" ($cfg.groups | default list) "origins" $origins) | trim -}}
{{- if $bad -}}
{{- if not $origins -}}
{{- fail (printf "embedding is half-configured.\n  config.inline marks these items `embed: true`: %s\n  embedding.frameOrigins is empty, so the portal serves `frame-src 'none'` and the browser will refuse every one of those frames, showing an empty rectangle.\n  Set embedding.frameOrigins to the origins of those items (scheme://host[:port], no path), or drop `embed: true`." $bad) -}}
{{- else -}}
{{- fail (printf "embedding is half-configured.\n  config.inline marks these items `embed: true` but their origins are not permitted: %s\n  embedding.frameOrigins currently permits: %s\n  An origin is scheme://host[:port]. A path does not widen it and a sibling subdomain is a different origin, so add the missing origins or drop `embed: true` from those items." $bad (join " " $origins)) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
