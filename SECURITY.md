# Security policy

## Reporting

Report vulnerabilities privately via
[GitHub security advisories](https://github.com/catalint/telic/security/advisories/new)
or email catalint@gmail.com. Please don't open public issues for security
reports. You'll get an acknowledgment within a few days.

## Scope notes for researchers

The most security-relevant surfaces, in order of interest:

- **Faithful recording (no egress policy)** — telic records a mark verbatim and
  forwards it to every attached tap, persistence store, and transport; it has no
  `exposure`/reach class and no payload scrubbing (removed in D30). Keeping raw
  identities off the payload is the integrating app's job (PATTERNS AP7). A telic
  bug that corrupts or drops a recorded mark, or routes one to a sink the caller
  never wired, is in scope.
- **Transports** — `transports/post-message` requires explicit origin
  allow-listing and rejects `targetOrigin: "*"`; incoming payloads on all
  transports are wire-validated before ingestion. Bypasses of either are
  vulnerabilities.
- **The agent surface** (`window.__INTENT_MEMORY__`) is read-only and frozen
  by design; any mutation path through it is a vulnerability.
- The devtools overlay must remain Trusted-Types-safe (no string HTML sinks).

## Supported versions

Latest minor of each package. Pre-1.0, fixes ship as the next patch release.
