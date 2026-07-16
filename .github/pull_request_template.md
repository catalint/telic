## What

<!-- one or two sentences: what changes, and for whom -->

## Checklist (the spec-first workflow — see CONTRIBUTING.md)

- [ ] Behavior changes have a matching SPEC clause (added or amended in this PR)
- [ ] Tests reference their clause numbers and were written from the spec, not the implementation
- [ ] Design decisions (new feature / changed boundary / rejected alternative) have a DECISIONS.md entry
- [ ] `bun run check` is green (build → typecheck → test → size)
- [ ] Size budget changes, if any, are called out and justified below
- [ ] CHANGELOG.md updated for user-visible changes
- [ ] No `as` casts, no runtime deps in core, no time/transport ownership (the initiative boundary)

## Size / budget notes

<!-- only if bun run size output changed -->
