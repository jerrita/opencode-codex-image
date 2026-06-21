# opencode-codex-image

OpenCode 插件：复用 Codex CLI 登录凭据，通过 OpenAI `gpt-image-2` 模型生成图片。

## 安装与构建

```bash
# 安装依赖
pnpm install

# 构建
pnpm build

# 类型检查
pnpm typecheck

# Lint / Format
pnpm lint
pnpm format
```

## 配置 OpenCode 使用本插件

开发本仓库时，构建后可在本仓库的 `opencode.json` 中添加：

```json
{
  "plugin": ["./dist/index.js"]
}
```

若从其他项目引用本地构建产物，使用文件 URL：

```json
{
  "plugin": ["file:///path/to/opencode-codex-image/dist/index.js"]
}
```

若已安装/发布到 npm，可直接写包名：

```json
{
  "plugin": ["opencode-codex-image"]
}
```

> **注意**：修改本地配置后需重新 `pnpm build` 并重启 opencode 才能生效。

## 认证与传输路径

插件按以下优先级读取凭据，并根据凭据类型选择不同的 API 端点：

### 优先级

1. **环境变量** `OPENAI_API_KEY` → **API key 模式**
2. **Codex auth 文件** `${CODEX_HOME:-$HOME/.codex}/auth.json`
   - 若含 `OPENAI_API_KEY` 字段 → **API key 模式**
   - 若含 `tokens.access_token` → **ChatGPT/Codex OAuth 模式**
3. **opencode auth 文件** `~/.local/share/opencode/auth.json`（回退）
   - `{ openai: { type: "api", key } }` → **API key 模式**
   - `{ openai: { type: "oauth", access, ... } }` → **ChatGPT/Codex OAuth 模式**

### API key 模式

调用 `POST https://api.openai.com/v1/images/generations`，model=`gpt-image-2`。

需要凭据具有 `api.model.images.request` scope。若缺少该 scope，错误提示会说明原因。

### ChatGPT/Codex OAuth 模式

调用 `POST https://chatgpt.com/backend-api/codex/responses`，使用 Responses API 的 `image_generation` tool，以 SSE 流方式接收结果。

Codex 当前实现不接受 `include: ["image_generation_call.results"]`，插件直接从 SSE 的 `image_generation_call.result` 读取 base64。

**不再**打 `api.openai.com/v1/images/generations`，因此不需要 `api.model.images.request` scope。

请求头包含：
- `Authorization: Bearer <access_token>`
- `ChatGPT-Account-Id`（有 accountId 时）
- `X-OpenAI-Fedramp: true`（FedRAMP 账号）
- `originator: opencode`
- `User-Agent: opencode-codex-image/0.1.0`
- `session-id` / `x-client-request-id`（有 sessionId 时）

outer model 默认 `gpt-5.4`，可通过环境变量 `OPENCODE_CODEX_IMAGE_OUTER_MODEL` 覆盖。

### 登录 Codex

```bash
codex login
```

若 token 过期，运行 `codex` 触发自动刷新，或重新执行 `codex login`。

OAuth 模式 401/403 错误提示会指向 `codex login` 或 `opencode auth login`。

## 使用 imagegen 工具

在 OpenCode 会话中，直接用自然语言调用：

```
请用 imagegen 生成一张赛博朋克风格的城市夜景图，1024x1024，高质量
```

或指定完整参数：

```
imagegen:
  prompt: "a cyberpunk cityscape at night, neon lights, rain"
  size: "1024x1024"
  quality: "high"
  outputFormat: "png"
  outputPath: "assets/cityscape.png"
```

### 参数说明

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `prompt` | string | 必填 | 图片描述文本 |
| `outputPath` | string | `.opencode/imagegen/<timestamp>.png` | 输出路径，相对路径基于项目目录 |
| `size` | string | `auto` | `auto` 或 `WIDTHxHEIGHT`（如 `1024x1024`）。宽高须为 16 的倍数，各边 ≤ 3840，面积 ≤ 3840×2160，比例 1:3 ~ 3:1 |
| `quality` | enum | `auto` | `auto` / `low` / `medium` / `high` |
| `outputFormat` | enum | `png` | `png` / `jpeg` / `webp` |
| `outputCompression` | number | — | 0-100，仅 jpeg/webp 时生效 |
| `moderation` | enum | `auto` | `auto` / `low` |

## 生成图片存储位置

默认保存至项目目录下的 `.opencode/imagegen/<timestamp>.<ext>`，已加入 `.gitignore`。

## 注意事项

- 不要将 `auth.json` 或含凭据的文件提交到版本控制
- `node_modules/`、`dist/`、生成图片均已在 `.gitignore` 中排除
