# cc-balancer

`cc-balancer` is a local Claude API gateway for Claude Code.

`cc-balancer` 是一个面向 Claude Code 的本地网关。

It gives Claude Code one stable endpoint, while privately managing multiple real upstream API keys and endpoints behind the gateway. When one upstream hits rate limits, quota exhaustion, or temporary provider failure, `cc-balancer` automatically applies cooldown and switches to the next available upstream.

它给 Claude Code 提供一个稳定入口，而把多个真实上游 API Key 和 Base URL 收口在网关内部管理。当某个上游出现限流、额度耗尽或临时故障时，`cc-balancer` 会自动进入 cooldown 并切换到下一个可用上游。

## Motivation / 设计动机

Claude Code users often want strong models and uninterrupted work, but a single API key is frequently the weakest link.

很多 Claude Code 用户希望优先使用高性能模型，同时又不希望工作因为单个 API Key 出问题而中断。

Typical problems:

- one key hits `429` rate limits during sustained use
- one provider or account temporarily runs out of quota
- a long-running autonomous task stops because one upstream becomes unhealthy
- users have multiple keys available, but manual switching is tedious and error-prone

典型问题包括：

- 单个 key 在持续使用中触发 `429`
- 某个 provider 或账号暂时耗尽额度
- 长时间自动运行任务因为一个上游异常而中断
- 用户虽然有多个 key，但手工切换既麻烦又容易出错

`cc-balancer` exists to solve that operational gap.

`cc-balancer` 的目标就是解决这个运维层面的空档。

Instead of teaching Claude Code about many keys, many base URLs, or manual rollover rules, you point Claude Code at one gateway and let the gateway handle upstream selection, cooldown, retry, and failover.

你不需要让 Claude Code 理解多个 key、多个 base URL、或者人工切换规则，只需要把 Claude Code 指向一个网关，让网关负责上游选择、cooldown、重试和故障切换。

## Design Goal / 设计目标

The design goal is simple:

设计目标很简单：

Claude Code should keep working even when individual upstream API keys cannot.

即使单个上游 API Key 失效，Claude Code 也应尽量持续工作。

That means:

- Claude Code uses one stable `ANTHROPIC_BASE_URL`
- the gateway owns the real upstream credentials
- the gateway can rotate across multiple upstream API keys and providers
- failures trigger cooldown and automatic rollover
- users do not manually swap keys in the middle of interactive or autonomous work

这意味着：

- Claude Code 只使用一个稳定的 `ANTHROPIC_BASE_URL`
- 网关持有真实上游凭证
- 网关可以在多个 API Key 和多个 provider 之间轮换
- 故障时自动 cooldown 与切换
- 用户不需要在交互式或自动运行过程中手工换 key

This is especially useful when you want budget-first usage, uninterrupted long-running work, and maximum utilization of multiple API keys that recover over time.

这尤其适用于预算优先、长任务不中断、以及希望把多个会随时间恢复额度的 API Key 尽可能高效利用起来的场景。

## Features / 核心能力

- Multi-upstream routing from a YAML config
- Automatic failover on `429`, `403`, `5xx`, timeout, and network errors
- Cooldown windows per error type
- Request-level retry and upstream rotation
- In-flight aware routing for multiple concurrent Claude Code clients
- Optional per-upstream concurrency caps
- Anthropic-compatible proxying for Claude Code
- Health, metrics, and upstream status endpoints
- Config validation before startup
- Graceful shutdown
- npm CLI packaging for easy deployment

对应中文：

- 基于 YAML 的多上游路由
- 对 `429`、`403`、`5xx`、超时和网络错误自动切换
- 按错误类型分别应用 cooldown
- 请求级重试与 upstream 轮换
- 面向多个 Claude Code 客户端的 in-flight 感知调度
- 可选的单 upstream 并发上限
- 面向 Claude Code 的 Anthropic 兼容代理
- 健康检查、指标和 upstream 状态接口
- 启动前配置校验
- 优雅退出
- 以 npm CLI 形式发布，便于部署

## Architecture / 架构

```text
Claude Code
  ├─ ANTHROPIC_BASE_URL -> cc-balancer
  └─ ANTHROPIC_AUTH_TOKEN -> gateway access token

cc-balancer
  ├─ validates client access token
  ├─ selects an available upstream
  ├─ injects the real upstream API key
  ├─ applies retry / cooldown / failover
  └─ exposes health / metrics / upstream status

Upstreams
  ├─ provider A + key 1
  ├─ provider A + key 2
  └─ provider B + key 3
```

## Authentication Model / 认证边界

`cc-balancer` deliberately separates client-to-gateway auth from gateway-to-upstream auth.

`cc-balancer` 明确把“客户端到网关认证”和“网关到上游认证”分开。

### Claude Code -> cc-balancer

Claude Code connects to the gateway using:

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`

Here, `ANTHROPIC_AUTH_TOKEN` is only the gateway access token.

这里的 `ANTHROPIC_AUTH_TOKEN` 只表示“访问网关的 token”。

### cc-balancer -> upstream providers

The gateway talks to real upstream providers using credentials in `config.yaml`, typically injected from environment variables such as:

- `ANTHROPIC_KEY_1`
- `ANTHROPIC_KEY_2`

Claude Code never needs the real upstream API keys.

网关则使用 `config.yaml` 中配置的真实上游凭证访问 provider，通常通过环境变量注入，例如 `ANTHROPIC_KEY_1`、`ANTHROPIC_KEY_2`。Claude Code 不需要知道这些真实上游 key。

## Quick Start / 快速开始

Install:

```bash
npm install -g cc-balancer
```

Prepare gateway environment variables:

```bash
export CC_BALANCER_AUTH_TOKEN=your-gateway-token
export ANTHROPIC_KEY_1=your-real-upstream-key
export ANTHROPIC_KEY_2=your-second-upstream-key
```

Start the gateway:

```bash
cc-balancer start -c config.yaml
```

Then point Claude Code at the gateway:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8000
export ANTHROPIC_AUTH_TOKEN=your-gateway-token
```

中文说明：

- `CC_BALANCER_AUTH_TOKEN`：网关自己的访问口令
- `ANTHROPIC_KEY_1/2`：网关访问真实上游的 key
- Claude Code 侧只需要配置指向网关的 `BASE_URL` 和访问网关的 `AUTH_TOKEN`

## Example Config / 示例配置

```yaml
server:
  host: 0.0.0.0
  port: 8000

gateway:
  authToken: ${CC_BALANCER_AUTH_TOKEN}

log:
  level: info

routing:
  strategy: least-fail

concurrency:
  acquireTimeoutMs: 30000
  maxPendingRequests: 1024

upstreams:
  - id: official-1
    baseUrl: https://api.anthropic.com
    apiKey: ${ANTHROPIC_KEY_1}
    weight: 2
    maxConcurrentRequests: 4

  - id: official-2
    baseUrl: https://api.anthropic.com
    apiKey: ${ANTHROPIC_KEY_2}
    weight: 1

retry:
  maxAttempts: 4
  perUpstreamRetries: 2
  backoff:
    type: exponential
    baseDelayMs: 200
    maxDelayMs: 2000

cooldown:
  rateLimit: 60
  quotaExceeded: 300
  serverError: 10
  networkError: 15

health:
  enable: true
  path: /health

metrics:
  enable: true
  path: /metrics

status:
  enable: true
  path: /upstreams
```

See the full example at [examples/config.yaml](./examples/config.yaml).

完整示例见 [examples/config.yaml](./examples/config.yaml)。

## Commands / 命令

```bash
cc-balancer start -c config.yaml
cc-balancer validate -c config.yaml
cc-balancer doctor -c config.yaml
cc-balancer version
```

## Typical Use Cases / 典型场景

- Keep Claude Code running when one API key hits quota exhaustion.
- Prevent long-running autonomous tasks from terminating on a single upstream failure.
- Centralize upstream key management instead of distributing real provider credentials to every machine.
- Use one stable Claude Code endpoint while retaining multiple fallback upstreams behind the gateway.
- Maximize utilization of multiple API keys that recover over time.

对应中文：

- 某个 API key 耗尽额度时，Claude Code 仍能继续工作
- 自动运行任务不会因为单个 upstream 异常而直接终止
- 将真实 provider 凭证集中在网关中管理，而不是分发到每台机器
- 对 Claude Code 暴露一个稳定入口，背后保留多个备用 upstream
- 尽可能利用会随时间恢复额度的多个 API key

## Health Checks / 健康检查

After startup:

```bash
curl http://127.0.0.1:8000/health
curl -H "Authorization: Bearer $CC_BALANCER_AUTH_TOKEN" http://127.0.0.1:8000/upstreams
curl -H "Authorization: Bearer $CC_BALANCER_AUTH_TOKEN" http://127.0.0.1:8000/metrics
```

`/health` is public by default for liveness checks. Management endpoints such as `/upstreams` and `/metrics` follow gateway auth when configured.

默认情况下 `/health` 可匿名访问，方便存活探测；`/upstreams` 和 `/metrics` 在配置了网关认证时需要 Bearer token。

## Logging / 日志

`cc-balancer` writes structured JSON logs to stdout/stderr through Fastify/Pino, which works well with npm package usage, systemd, Docker, and hosted log collectors. Configure verbosity with:

`cc-balancer` 通过 Fastify/Pino 输出结构化 JSON 日志到 stdout/stderr，适合 npm package、systemd、Docker 和日志采集系统。通过以下配置控制日志级别：

```yaml
log:
  level: info
```

`log.level` defaults to `info`. Supported levels are `info`, `warn`, and `error`; `debug` is also available for temporary troubleshooting.

`log.level` 默认值为 `info`。支持 `info`、`warn`、`error`；也可以在临时排障时使用 `debug`。

Use `info` in production for request lifecycle, upstream selection, retries, cooldown, auth failures, startup summaries, and shutdown events. Use `debug` when diagnosing high-concurrency admission queue behavior, lease release timing, or retry delays.

生产环境建议使用 `info`，用于记录请求生命周期、upstream 选择、重试、cooldown、认证失败、启动摘要和关闭事件。排查高并发准入队列、租约释放时机或重试延迟时可临时切换到 `debug`。

Sensitive credentials are redacted or omitted from logs. The gateway logs upstream `id` and `baseUrl`, but never upstream API keys or gateway auth tokens.

敏感凭证会被脱敏或直接不输出。日志会记录 upstream 的 `id` 和 `baseUrl`，但不会记录真实 upstream API key 或 gateway auth token。

## Concurrency / 并发模型

Each gateway process tracks upstream cooldown, failure counters, and in-flight requests in memory. When several Claude Code instances use the same gateway, `least-fail` routing prefers upstreams with fewer active requests before comparing failure counts, which prevents a cold gateway from concentrating simultaneous work on one API key.

每个网关进程会在内存中跟踪 upstream 的 cooldown、失败计数和当前 in-flight 请求数。当多个 Claude Code 实例连接同一个网关时，`least-fail` 会先选择当前活跃请求更少的 upstream，再比较失败计数，避免冷启动时把并发请求全部打到同一个 API Key。

Set `maxConcurrentRequests` on an upstream to cap how many active requests one key/provider may handle at the same time:

可以在单个 upstream 上设置 `maxConcurrentRequests`，限制某个 key/provider 同时处理的请求数：

```yaml
upstreams:
  - id: official-1
    baseUrl: https://api.anthropic.com
    apiKey: ${ANTHROPIC_KEY_1}
    maxConcurrentRequests: 4
```

When every upstream is cooling down or saturated, requests enter a bounded admission queue instead of immediately competing with each other. `concurrency.acquireTimeoutMs` controls how long a request may wait for capacity, and `concurrency.maxPendingRequests` caps the queue to protect the process under overload:

当所有 upstream 都在 cooldown 或达到并发上限时，请求会进入有界准入队列，而不是各客户端立即相互抢占。`concurrency.acquireTimeoutMs` 控制单个请求最多等待容量恢复多久，`concurrency.maxPendingRequests` 限制等待队列长度，避免过载时拖垮进程：

```yaml
concurrency:
  acquireTimeoutMs: 30000
  maxPendingRequests: 1024
```

The gateway returns `503` only when no upstream recovers before the acquire timeout, the pending queue is full, or every attempted upstream fails. `/upstreams` includes each upstream's `inFlight` value, and `/metrics` includes current in-flight totals plus `pendingAcquireRequests`.

只有在等待超时、等待队列已满，或所有已尝试的 upstream 都失败时，网关才会返回 `503`。`/upstreams` 会返回每个 upstream 的 `inFlight`，`/metrics` 会返回当前 in-flight 汇总以及 `pendingAcquireRequests`。

## Roadmap / 路线图

- [x] Multi-upstream config-driven gateway
- [x] Retry, cooldown, and failover behavior
- [x] Health, metrics, and upstream status endpoints
- [x] Gateway access-token separation from upstream credentials
- [x] npm-packaged CLI distribution
- [ ] Hot reload for config changes
- [ ] Optional Redis-backed shared state for multi-instance deployments
- [ ] Prometheus text-format metrics
- [ ] More advanced upstream routing and policy controls
- [ ] Container image and deployment examples

## License / 许可证

This project is released under the [MIT License](./LICENSE).

本项目使用 [MIT License](./LICENSE) 开源。
