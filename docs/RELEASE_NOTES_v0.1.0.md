# Release Notes: v0.1.0

## cc-balancer v0.1.0

Initial public release of `cc-balancer`, a config-driven Claude Code gateway for multi-upstream API key rotation and automatic failover.

## What It Does

- Gives Claude Code one stable gateway endpoint
- Privately manages multiple real upstream API keys behind the gateway
- Automatically retries and switches upstreams on `429`, `403`, `5xx`, timeout, and network errors
- Applies cooldown windows so unhealthy upstreams are temporarily avoided
- Exposes `/health`, `/metrics`, and `/upstreams` endpoints
- Separates client-to-gateway auth from gateway-to-upstream credentials

## Why It Exists

Claude Code workflows often fail for operational reasons before they fail for model reasons:

- one API key hits quota
- one provider rate-limits sustained use
- a long autonomous run stops when one upstream becomes unhealthy
- users have fallback keys, but manual switching is disruptive

`cc-balancer` solves that by letting Claude Code target one stable endpoint while the gateway handles retry, cooldown, and upstream rollover.

## Included in v0.1.0

- npm CLI package
- YAML configuration
- environment-variable key injection
- multiple upstream definitions
- cooldown and failover behavior
- gateway bearer-token auth
- config validation and doctor commands
- graceful shutdown support

## Notes

- `/health` remains public by default for liveness checks
- `/metrics` and `/upstreams` follow gateway auth when configured
- upstream credentials stay inside the gateway and are never exposed to Claude Code

## Install

```bash
npm install -g cc-balancer
```

## Example Startup

```bash
export CC_BALANCER_AUTH_TOKEN=your-gateway-token
export ANTHROPIC_KEY_1=your-real-upstream-key
export ANTHROPIC_KEY_2=your-second-upstream-key

cc-balancer start -c config.yaml
```
