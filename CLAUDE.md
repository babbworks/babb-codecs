# @workpads/codec — Claude Code

Canonical JavaScript implementation of pads-v1 (§5) for Node and CLI.

## Start here (mandatory)

1. **[`../workpadskaios/system/project-process.md`](../workpadskaios/system/project-process.md)** — cross-repo bottleneck and port policy.
2. [`../workpads-standard/codec.md`](../workpads-standard/codec.md) — normative wire format.
3. [`README.md`](README.md) — API and usage.

## Change order

Normative spec → **this package** (tests pass) → port to `workpadskaios/js/lib/codec.js`. See `project-process.md` §8.

```bash
node test/codec.test.js
```

## Note on kaios inline codec

`workpadskaios/js/lib/codec.js` is a larger superset (legacy decode, security, presentation tags). Shared `#1pa/` paths must stay aligned with this package.
