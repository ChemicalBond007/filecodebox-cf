# FileCodeBox-CF

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?repository=https://github.com/zlanly/filecodebox-cf)

**FileCodeBox 的 Cloudflare 移植版**。文件存储后端**二选一**：复用已部署的 [CloudFlare-ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed)（通过 HTTP API 委托），**或直接直连 Telegram Bot API** 把文件发到你的频道/群组——后者无需额外部署任何服务、无需对接第三方实例。

- 后端：**Cloudflare Worker**（Web 标准 API、自研轻量路由，使用 SimpleWebAuthn 验证 Passkey；部署前运行 `npm ci`）
- 存储（二选一，看是否配置 `TG_BOT_TOKEN`）：
  - **CloudFlare-ImgBed**（默认，未配置 Telegram 时）：委托其 `/upload` API，原生支持大文件 / 分片上传 / R2 存储与图床后台
  - **Telegram Bot API**（配置 `TG_BOT_TOKEN` + `TG_CHAT_ID` 时）：文件直发你的频道/群组，**无需额外部署任何服务**，取件时由 Worker 在服务端用 bot token 取回字节（token 不出服务端）
- 元数据：分享记录（取件码 / 过期 / 取件次数 / 密码）存于 FileCodeBox 自有 D1（`fcb_db`）
- 前端：温暖清新风格的单页应用（SPlayer 风），原生 JS，无构建步骤

> 设计要点：FileCodeBox 只做「取件码层」。文件二进制**不**经由本 Worker 落盘。**ImgBed 模式**下，文件流式代理给 ImgBed 的 `/upload`（不缓冲，大文件直穿），取件时由 Worker 302 跳转到 ImgBed 原地址；**Telegram 模式**下，文件直发 Telegram，取件时由 Worker 在服务端用 bot token 调 `getFile` 取回字节并流式返回（bot token 始终留在服务端，**不暴露给浏览器**）。因此本项目**不再需要直接绑定** ImgBed 的 R2 / D1。

---

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│                  Cloudflare Worker（取件码薄层）                │
│                                                                │
│  寄件 POST /api/share ──┐                                      │
│  取件 GET/POST /api/share/:code ─┐                             │
│  上传 POST /api/imgbed/upload ──┐ 流式代理 ──► ImgBed /upload  │
│  文件 GET /file/:key?c=&t= ◄── 校验短时 token + 分享状态：ImgBed 302 / Telegram 取回 │
│  管理 /api/admin/*                                               │
└───────────────┬────────────────────────────┬───────────────────┘
                │                            │
         ┌──────▼──────┐              ┌──────── 存储后端（二选一）─────────┐
         │  D1 fcb_db  │              │  CloudFlare-ImgBed（/upload, R2+图床） │
         │ 分享元数据   │              │  或  Telegram Bot API（直发频道/群组）  │
         └─────────────┘              └────────────────────────────────────┘
```

文件本体的存储后端可二选一（由是否配置 `TG_BOT_TOKEN` 决定）：**ImgBed 模式**下，上传走其 `/upload`（原生支持大文件与分片），取件走 `/file/<key>` 由 ImgBed 处理 Range / 流式传输，删除分享时本 Worker 可选同步调用 ImgBed 的 `/api/manage/delete/<id>` 清理对象；**Telegram 模式**下，文件通过 Bot API `sendDocument` 直发指定频道/群组，取件时由 Worker 在服务端用 bot token 调 `getFile` 取回字节并流式返回（bot token 不出服务端），删除分享时**不**清理 Telegram 侧消息（保留在频道/群里）。

---

## 快速部署（全程网页面板，无需改代码 / 无需 CLI）

> 整个流程只在 Cloudflare 控制台点几下即可，仓库里的 `wrangler.toml` **不写任何密钥或占位符**，部署后直接到面板绑定。

### 第 0 步：选择存储后端（ImgBed 或 Telegram 二选一）
- **用 ImgBed（默认）**：准备一个已部署的 [CloudFlare-ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed) 实例，记下它的**访问地址**（如 `https://img.example.com`）。本项目所有文件都存到它那里。
- **用 Telegram（免部署，推荐不想维护额外服务时）**：准备一个 BotFather 申请的 **Bot Token**，以及一个**频道/群组 ID**（机器人需对该会话有发消息权限）。详见下方「直连 Telegram 存储」一节。
- 两者都配会优先走 Telegram；只配 `IMG_BED_URL` 则走 ImgBed。

### 第 1 步：一键部署（自动 Fork + 部署）
- 点击仓库顶部的 **Deploy to Cloudflare Workers** 按钮（或直接打开 `https://deploy.workers.cloudflare.com/?repository=https://github.com/zlanly/filecodebox-cf`）。
- 按提示登录 Cloudflare、授权 GitHub、为 Fork 命名，然后点 **Deploy**。
- 等待构建完成，页面会提示 `Your Worker is available at https://filecodebox-cf.<你的子域>.workers.dev`，并自动跳到该 Worker 的控制台页面。

### 第 2 步：绑定 D1 数据库（存分享元数据）
- 在 Worker 控制台进入 **Settings → Bindings → Add → D1 Database**。
- **Variable name** 填 `fcb_db`；**Database** 选 **Create new**，名称填 `filecodebox`，点 Create。
- **无需手动建表**：绑定好 `fcb_db` 即可，数据表由 Worker 在**首次访问时自动创建**（运行时执行 `CREATE TABLE IF NOT EXISTS`，幂等可重复）。
  - 想显式初始化？部署后访问一次 `https://你的Worker地址/api/install` 即可，返回 `{"ok":true}`。
  - 仓库里的 `migrations/0001_init.sql` 仅作参考与离线备份，**正常情况下你不需要执行它**。

### 第 3 步：设置变量与密钥
- 回到 Worker 控制台 → **Settings → Variables and Secrets → Add**。
- **存储后端（二选一，决定文件存到哪）：**
  - **用 ImgBed（默认）**：`IMG_BED_URL` —— 已部署的 ImgBed 实例地址，如 `https://img.example.com`。（不要同时设下面两个 TG 变量，否则会切到 Telegram）
  - **用 Telegram（免部署）**：同时设 `TG_BOT_TOKEN`（Bot Token）和 `TG_CHAT_ID`（频道/群组 ID）。配置后文件直存 Telegram，`IMG_BED_URL` 可留空。详见下方「直连 Telegram 存储」。
- **管理员首次绑定：**
  - `ADMIN_API_TOKEN`（Secret 类型）：32 个随机字节的 base64url 字符串，只用于首次绑定 Passkey。绑定后该密钥不再授权管理访问。
  - `ADMIN_ORIGIN`（变量）：固定的 HTTPS 前端 origin，不带末尾斜杠。示例：`https://<your-pages-project>.pages.dev`；自定义域名需要在首次绑定前更改它。
  - `ADMIN_KEY` 不再用于管理登录，旧 Bearer token 和浏览器中缓存的长期令牌不再有效。
- **令牌签名密钥（强烈建议）：**
  - `FILE_SECRET`（Secret 类型）：至少 32 字节的随机串，用于文件直链、上传凭证、分片凭证的 HMAC。
  - 未设置时回退到 `ADMIN_KEY` 或 `ADMIN_API_TOKEN`；三者都没有时，上传/文件分享会失败，**不会使用公开默认值**。
- **可选：**
  - `TG_API`：仅 Telegram 模式用。自定义反代域名，用于 `api.telegram.org` 被墙的环境；留空则用官方 API（Cloudflare Worker 出网到 Telegram 一般通畅）。
  - `IMG_BED_UPLOAD_TOKEN`：ImgBed 的 **API Token**（形如 `imgbed_...`），通过 `Authorization: Bearer` 请求头传给 ImgBed（这是 CloudFlare-ImgBed 上传鉴权的方式，务必用此变量）。
    仅当你的 ImgBed 实例使用 **authCode** 方式鉴权（而非 API Token）时，才额外设置 `IMG_BED_UPLOAD_TOKEN_PARAM=authCode`（此时 token 会作为 `?authCode=` 附加到上传请求）。
  - `IMG_BED_UPLOAD_CHANNEL`：上传通道（如 `cfr2`）
  - `IMG_BED_ADMIN_TOKEN`：删除分享时同步清理 ImgBed 对象所需的管理 token（仅 ImgBed 模式生效）
  - `APP_NAME` / `APP_SUBTITLE`：界面展示文案（不填则用内置默认值）
- 改完变量后，Cloudflare 会提示重新部署，点 **Deploy** 让配置生效。

### 第 4 步：完成
- 访问你的 Worker 地址即可使用。寄件 / 取件 / 管理均在前端页面完成，**全程无需再碰 `wrangler.toml`**。

### （可选）本地开发
- 安装锁定版本的开发工具：`npm ci`。`npm test` 运行后端集成测试，`npm run test:runtime` 在真实 Workers 本地运行时验证页面安全响应头、导航路由、D1 初始化、密码及并发取件限制。
- 当前 `wrangler.toml` 已绑定本次部署的 D1。部署到其他 Cloudflare 账号时，先创建独立的 `filecodebox` 数据库并替换 `database_id`；数据库 ID 不是密钥。`keep_vars = true` 会保留控制台变量，Secret 不写入配置文件。
- CLI 部署：在被 Git 忽略的 `.dev.vars` 填好生产环境密钥（不要使用示例或测试密钥），运行 `npm run deploy -- --dry-run` 检查打包，再运行 `npm run deploy -- --secrets-file .dev.vars`。首次部署后访问 `/api/install` 初始化表结构。
- 仅本地调试用，不影响线上部署：
  ```bash
  cp .dev.vars.example .dev.vars   # 填入本地环境变量
  wrangler dev --config wrangler.toml
  ```
  `.dev.vars.example` 示例：
  ```
  ADMIN_API_TOKEN=your-local-bootstrap-api-key
  ADMIN_ORIGIN=http://localhost:8787
  FILE_SECRET=your-local-file-secret
  APP_NAME=文件快递柜
  IMG_BED_URL=https://imgbed.test   # 本地调试时改用你的 ImgBed 地址（走 ImgBed 模式）
  # TG_BOT_TOKEN=...                # 同时填 TG_BOT_TOKEN 与 TG_CHAT_ID 即切到 Telegram 模式
  # TG_CHAT_ID=...
  ```
  > 注意：Git 仓库里不会提交真实密钥，`wrangler.toml` 也不含任何占位符，所有配置都在面板填写，避免误泄露。本地验证 Telegram 模式可用内置 mock：`FCB_TG_MODE=1 PORT=8088 node preview_local.mjs` 后 `node tg_e2e_test.mjs`（详见「直连 Telegram 存储」）。

---

## Pages 前端 + 原 Worker 后端（CLI）

- 原 Worker 名称：`filecodebox-cf`，继续持有 `fcb_db` 和全部管理、签名、Telegram 密钥。
- Pages 项目名称：`filecodebox-cf`，配置位于 `pages/wrangler.toml`。Pages 只展示 `public/` 前端；`/api/*`、`/file/*` 通过 `BACKEND` 服务绑定转发给原 Worker，不调用公开的 `workers.dev` 地址，也不需要跨域放行管理接口。
- Pages 不绑定数据库、不上传 `.dev.vars`，也不包含业务处理代码。`pages/_headers` 负责静态页面安全响应头，`pages/_routes.json` 让静态资源不触发 Functions。

```bash
npm ci
npm test
npm run test:runtime
npm run test:pages
npm run deploy -- --secrets-file .dev.vars
npx wrangler pages project create filecodebox-cf --production-branch main
npm run pages:deploy
```

`pages:deploy` 会先把前端和转发入口复制到被 Git 忽略的 `.wrangler/pages-dist/`。Pages 与 Worker 分别部署；更新后端不需要重新上传前端。不要为预览环境上传生产密钥；当前服务绑定指向生产 Worker，调试写操作应在本地进行。

---

## 直连 Telegram 存储（无需 ImgBed）

如果你不想额外部署 / 对接一个 ImgBed 实例，**直接配置 Telegram 即可让文件直存 Telegram，无需任何第三方服务**。本项目把 [CloudFlare-ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed) 的 Telegram 存储逻辑（`telegramAPI.js`）内置进了源码（`src/telegram.js`），因此只需在 Worker 配置三个变量即可启用。

判定规则（在 `src/worker.js` 里）：当 `TG_BOT_TOKEN` 与 `TG_CHAT_ID` **同时**配置时走 Telegram；否则走 ImgBed。

### 配置

在 Cloudflare 控制台 **Settings → Variables and Secrets** 添加：

| 变量 | 类型 | 说明 |
|------|------|------|
| `TG_BOT_TOKEN` | Secret | BotFather 申请的 Bot Token，形如 `123456:ABC-DEF...`。机器人需对目标会话有**发送消息**权限 |
| `TG_CHAT_ID` | Secret/变量 | 文件要发往的频道 / 群组 ID。私聊发给自己可用你的用户 id（给 `@userinfobot` 发消息可查） |
| `TG_API` | 变量（可选） | 自定义反代域名，用于 `api.telegram.org` 被墙的环境；留空用官方 API |

> 权限提示：把机器人加进目标频道/群组并设为**管理员**（至少「发送消息」权限）；私聊场景则直接用自己的用户 id 当 `TG_CHAT_ID`，机器人给你自己发文件。

### 行为

- **上传**：
  - **大文件（> 20MiB）走客户端分块**：前端从 `/api/chunk/init` 获取分片大小，每片最多 20MiB，逐片经 `/api/chunk/upload` 单独 `sendDocument` 到 Telegram，最后 `/api/chunk/merge` 校验各片 `chunkToken` 并汇总成 `c:` 的 `file_key`。这样大文件**不必一次性推到 Worker**，从而避开整文件请求过大的问题；分片数有 1000 片防护上限，仍受元数据长度、会话超时与上传速度约束。
  - **小文件（≤ 20MiB）**：前端经 `/api/imgbed/upload` 单发；服务端也会对超过 20MiB 的旧式整文件上传兜底自动分片。
- **取件**：`/file/:key?c=CODE&t=TOKEN` 先校验 10 分钟短时 token 和分享状态，再在服务端用 bot token 调 `getFile` 取回字节并流式返回。**bot token 始终留在服务端，不会下发给浏览器**（与 ImgBed 的 302 不同，这里不暴露任何 token，更安全）。分片文件按序串联各片返回，支持 `Range`（视频拖动）与 `HEAD`；响应强制 `attachment` + `application/octet-stream`。
- **文件名**：含中文等非 ASCII 字符时按 RFC 5987 用 `filename*` 编码，浏览器能正确下载出中文名。
- **删除**：删除分享时**不会**清理 Telegram 侧消息（文件仍保留在频道/群里），介意的话定期清理频道即可。

> ⚠️ **大小限制**（20MiB = 20 × 1024 × 1024 = 20,971,520 字节，顶到 Telegram 官方 `getFile` 上限，不再预留 4MiB 余量）：
>
> | 场景 | 限制 |
> |------|------|
> | 本项目单文件上传 | ≤ 20MiB，确保可整文件经 `getFile` 取回（Telegram `sendDocument` 的 50MB 上传上限不适用于下载） |
> | 分片上传 | 每片 ≤ 20MiB，超限分片返回 413；最多 1000 片，仍受其他平台与元数据限制 |
> | 单文件下载 | ≤ 20MiB（`getFile` 限制） |
> | 分片下载 | 逐片 `getFile` 拼接，支持 `Range` / `HEAD`，不受整文件 20MiB 限制 |
>
> 大文件由前端**客户端分块上传**（`init → 逐片 /api/chunk/upload → /api/chunk/merge`，每片 20MiB），逐片独立请求；服务端为旧式整文件上传保留自动分片。分片元信息编码进 `file_key`，取件时依据每片实际大小重组，不依赖当前分片常量，因此旧的 16MiB 分片分享无需迁移。分片不能绕过平台所有限制，例如请求大小、CPU、元数据长度与令牌有效期。

### 本地调试（mock Telegram）

本地预览内置了 Telegram mock，无需真实 Bot 即可端到端验证：

```bash
FCB_TG_MODE=1 PORT=8088 node preview_local.mjs   # 拦截 api.telegram.org，内存模拟 sendDocument/getFile
BASE=http://127.0.0.1:8088 node tg_e2e_test.mjs  # 上传→分享→取件→下载字节比对
```

---

## 功能对照（与原版 FileCodeBox）

| 能力 | 原版 FileCodeBox | 本移植版 |
|------|------------------|----------|
| 文本分享 | ✅ | ✅ |
| 文件分享 | ✅ | ✅（委托 ImgBed `/upload`） |
| 取件码 | 服务端生成 | 服务端生成（形如 `A1B2-C3D4`） |
| 过期时间 | 时/分/天 | 1h / 1d / 7d / 30d / 永久 |
| 取件次数 | 次数上限 | 1 / 10 / 100 / 不限 |
| 访问密码 | 部分版本 | ✅（PBKDF2 存储，兼容旧 SHA-256） |
| 防直链 | download key | 短时 HMAC 签名的 `/file/:key?c=&t=`（10 分钟） |
| 管理后台 | ✅ | ✅ 统计 / 列表 / 删除 / 清理 |
| 大文件 | 需客户端分片 | ✅（委托 ImgBed，**原生支持大文件 / 分片，无大小限制**） |

---

## API 速查

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/share` | 创建分享。`multipart`：`type=text\|file`、`text`、`file_key`+`upload_token`+`file_name`+`file_type`+`file_size`（文件先经 `/api/imgbed/upload` 上传，`upload_token` 由上传接口返回）、`expire_ms`、`download_limit`、`password` |
| `POST` | `/api/imgbed/upload` | 文件上传入口（小文件）。Telegram 模式直发 Bot API `sendDocument`；ImgBed 模式流式代理到其 `/upload`。返回 `{ id, src, upload_token }`（`id` 即文件 key，`upload_token` 1 小时有效） |
| `POST` | `/api/chunk/init` | 客户端分块上传初始化（仅 Telegram 模式），返回 `{ chunkSize }`（当前 20971520 字节，即 20MiB） |
| `POST` | `/api/chunk/upload` | 上传单个分片（仅 Telegram 模式）。`multipart`：`file` + `index` + `fileName`，返回 `{ success, index, fileId, size, fileName, chunkToken }`（`chunkToken` 1 小时有效） |
| `POST` | `/api/chunk/merge` | 汇总分片元信息（仅 Telegram 模式）。`json`：`{ fileName, fileType, totalChunks, chunks }`（`chunks` 必须带 `chunkToken`），返回 `{ id, src, upload_token }`（`id` 即分片 `file_key`，形如 `c:...`） |
| `GET` | `/api/share/:code` | 分享元信息（不消耗） |
| `POST` | `/api/share/:code/claim` | 取件（原子消耗一次）。文本直接返回；文件返回 `/file/:key?c=CODE&t=TOKEN`（token 10 分钟过期） |
| `GET` | `/file/:key?c=CODE&t=TOKEN` | 校验短时 token + 分享状态后：ImgBed 模式 302 跳转到 ImgBed 原地址；Telegram 模式由 Worker 服务端取回字节以附件返回（bot token 不出服务端，强制 attachment + nosniff） |
| `GET` | `/api/admin/status` | 是否已绑定及当前会话状态，不返回凭证或备用码 |
| `POST` | `/api/admin/login` | `{code}`：首次 API 密钥或绑定后一次性备用码，仅获得绑定会话；恢复时轮换备用码 |
| `POST` | `/api/admin/passkey/register/options`、`/verify` | 创建 Passkey 并验证，成功后签发管理会话；恢复会话必须重新绑定 |
| `POST` | `/api/admin/passkey/login/options`、`/verify` | Passkey 登录，验证挑战、origin、RP ID、用户验证和签名计数器 |
| `POST` | `/api/admin/backup/rotate` | 最近 5 分钟内验证的管理会话可轮换备用码，撤销其他会话 |
| `POST` | `/api/admin/logout` | 撤销当前会话并清除 Cookie |
| `GET` | `/api/admin/stats`、`/shares` | 统计 / 分享列表（需 Passkey 登录后的 HttpOnly Cookie） |
| `DELETE` | `/api/admin/share/:code` | 删除分享（需管理会话；可选同步清理 ImgBed 对象） |
| `POST` | `/api/admin/sweep` | 清理过期 / 超额分享（需管理会话） |
| `GET`/`POST` | `/api/install` | 首次部署初始化 D1 表结构（幂等；也可由首次访问自动建表） |
| `GET` | `/api/config`、`/api/health` | 公共配置 / 健康检查 |

---

## 管理后台：Passkey 与一次性备用码

1. 在固定的 HTTPS 前端打开「管理后台」，输入现有 `ADMIN_API_TOKEN`。此时只能绑定 Passkey，不能读取、删除或清理分享。
2. 点击「创建 Passkey」，使用系统指纹、人脸、PIN 或安全密钥完成验证。推荐同步到密码管理器；要求可发现凭证和用户验证。
3. 将只显示一次的 **Backup code** 保存在安全位置。它和 API 密钥使用相同的 32 字节 base64url 格式（43 个字符），服务端只保存 PBKDF2 加盐哈希。原 API 密钥、`ADMIN_KEY` 和旧 Bearer token 不再用于管理登录。
4. 之后使用 Passkey 登录。管理 Cookie 为 `Secure`、`HttpOnly`、`SameSite=Strict`，最长 8 小时，不写入 localStorage。后台可添加 Passkey 或重置备用码，敏感操作前界面会要求再次验证。
5. 丢失 Passkey 时，选择「使用备用码恢复」。旧码只成功消费一次，包括并发请求；立即生成新码并撤销所有旧会话和旧 Passkey。先保存新码，再绑定新 Passkey 才能进入后台。恢复中断后，可用刚保存的新码重新恢复。

绑定会话有效期为 10 分钟，WebAuthn 挑战有效期为 5 分钟，挑战绑定浏览器 Cookie 并只允许验证一次。所有管理写请求必须为 JSON，且 `Origin` 必须等于 `ADMIN_ORIGIN`，不提供跨域管理 CORS。更换域名会更换 WebAuthn RP ID，旧 Passkey 不再适用，需要通过备用码在新域名恢复绑定。请勿使用临时 Pages 预览 URL 绑定。

本地浏览器测试请使用 `http://localhost:端口`，并将 `ADMIN_ORIGIN` 配置为完全一致的 origin。`npm test` 包含真实 ECDSA 签名、伪造签名、UV/origin/RP 校验、挑战重放、并发绑定和恢复、备用码轮换、会话过期及限流测试；`npm run test:runtime` 在真实 workerd + D1 中验证关键流程。


---

## 说明与边界

- **存储后端**：文件二进制只存在于你选的后端——ImgBed 的 R2（经其 `/upload` 写入，可被 ImgBed 自身 `/file/<key>` 直接访问）或 Telegram 的频道/群组（经 Bot API `sendDocument` 写入）。ImgBed 模式下删除分享会（配置了 `IMG_BED_ADMIN_TOKEN` 时）同步删除 ImgBed 侧对象；Telegram 模式下删除分享仅删取件码，**不**删 Telegram 侧消息。
- **大文件 / 分片**：文件上传由本 Worker 把请求体**流式转发**给 ImgBed 的 `/upload`，由 ImgBed 完成存储。流式转发避免 Worker 自己缓冲整段文件，但**仍受 Cloudflare Workers 请求体上限约束**（通常 100MB，企业版更高）；更大的文件请使用客户端分块上传。
- **Cron 清理**：Worker 的 `scheduled` 触发器每天 04:00 清理失效分享，并在配置了管理 token 时回收 ImgBed 对象，也可在后台手动「清理过期」。
- **无需 R2 CORS**：浏览器不再跨域直传 R2（那套预签名方案已移除），因此也无需在 R2 桶配置 CORS。跨域访问统一经本 Worker 的 302 跳转完成。
- **安全**：密码使用 PBKDF2（随机盐 + 10 万次迭代）存储，并兼容校验旧 SHA-256 记录；文件直链 token 绑定分享码、10 分钟过期，`/file` 还会校验分享是否存在/未过期；上传/分片使用独立 `upload_token`/`chunkToken`，防止任意引用他人文件；Telegram 模式文件响应强制 `attachment` + `nosniff`（ImgBed 模式仍为 302，由 ImgBed 决定其响应头）；后台接口使用 WebAuthn 与 HttpOnly Cookie，不返回通配 CORS。所有密钥均通过 Cloudflare 控制台的 Variables and Secrets 设置，**不**写进 `wrangler.toml` 或提交到仓库。
- **升级提示**：旧版 `/file/:key?t=...` 直链（缺少 `c=` 分享码）会失效，请重新取件；旧分享的取件码仍可正常 claim 并生成新链接。旧版未带 `upload_token` 的建分享请求会被拒绝。
- **限流建议**：管理密钥/备用码验证及挑战签发使用 D1 按 IP 限制为每 5 分钟 30 次。公网部署仍建议在 Cloudflare 为管理入口、`/api/share/:code/claim`、`/api/imgbed/upload` 配置 Rate Limiting，或给寄件/上传入口接入 Turnstile，减少滥用风险。
