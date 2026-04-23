# Claude Gateway 详细设计方案

## 1. 项目目标

实现一个本地或内网可部署的 **Claude API Gateway**，供 Claude Code 通过 `ANTHROPIC_BASE_URL` 接入。
Gateway 自身负责管理多个上游 Provider 和 API Key，在请求失败、限流、额度耗尽或上游异常时自动切换。

目标使用方式如下：

```bash
npm install -g cc-balancer
cc-balancer start -c config.yaml
```

然后用户将 Claude Code 指向该 Gateway：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8000
```

Claude Code 不感知真实 Provider URL 和 API Key，所有上游配置都由 Gateway 的 `config.yaml` 管理。

---

## 2. 核心需求

### 2.1 功能目标

系统必须支持：

1. 作为 Claude Code 的 HTTP 代理入口
2. 通过 YAML 配置文件定义多个 upstream
3. 每个 upstream 包含：

   * 唯一 id
   * baseUrl
   * apiKey
   * 可选权重
4. 请求级别的 upstream 选择与轮换
5. 处理以下故障场景：

   * 429 限流
   * 403 配额耗尽或权限问题
   * 5xx 上游错误
   * 网络超时
   * 连接失败
6. 根据错误类型对 upstream 进入不同 cooldown
7. 支持多个路由策略
8. 暴露健康检查、指标、upstream 状态接口
9. 支持优雅退出
10. 支持启动时配置校验
11. 支持环境变量注入 API Key
12. 兼容 Claude Code 所需 API 路径与 header 透传

### 2.2 非功能目标

系统应满足：

1. 适合作为 npm 全局 CLI 使用
2. 适合长期运行
3. 单实例即可工作
4. 架构上可扩展到多实例或 Redis 共享状态
5. 配置清晰，可读性高
6. 具备基本可观测性
7. 初版实现优先稳定、透明、简单

---

## 3. 设计原则

### 3.1 透明代理

Claude Code 只需要连接 Gateway，不需要知道真实上游地址、key 列表、轮换策略。

### 3.2 upstream 是调度单位

不是单独轮换 key，而是轮换：

* `baseUrl + apiKey + 状态`

一个 upstream 表示一个完整的可调用目标。

### 3.3 配置驱动

所有上游、路由、重试、cooldown、日志等级等行为都由 `config.yaml` 决定。

### 3.4 失败驱动轮换

成功请求保持透明；只有当上游失败、限流、超时或配额问题发生时，才触发切换与冷却。

### 3.5 安全优先

API Key 不建议直接写死在 YAML 中，应支持 `${ENV_VAR}` 方式从环境变量读取。

### 3.6 初版不做流中切换

如果是 streaming 请求，中途失败后不尝试无缝切换到另一个 upstream。初版只保证请求开始前的 upstream 选择与失败重试。

---

## 4. 使用方式

### 4.1 安装

```bash
npm install -g cc-balancer
```

### 4.2 启动

```bash
cc-balancer start -c config.yaml
```

### 4.3 Claude Code 接入

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8000
```

### 4.4 预期扩展命令

建议 CLI 设计为子命令形式，而不是只支持裸参数。推荐：

```bash
cc-balancer start -c config.yaml
cc-balancer validate -c config.yaml
cc-balancer doctor -c config.yaml
cc-balancer version
```

后续如有需要还可扩展：

```bash
cc-balancer reload -c config.yaml
cc-balancer print-config -c config.yaml
```

---

## 5. 配置文件设计

## 5.1 文件格式

使用 YAML。标准文件名建议为：

```text
config.yaml
```

## 5.2 配置文件示例

```yaml
server:
  host: 0.0.0.0
  port: 8000

log:
  level: info

routing:
  strategy: least-fail

upstreams:
  - id: official-1
    baseUrl: https://api.anthropic.com
    apiKey: ${ANTHROPIC_KEY_1}
    weight: 2

  - id: official-2
    baseUrl: https://api.anthropic.com
    apiKey: ${ANTHROPIC_KEY_2}
    weight: 1

  - id: proxy-a
    baseUrl: https://proxy.example.com
    apiKey: ${PROXY_KEY_1}
    weight: 1

retry:
  maxAttempts: 6
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

---

## 6. 配置项定义

## 6.1 server

```yaml
server:
  host: string
  port: number
```

说明：

* `host`：监听地址
* `port`：监听端口

默认建议：

* host: `0.0.0.0`
* port: `8000`

## 6.2 log

```yaml
log:
  level: debug | info | warn | error
```

默认建议：

* `info`

## 6.3 routing

```yaml
routing:
  strategy: round-robin | random | least-fail | weighted
```

默认建议：

* `least-fail`

解释：

* `round-robin`：轮询
* `random`：随机
* `least-fail`：优先选择失败较少且当前未冷却的 upstream
* `weighted`：按权重选择

## 6.4 upstreams

```yaml
upstreams:
  - id: string
    baseUrl: string
    apiKey: string
    weight: number
```

字段要求：

* `id` 必须唯一
* `baseUrl` 必须为合法 URL
* `apiKey` 必须非空
* `weight` 可选，默认 `1`

## 6.5 retry

```yaml
retry:
  maxAttempts: number
  perUpstreamRetries: number
  backoff:
    type: fixed | exponential
    baseDelayMs: number
    maxDelayMs: number
```

说明：

* `maxAttempts`：整个请求最多尝试次数
* `perUpstreamRetries`：单个 upstream 最多连续重试次数
* `backoff.type`：固定或指数退避
* `baseDelayMs`：初始退避时间
* `maxDelayMs`：最大退避时间

推荐默认值：

* maxAttempts: `upstreams.length`
* perUpstreamRetries: `2`
* backoff.type: `exponential`
* baseDelayMs: `200`
* maxDelayMs: `2000`

## 6.6 cooldown

```yaml
cooldown:
  rateLimit: number
  quotaExceeded: number
  serverError: number
  networkError: number
```

单位均为秒。

建议默认值：

* rateLimit: `60`
* quotaExceeded: `300`
* serverError: `10`
* networkError: `15`

## 6.7 health / metrics / status

```yaml
health:
  enable: boolean
  path: string

metrics:
  enable: boolean
  path: string

status:
  enable: boolean
  path: string
```

建议默认路径：

* `/health`
* `/metrics`
* `/upstreams`

---

## 7. 环境变量注入

## 7.1 支持格式

配置文件允许写：

```yaml
apiKey: ${ANTHROPIC_KEY_1}
```

## 7.2 解析要求

启动时必须进行环境变量替换：

1. 扫描配置中的 `${VAR_NAME}`
2. 从 `process.env` 中读取对应值
3. 若不存在，启动失败并明确报错

## 7.3 `.env` 支持

建议使用 `dotenv`，允许：

```env
ANTHROPIC_KEY_1=xxx
ANTHROPIC_KEY_2=yyy
PROXY_KEY_1=zzz
```

这样可避免将实际 key 写入 YAML。

---

## 8. 系统架构

系统拆分为以下模块：

1. CLI 层
2. 配置加载与校验层
3. Gateway HTTP Server
4. Request Dispatcher
5. Upstream Pool / Scheduler
6. Retry & Cooldown Engine
7. Metrics / Health / Status
8. Logging

整体流程：

```text
Claude Code
   ↓
Gateway HTTP Server
   ↓
Request Dispatcher
   ↓
Upstream Scheduler
   ↓
选择 upstream(baseUrl + apiKey)
   ↓
请求真实 Provider
   ↓
根据响应结果决定成功 / 冷却 / 切换 / 重试
```

---

## 9. 核心数据模型

### 9.1 配置模型

```ts
type Config = {
  server: {
    host: string;
    port: number;
  };
  log?: {
    level?: "debug" | "info" | "warn" | "error";
  };
  routing?: {
    strategy?: "round-robin" | "random" | "least-fail" | "weighted";
  };
  upstreams: UpstreamConfig[];
  retry?: {
    maxAttempts?: number;
    perUpstreamRetries?: number;
    backoff?: {
      type?: "fixed" | "exponential";
      baseDelayMs?: number;
      maxDelayMs?: number;
    };
  };
  cooldown?: {
    rateLimit?: number;
    quotaExceeded?: number;
    serverError?: number;
    networkError?: number;
  };
  health?: {
    enable?: boolean;
    path?: string;
  };
  metrics?: {
    enable?: boolean;
    path?: string;
  };
  status?: {
    enable?: boolean;
    path?: string;
  };
};

type UpstreamConfig = {
  id: string;
  baseUrl: string;
  apiKey: string;
  weight?: number;
};
```

### 9.2 运行时状态模型

```ts
type UpstreamState = {
  id: string;
  baseUrl: string;
  apiKey: string;
  weight: number;

  availableAt: number;
  lastUsedAt: number | null;

  successCount: number;
  failCount: number;

  rateLimitCount: number;
  quotaExceededCount: number;
  serverErrorCount: number;
  networkErrorCount: number;

  consecutiveFailures: number;
};
```

### 9.3 请求上下文

```ts
type RequestAttemptContext = {
  requestId: string;
  startedAt: number;
  totalAttempts: number;
  triedUpstreamIds: string[];
};
```

---

## 10. 路由与调度策略

## 10.1 选择原则

选择 upstream 时必须先过滤掉：

* 当前处于 cooldown 中的 upstream

候选集合中再按策略选择。

## 10.2 round-robin

维护一个全局指针，依次选择可用 upstream。

优点：

* 简单
* 分布均匀

缺点：

* 不能智能避开不稳定 upstream

## 10.3 random

随机选取一个可用 upstream。

优点：

* 简单
* 易实现

缺点：

* 不稳定 upstream 可能被频繁命中

## 10.4 least-fail

推荐默认策略。排序逻辑建议如下：

1. 当前未冷却
2. `consecutiveFailures` 少的优先
3. `failCount` 少的优先
4. `lastUsedAt` 较早的优先
5. 如需进一步打散，可加随机微扰

优点：

* 比轮询更稳健
* 对不健康上游更敏感

## 10.5 weighted

按权重随机选择可用 upstream。

适用于：

* 某些 key 或 provider 配额更高
* 某些上游更希望承担更多流量

---

## 11. 请求转发逻辑

## 11.1 需要兼容的路径

Gateway 应支持通配代理，至少兼容：

* `/v1/messages`
* 未来可能增加的其他 Anthropic 兼容路径

建议用：

```text
/{path:*}
```

进行全量转发。

## 11.2 header 处理

请求转发时：

### 必须覆盖或设置

* `x-api-key`：设置为当前 upstream 的 `apiKey`
* `anthropic-version`：若客户端未提供，可设置默认值

### 应保留

* `content-type`
* `accept`
* `user-agent`
* 其他非冲突头

### 应谨慎处理

* `host`
* `content-length`

交由 HTTP 客户端库自动管理更安全。

## 11.3 URL 处理

目标 URL 计算方式：

```text
targetUrl = upstream.baseUrl + originalPath + originalQueryString
```

例如：

* upstream.baseUrl = `https://api.anthropic.com`
* originalPath = `/v1/messages`

则目标请求为：

* `https://api.anthropic.com/v1/messages`

---

## 12. 错误分类与切换规则

这是系统最核心的策略。

## 12.1 200-299

视为成功：

* 记录 successCount
* consecutiveFailures 归零
* 返回响应给客户端

## 12.2 429

视为限流：

* 增加 rateLimitCount
* 增加 failCount
* 增加 consecutiveFailures
* 设置 cooldown 为 `cooldown.rateLimit`
* 切换到其他 upstream 继续尝试

## 12.3 403

视为配额或权限问题：

* 增加 quotaExceededCount
* 增加 failCount
* 增加 consecutiveFailures
* 设置 cooldown 为 `cooldown.quotaExceeded`
* 切换到其他 upstream

说明：403 不一定总是额度问题，但在本项目场景中可统一作为“当前 upstream 暂时不可用”处理。

## 12.4 5xx

视为上游服务错误：

* 增加 serverErrorCount
* 增加 failCount
* 增加 consecutiveFailures
* 设置短 cooldown 为 `cooldown.serverError`
* 尝试其他 upstream

也可以对单个 upstream 做有限次数局部重试，再切换。

## 12.5 网络异常

如：

* timeout
* ECONNRESET
* ENOTFOUND
* connection refused

处理方式：

* 增加 networkErrorCount
* 增加 failCount
* 增加 consecutiveFailures
* 设置 cooldown 为 `cooldown.networkError`
* 尝试其他 upstream

## 12.6 其他 4xx

除了 403、429 外，其他客户端错误通常应视为请求本身问题，不应切换 upstream。
例如：

* 400
* 401
* 404
* 422

这些应直接原样返回给客户端。

---

## 13. 重试机制

## 13.1 两层重试

建议采用两层控制：

### 整体请求级重试

由 `retry.maxAttempts` 控制。表示一次客户端请求最多尝试多少次。

### 单 upstream 内部重试

由 `retry.perUpstreamRetries` 控制。表示同一个 upstream 遇到瞬时错误时最多连续试几次。

## 13.2 推荐行为

* 429 / 403：不在同一 upstream 内重试，直接切换
* 5xx / timeout：可对当前 upstream 做 1 到 2 次内部重试
* 如果仍失败，再切换 upstream

## 13.3 backoff

每次重试前应用 backoff：

### fixed

延迟固定 `baseDelayMs`

### exponential

第 n 次延迟：

```text
delay = min(baseDelayMs * 2^(n-1), maxDelayMs)
```

---

## 14. cooldown 机制

## 14.1 目标

避免持续命中已知不可用的 upstream。

## 14.2 实现方式

每个 upstream 保存：

```ts
availableAt: number
```

当出现特定错误时：

```text
availableAt = now + cooldownSeconds * 1000
```

在调度时，只有 `availableAt <= now` 的 upstream 才可参与选择。

## 14.3 全部 upstream 冷却时的行为

若全部 upstream 都不可用：

* 可直接返回 502 或 503
* 返回错误信息说明当前没有可用 upstream

建议返回 503，更接近“服务暂时不可用”。

---

## 15. Streaming 处理

## 15.1 初版支持

初版建议支持透传 streaming 响应，但不支持 stream 中途 failover。

## 15.2 原因

流式响应一旦开始，客户端和上游已建立连续输出关系。
中途切换 upstream 无法保证上下文一致性，也很难无感恢复。

## 15.3 初版约束

* 请求开始前可重试
* 一旦上游开始返回流，后续错误直接传给客户端
* 不尝试拼接两个 upstream 的流

---

## 16. 管理接口

## 16.1 `/health`

用于存活检查。

返回示例：

```json
{
  "status": "ok"
}
```

状态码：

* `200`

## 16.2 `/upstreams`

用于查看各 upstream 状态。

返回示例：

```json
{
  "upstreams": [
    {
      "id": "official-1",
      "baseUrl": "https://api.anthropic.com",
      "available": true,
      "availableAt": 0,
      "successCount": 120,
      "failCount": 10,
      "rateLimitCount": 4,
      "quotaExceededCount": 1,
      "serverErrorCount": 3,
      "networkErrorCount": 2,
      "consecutiveFailures": 0,
      "lastUsedAt": 1710000000000
    }
  ]
}
```

## 16.3 `/metrics`

用于机器读取指标。可先返回 JSON，后续再兼容 Prometheus 文本格式。

建议至少包含：

* totalRequests
* totalSuccess
* totalFail
* upstreamSuccessById
* upstreamFailById
* upstreamCooldownCount
* currentAvailableUpstreams

---

## 17. 日志设计

## 17.1 日志级别

支持：

* debug
* info
* warn
* error

## 17.2 关键日志事件

必须记录：

1. 启动成功
2. 配置加载成功
3. 配置校验失败
4. 每次请求的 requestId
5. 每次选择了哪个 upstream
6. 每次 upstream 失败及错误类型
7. cooldown 生效
8. 请求最终成功或失败
9. 进程退出

## 17.3 日志字段建议

建议结构化日志，至少包含：

* timestamp
* level
* msg
* requestId
* upstreamId
* statusCode
* errorType
* attempt

---

## 18. 配置校验

启动时必须严格校验配置。

## 18.1 校验项

1. `upstreams` 至少一个
2. 每个 `id` 唯一
3. `baseUrl` 为合法 URL
4. `apiKey` 非空
5. 环境变量替换后不得为空
6. `server.port` 为有效端口
7. `routing.strategy` 必须在允许范围内
8. `retry` 和 `cooldown` 的值必须非负

## 18.2 校验失败行为

* 输出清晰错误信息
* 退出码为 `1`

建议提供：

```bash
cc-balancer validate -c config.yaml
```

专门做静态校验。

---

## 19. CLI 设计

## 19.1 推荐命令

### start

启动服务

```bash
cc-balancer start -c config.yaml
```

### validate

校验配置

```bash
cc-balancer validate -c config.yaml
```

### doctor

输出环境检查信息，如：

* Node 版本
* 配置文件是否存在
* YAML 是否可解析
* 环境变量是否完整

```bash
cc-balancer doctor -c config.yaml
```

## 19.2 参数设计

支持：

* `-c, --config <path>`
* `--host <host>` 可选覆盖
* `--port <port>` 可选覆盖
* `--log-level <level>` 可选覆盖

---

## 20. 技术选型建议

## 20.1 语言

* Node.js
* TypeScript

## 20.2 HTTP 服务框架

推荐：

* Fastify

原因：

* 性能好
* 类型支持较好
* 插件生态可用
* 适合做网关型服务

Express 也可行，但 Fastify 更适合这个项目。

## 20.3 HTTP 客户端

推荐：

* `undici` 或 `axios`

更推荐 `undici`，因为它是 Node 原生方向、性能更好。

## 20.4 配置解析

* `js-yaml`
* `dotenv`
* `zod` 或 `ajv` 用于配置 schema 校验

## 20.5 CLI 框架

推荐：

* `commander`
* 或 `yargs`

## 20.6 日志

推荐：

* `pino`

## 20.7 测试

推荐：

* `vitest`
* `supertest` 或 Fastify 自带 inject 测试

---

## 21. 目录结构建议

```text
cc-balancer/
  package.json
  tsconfig.json
  README.md
  src/
    cli/
      index.ts
      commands/
        start.ts
        validate.ts
        doctor.ts
    config/
      loadConfig.ts
      expandEnv.ts
      schema.ts
      defaults.ts
    server/
      createServer.ts
      routes/
        proxy.ts
        health.ts
        metrics.ts
        upstreams.ts
    core/
      types.ts
      upstreamPool.ts
      scheduler.ts
      cooldown.ts
      retry.ts
      dispatcher.ts
    utils/
      logger.ts
      backoff.ts
      errors.ts
      requestId.ts
    index.ts
  test/
    unit/
    integration/
  examples/
    config.yaml
```

---

## 22. 启动流程

系统启动时顺序如下：

1. 解析 CLI 参数
2. 加载 `.env`
3. 读取 YAML
4. 执行环境变量替换
5. 应用默认值
6. 校验配置
7. 初始化 logger
8. 初始化 upstream pool
9. 创建 HTTP server
10. 注册系统路由
11. 注册代理路由
12. 开始监听端口

---

## 23. 请求处理流程

一次请求的完整流程如下：

1. 生成 requestId
2. 判断是否为管理接口
3. 如果不是，进入代理逻辑
4. 创建请求上下文
5. 选择可用 upstream
6. 注入 header
7. 发起上游请求
8. 根据响应分类处理
9. 若可重试，则进入下一轮
10. 若成功，则透传响应
11. 若失败且耗尽重试，则返回 502/503

---

## 24. 状态更新规则

### 成功时

* successCount += 1
* consecutiveFailures = 0
* lastUsedAt = now

### 失败时

* failCount += 1
* consecutiveFailures += 1
* lastUsedAt = now

### 进入 cooldown 时

* availableAt = now + duration

---

## 25. 进程与关闭行为

必须支持优雅关闭：

1. 监听 `SIGINT`
2. 监听 `SIGTERM`
3. 停止接受新请求
4. 等待在途请求完成
5. 关闭 server
6. 退出进程

---

## 26. 错误返回约定

## 26.1 配置错误

启动阶段直接退出，不启动服务。

## 26.2 运行时无可用 upstream

返回：

* `503 Service Unavailable`

响应体可包含：

```json
{
  "error": "No available upstreams"
}
```

## 26.3 所有尝试均失败

返回：

* `502 Bad Gateway`

响应体示例：

```json
{
  "error": "All upstream attempts failed"
}
```

---

## 27. 测试方案

## 27.1 单元测试

覆盖：

* YAML 加载
* env 替换
* schema 校验
* 路由策略
* cooldown 逻辑
* backoff 算法

## 27.2 集成测试

模拟多个 upstream：

1. upstream A 返回 200
2. upstream A 返回 429，upstream B 返回 200
3. upstream A 返回 403，upstream B 返回 200
4. upstream A 返回 500，重试后仍失败，切 B
5. 所有 upstream 不可用，返回 503

## 27.3 CLI 测试

覆盖：

* `start -c config.yaml`
* `validate -c config.yaml`
* 缺少 config
* config 非法
* 缺失环境变量

---

## 28. 发布与分发

## 28.1 npm 包

目标分发形式：

```bash
npm install -g cc-balancer
```

并支持：

```bash
npx cc-balancer start -c config.yaml
```

## 28.2 package bin

在 `package.json` 中配置 bin：

```json
{
  "bin": {
    "cc-balancer": "./dist/cli/index.js"
  }
}
```

## 28.3 Docker

建议后续补充 Docker 镜像，便于无人值守环境部署。

---

## 29. 后续可扩展能力

以下功能建议放到后续版本，不作为初版硬要求：

### 29.1 配置热重载

* 文件变化自动 reload
* 或提供管理命令触发 reload

### 29.2 Redis 共享状态

多实例部署时共享 upstream 状态、cooldown、计数器。

### 29.3 Prometheus 格式 metrics

输出标准 Prometheus 文本。

### 29.4 更细粒度路由

基于：

* model
* path
* 请求大小
* 调用来源

选择不同 upstream。

### 29.5 熔断器

对长期失败的 upstream 进行熔断和半开恢复。

### 29.6 管理 API

动态启用 / 禁用某个 upstream。

---

## 30. 初版范围与边界

## 30.1 初版必须完成

1. CLI 启动
2. YAML 配置
3. env 注入
4. 多 upstream
5. 自动切换
6. cooldown
7. 基本 metrics / health / upstream status
8. 配置校验
9. 优雅退出
10. npm 包可安装可运行

## 30.2 初版不做

1. stream 中途无缝 failover
2. Redis 分布式状态
3. Web UI
4. 动态配置热更新
5. 复杂鉴权系统

---

## 31. 推荐默认行为总结

如果 Agent 需要默认实现，可以采用以下默认值：

* server.host = `0.0.0.0`
* server.port = `8000`
* log.level = `info`
* routing.strategy = `least-fail`
* retry.maxAttempts = `upstreams.length`
* retry.perUpstreamRetries = `2`
* backoff.type = `exponential`
* backoff.baseDelayMs = `200`
* backoff.maxDelayMs = `2000`
* cooldown.rateLimit = `60`
* cooldown.quotaExceeded = `300`
* cooldown.serverError = `10`
* cooldown.networkError = `15`
* health.path = `/health`
* metrics.path = `/metrics`
* status.path = `/upstreams`

---

## 32. 给 Agent 的实现指令摘要

下面这段可以直接作为工程生成要求：

实现一个 Node.js + TypeScript CLI 工具，名称为 `cc-balancer`。
该工具通过 `cc-balancer start -c config.yaml` 启动 HTTP Gateway。
Gateway 接收 Claude Code 的请求，并根据 YAML 配置中定义的多个 upstream（每个 upstream 含 `id`、`baseUrl`、`apiKey`、`weight`）进行请求转发。
当某个 upstream 遇到 429、403、5xx 或网络错误时，应根据配置设置 cooldown，并自动切换到其他可用 upstream 重试。
配置文件必须支持 `${ENV_VAR}` 环境变量插值。
系统必须提供 `/health`、`/metrics`、`/upstreams` 接口，支持 graceful shutdown，支持 `validate` 子命令，并以 npm CLI 形式分发。

---

## 33. 一句话总结

这不是一个简单的“轮换 key 脚本”，而是一个：

**面向 Claude Code 的、配置驱动的、多 upstream 智能网关。**
