# Security

BridgeBrain is a local adapter. It is not an offline model and not a credential broker.

## Credential Rule

Do not read, copy, print, export, persist, or package:

- Auth tokens.
- Browser cookies.
- API keys.
- Session files.
- Codex auth material.
- GBrain databases.
- Local private memory files.

The bundled bridge calls an already-authenticated local Codex CLI. Codex owns its auth path. BridgeBrain does not inspect it.

## Provider Data Boundary

Text sent for embedding is sent through the authenticated provider account via Codex. That is the design.

Do not embed secrets, regulated private data, credentials, private documents, or anything else you are not willing to send through that provider account.

## Cache Boundary

BridgeBrain cache files do not store raw source text. They store:

- Source text hash.
- Structured semantic fingerprint.
- Cache metadata.

Derived fingerprints can still reveal meaning. Treat cache directories as local private data.

## Local Network Boundary

Default bind address is `127.0.0.1`. Do not expose the service on a public interface unless you understand exactly what text and metadata callers can submit.

## Reporting

Open an issue with:

- Impact.
- A minimal reproduction.
- Affected platform.
- Whether credentials or private text could be exposed.

Do not paste secrets into issues. Redact that shit.
