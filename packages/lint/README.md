# @telic/lint

Taxonomy governance for [`@telic`](https://github.com/catalint/telic) — lifts telic's
runtime diagnostics to authoring time. A small, framework-agnostic CLI that statically
lints your `intent` / `command` / `handle` / `dispatch` declarations so drift in the
intent taxonomy is caught in review, not in production.

It uses the **host's** TypeScript compiler (a peer dependency, `>= 5.5`) — no bundled TS,
no runtime dependencies.

```bash
npm install --save-dev @telic/lint
# or
bun add -d @telic/lint
```

## Usage

```bash
telic-lint                       # scan **/*.{ts,tsx} from the current directory
telic-lint "src/**/*.ts"         # scan an explicit glob
telic-lint --json                # machine-readable findings
telic-lint --config telic.config.json
```

`node_modules`, `dist`, and `.git` are always excluded.

Exit codes: **0** = clean, **1** = findings, **2** = usage/config error.

## Rules

| Rule | Trigger | Config to enable |
|---|---|---|
| `setter-like-name` | An `intent` / `command` / `handle` name whose post-dot segment starts with `set` / `update` / `toggle` / `change` (case-insensitive). Mirrors core S1.4 — name intents by the change the user intends, not the state you mutate. | always on |
| `duplicate-intent-name` | The same name declared via `intent(...)` in more than one file (one finding per extra file). | always on |
| `scope-ownership` | An `intent` / `handle` / `command` whose scope (first segment) is configured but whose file matches none of that scope's globs; and — under `requireScopeOwnership` — any scope not declared in config at all. | `scopes` / `requireScopeOwnership` |
| `dead-contract` | A `command("x")` with no `handle("x")` anywhere scanned (warning — the handler may be presence-based/lazy), or a `handle("x")` with neither `command("x")` nor `dispatch("x")` (unused capability). | `deadContract: true` |

Only call sites in files that import from a specifier containing `"telic"` are eligible —
unrelated local `handle` functions are never flagged. Aliased and namespace imports are
resolved (`import { intent as track }`, `import * as t from "@telic/core"; t.command(...)`).

## Config

`telic.config.json`, discovered upward from the working directory (or passed with
`--config`). Everything is optional; a zero-config run enforces only `setter-like-name`
and `duplicate-intent-name`.

```json
{
  "scopes": {
    "checkout": ["packages/checkout/**"],
    "billing": ["packages/billing/**"]
  },
  "requireScopeOwnership": true,
  "deadContract": true
}
```

Scope globs are resolved relative to the config file's directory.

## CI

`telic-lint` exits non-zero on findings, so it drops straight into a pipeline:

```yaml
- run: bunx telic-lint --json > telic-lint.json || true
- run: bunx telic-lint          # fails the job (exit 1) if there are findings
```

Output is deterministically ordered by file then line, so `--json` diffs are stable
across runs and machines.

## License

MIT © Catalin Tanasescu
