---
name: Bug report
about: Something does not work
labels: bug
---

**What happened, and what you expected instead**

**Your config** (redacted to placeholder hostnames, and ideally the smallest
version that still shows the problem)

```yaml
```

**Does `node tools/validate-config.mjs your-config.yaml` report anything?**

**How you installed it**: Flux / Argo CD / plain kustomize / Helm, and the tag.

**If live reload is the problem**, confirm first:
- [ ] the config volume is not mounted with `subPath`
- [ ] `quickportal-config` is not `immutable: true`
- [ ] you waited for the kubelet projection delay (about a minute) plus one
      `reload.interval`

**Browser and version**, plus anything in the console.
