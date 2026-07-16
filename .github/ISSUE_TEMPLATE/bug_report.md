---
name: Bug report
about: Something behaves differently than SPEC.md says it should
title: ""
labels: bug
---

## What happened

<!-- what you observed -->

## What the spec says

<!-- telic's behavior is defined by clause-numbered specs (packages/*/SPEC.md).
If you can name the clause you believe is violated (e.g. "S3.4"), triage is
near-instant. If the spec is silent on your case, say so — spec gaps are bugs
too. -->

## Repro

```ts
// minimal repro — createRuntime({ now: () => 1000, id: ... }) makes it deterministic;
// @telic/core/testing has createTestRuntime for exactly this
```

## Environment

- package + version (e.g. @telic/core 0.3.2):
- runtime (browser/version, or bundler + target):
- framework adapter involved (react / xstate / tanstack-query / none):
