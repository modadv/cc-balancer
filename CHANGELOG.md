# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [0.1.0] - 2026-04-23

### Added

- Initial public release of `cc-balancer`
- Config-driven Claude Code gateway with multi-upstream routing
- Automatic retry, cooldown, and failover for `429`, `403`, `5xx`, timeout, and network errors
- Gateway bearer-token auth separated from upstream provider credentials
- Health, metrics, and upstream status endpoints
- CLI commands: `start`, `validate`, `doctor`, `version`
- YAML config loading with environment-variable interpolation
- npm CLI packaging for local or internal deployment

### Notes

- `/health` remains public by default for liveness checks
- `/metrics` and `/upstreams` follow gateway auth when configured
- Upstream credentials stay inside the gateway and are not exposed to Claude Code
