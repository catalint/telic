# Security policy

## Reporting

Report vulnerabilities privately via
[GitHub security advisories](https://github.com/catalint/telic/security/advisories/new)
or email catalint@gmail.com. Please don't open public issues for security
reports. You'll get an acknowledgment within a few days.

## Scope notes for researchers

The most security-relevant surfaces, in order of interest:

- **The tape's exposure fidelity** — telic must honor the `exposure` a caller
  declared: `local` payloads never reach persistence, transports, or the agent
  surface, and `private` payloads travel only as the `"[private]"` placeholder.
  A write-time `transform` further shrinks what's recorded. Any path that moves
  a payload further than its declared `exposure` allows — including a lost or
  LRU-evicted exposure defaulting to a wider reach — is a vulnerability.
- **Transports** — `transports/post-message` requires explicit origin
  allow-listing and rejects `targetOrigin: "*"`; incoming payloads on all
  transports are wire-validated before ingestion. Bypasses of either are
  vulnerabilities.
- **The agent surface** (`window.__INTENT_MEMORY__`) is read-only and frozen
  by design; any mutation path through it is a vulnerability.
- The devtools overlay must remain Trusted-Types-safe (no string HTML sinks).

## Supported versions

Latest minor of each package. Pre-1.0, fixes ship as the next patch release.
