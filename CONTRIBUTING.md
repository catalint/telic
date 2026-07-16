# Contributing to telic

Thanks for being here — issues, questions, docs fixes, and PRs of every size
are all welcome. You don't need to know this project's internals to
contribute: open something imperfect and we'll figure the rest out together.

## Quick start

```bash
git clone git@github.com:catalint/telic.git && cd telic
bun install
bun run check     # build → typecheck → test → size, all packages
```

[Bun](https://bun.sh) is the dev toolchain (the published packages don't
require it). `bun run check` handles the build ordering for you — if a fresh
clone shows type errors before you've built, that's why; run `check` once.

## Ways to contribute

- **Report a bug** — a rough description is enough; a small repro is gold.
- **Share a use case** — the roadmap is driven by real needs. "Here's my app
  shape and here's where telic almost fits" is the most valuable issue this
  repo receives; both adoption reviews that shaped v0.2 and v0.3 started
  exactly like that.
- **Improve the docs** — if something confused you, that confusion is
  actionable information. PRs that fix a sentence are great PRs.
- **Fix or build something** — for anything beyond a small fix, opening an
  issue or a draft PR early usually saves you time; happy to think it through
  with you before you invest a weekend.

## What to expect from review

This library makes strong guarantees to its users (zero dependencies, strict
types, size budgets, "never owns time or transport"), so review pays close
attention to a few things — **but you don't have to get any of this right on
the first push.** Unchecked boxes and failing gates are normal for a first
draft; review exists to close the gap together, and for process-y bits
(spec wording, decision-log entries, size budgets) I'm glad to write them
with you or for you.

Things review will look at, so they don't surprise you:

- **Behavior lives in the spec.** Each package has a `SPEC.md` describing
  behavior in numbered clauses, and tests reference them. If your change
  alters behavior, describing *what should happen* in plain words in the PR
  is enough — turning it into clause language can happen during review.
- **Core stays dependency-free and small.** Vendor integrations use
  structural typing (any file in `src/taps/` shows the pattern), and
  `bun run size` guards bundle budgets. If your change trips the gate, that's
  a conversation, not a rejection — budgets have been raised before, on
  purpose, with a sentence of justification.
- **A few design boundaries** (documented in `DESIGN.md`, with history in
  `DECISIONS.md`): the big one is that telic never schedules, retries, or
  queues anything on its own. Features that need those usually belong in an
  adapter around an execution library rather than in core — review will help
  find the right home for the idea rather than turning it away.
- **House style** the codebase follows: TypeScript-strict with explicit
  return types, no `as` casts (narrowing or the existing branded-type
  helpers instead), tabs, `.js`-extensioned relative imports, no
  browser-global access at module scope. `.editorconfig` handles most of it;
  review catches the rest — nobody expects you to memorize this list.

## Useful reading (entirely optional)

The design docs exist so you don't have to reverse-engineer intent from code.
Dip in as needed:

| Doc | Answers |
|---|---|
| `packages/core/SPEC.md` | what, precisely |
| `packages/core/DESIGN.md` | why, and the boundaries |
| `packages/core/PATTERNS.md` | how to use it well |
| `packages/core/APPROACHES.md` | which option, when several exist |
| `packages/core/DECISIONS.md` | what's been decided before, and why |

If a proposal overlaps something in DECISIONS.md, that's not a wall — it just
means there's prior thinking to build on, and fresh evidence or a new use
case is exactly what reopens a decision.

## Releases (maintainers)

Bump versions + `CHANGELOG.md`, push a `v*` tag; the release workflow
verifies and publishes via npm trusted publishing. A brand-new package's
first publish is manual (npm requires the package to exist before a trusted
publisher can be configured).

## Questions

Open an issue — there are no dumb ones, and "I read X and didn't get it"
routinely leads to the best docs improvements.
