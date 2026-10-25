# FileCodeBox-CF

**FileCodeBox 的 Cloudflare Workers 移植版**：用取件码分享文本或文件。元数据保存在 D1；文件二进制二选一存放在已部署的 [CloudFlare-ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed)，或直接发送到 Telegram 频道/群组。管理后台使用 **Passkey（WebAuthn）**，不保存可复用的管理密码。

## 功能

- 文本 / 文件分享，服务端生成 `A1B2-C3D4` 形式的取件码
- 过期时间：1 小时 / 1 天 / 7 天 / 30 天 / 永久
- 取件次数：1 / 10 / 100 / 不限；密码保护（PBKDF2 + 随机盐）
- 短时防直链：文件链接绑定分享码，10 分钟过期
- 管理后台：统计、分享列表、删除、清理过期/超额分享
- 管理认证：Passkey 登录 + 一次性备用码恢复；HttpOnly Cookie
- 存储后端：
  - **ImgBed**：流式代理上传，取件 302 到 ImgBed；可选同步删除 ImgBed 对象
  - **Telegram**：Bot API `sendDocument` 直传；小文件单发，大文件客户端分块；服务端 `getFile` 取回

## 架构

```text
浏览器
  │
  ├── Pages（可选）：public/ 静态前端 + /api、/file 同源转发
  │        └── BACKEND service binding ──► Worker
  │
  ├── 取件 Pages（可选）：pickup/，只开放取件 API 与下载
  │        └── BACKEND service binding ──► Worker（ImgBed 重定向在取件站服务端跟随）
  │
  └── Worker（src/worker.js）
           ├── D1 fcb_db：分享元数据、管理员 Passkey/会话
           ├── ImgBed /upload、/file/<id>（R2）
           └── Telegram Bot API（频道/群组）
```

- `src/worker.js`：路由、安全响应头、Cron
- `src/api.js`：分享、取件、管理列表/删除/清理
- `src/admin.js`：Passkey 注册/登录、备用码、会话、限流
- `src/storage.js`：ImgBed 上传、302、删除
- `src/telegram.js`：Telegram 上传、分片、`getFile`、Range/HEAD
- `src/db.js` / `src/admin-schema.js`：D1 表结构与查询
- `public/`：无构建步骤的 SPA
- `pages/`：Pages 前端与同源转发入口
- `pickup/`：独立的取件专用 Pages 页面、受限网关与部署配置
- `migrations/`：`0001` 分享表、`0002` 管理员 Passkey 表（运行时也会自动建表）

## 部署

### 0. 准备

- Node.js 22+
- Cloudflare 账号
- 安装依赖：

```bash
npm ci
npx wrangler login
```

> 仓库里的 `wrangler.toml` 中 `database_id` 是当前部署值，Fork 到自己的账号后请替换；`ADMIN_ORIGIN` 不写入仓库，请在控制台变量或 Secret 中配置。

### 1. 创建 D1

```bash
npx wrangler d1 create filecodebox
```

把返回的 `database_id` 写入 `wrangler.toml` 的 `[[d1_databases]]`。表结构会在首次请求时自动创建（幂等）；`migrations/` 仅作离线参考，也可手动执行。

### 2. 配置 Worker 变量/密钥

在 Cloudflare 控制台 **Worker → Settings → Variables and Secrets** 配置，或通过 `.dev.vars` + `--secrets-file` 部署。

| 变量 | 必填 | 说明 |
|---|---|---|
| `ADMIN_ORIGIN` | 是 | 前端固定 origin，必须与浏览器访问地址完全一致，不带末尾 `/`。Pages 示例：`https://<your-pages-project>.pages.dev`；本地：`http://localhost:8787` |
| `ADMIN_API_TOKEN` | 是（仅首次） | 32 字节随机值的 base64url 串，仅用于首次绑定 Passkey；绑定后不再授权管理 |
| `FILE_SECRET` | 强烈建议 | 文件直链、上传凭证、分片凭证的 HMAC 密钥；至少 32 字节随机值 |
| `IMG_BED_URL` | ImgBed 模式 | 已部署的 ImgBed 地址，例如 `https://img.example.com` |
| `TG_BOT_TOKEN` | Telegram 模式 | BotFather 的 Bot Token |
| `TG_CHAT_ID` | Telegram 模式 | 目标频道/群组的数字 ID（通常 `-100...`） |
| `TG_API` | 否 | `api.telegram.org` 的反代域名 |
| `IMG_BED_UPLOAD_TOKEN` | 否 | ImgBed API Token，按 `Authorization: Bearer` 发送 |
| `IMG_BED_UPLOAD_TOKEN_PARAM` | 否 | 仅 ImgBed 使用 `authCode` 时设为 `authCode` |
| `IMG_BED_UPLOAD_CHANNEL` | 否 | ImgBed 上传通道，例如 `cfr2` |
| `IMG_BED_ADMIN_TOKEN` | 否 | 删除分享时清理 ImgBed 对象所需的管理 token |
| `APP_NAME` / `APP_SUBTITLE` | 否 | 页面标题与副标题 |

> `TG_BOT_TOKEN` 与 `TG_CHAT_ID` 同时存在时优先使用 Telegram；否则使用 `IMG_BED_URL` 指向的 ImgBed。

生成随机密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

> 未设置 `FILE_SECRET` 时会回退到 `ADMIN_KEY` 或 `ADMIN_API_TOKEN`；三者都没有时，文件分享/上传会失败。**不会使用公开默认密钥。** `ADMIN_KEY` 已不用于管理登录。

### 3. 部署 Worker

```bash
npm run deploy -- --dry-run
npm run deploy -- --secrets-file .dev.vars
```

> `wrangler.toml` 不再保存 `ADMIN_ORIGIN`（本仓库历史中也不再包含部署域名）。线上请在控制台变量或 `npx wrangler secret put ADMIN_ORIGIN` 中设置（`keep_vars = true` 会保留控制台已有配置）；`.dev.vars` 里的 `http://localhost:8787` 仅供本地，用 `--secrets-file .dev.vars` 部署前必须换成线上 origin，否则管理登录会因 RP ID 不匹配而失败。

后端配置为 `workers_dev = false`、`preview_urls = false`、`routes = []`，不发布 `workers.dev`、Worker 预览 URL 或自定义 HTTP 路由。主站和取件站仍通过 `BACKEND` service binding 调用，Cron 不受影响。正常使用时会自动初始化 D1，无需直接访问 Worker 的 `/api/install`。

上述限制需重新部署 Worker 后生效，不会仅因修改本地文件而关闭现网地址。已有的额外自定义域名、版本/部署 URL 和其他环境的公开入口，还应在 Cloudflare 控制台分别核对并停用；不要给后端重新添加公网路由。

### 4. 部署 Pages 前端（推荐）

Pages 只托管 `public/` 前端，`/api`、`/file` 通过 `BACKEND` service binding 转发给 Worker，不暴露跨域管理接口。

```bash
npx wrangler pages project create filecodebox-cf --production-branch main
npm run pages:deploy
```

`pages:deploy` 会先执行 `scripts/build-pages.mjs`，把前端和转发入口复制到 `.wrangler/pages-dist/`。`pages/_headers` 提供 CSP 等安全响应头，`pages/_routes.json` 控制 Functions 路由。

当前部署方案要求使用 Pages 主站，不能直接访问后端的 `workers.dev` 地址；`ADMIN_ORIGIN` 应保持为主站 Pages 或其自定义域名的 HTTPS origin。

### 4.1. 部署取件专用站点（可选）

`pickupfiles` 是另一个独立的 Pages 项目，与原站共用已有 Worker 和分享数据。原站的寄件、取件、管理功能及生成链接的方式均不改变。

```bash
npx wrangler pages project create pickupfiles --production-branch main
npm run pickup:deploy
```

- `pickup:deploy` 先把取件页面、共享样式和网关构建到 `.wrangler/pickup-dist/`，只上传明确列出的文件，不包含原站的 `app.js`、管理页面或本地密钥。
- `pickup/wrangler.toml` 的 `BACKEND` service binding 默认指向同账号下的 `filecodebox-cf` Worker；如果原 Worker 名称不同，请修改 `service`。不需要绑定 D1、复制存储密钥或更改 `ADMIN_ORIGIN`。
- 把取件站地址和取件码发给对方即可，也可以发送 `https://<your-pickup-project>.pages.dev/#r/取件码`（以实际部署域名为准）。原站生成的 `#r/CODE` 链接换成取件站域名也能使用。
- 副站默认名称为 `pickupfiles`，UI 复用原站样式，但名称和配置完全独立。在 `pickup/wrangler.toml` 的 `[vars]` 中设置 `PICKUP_NAME` / `PICKUP_SUBTITLE` 后重新部署副站即可修改；这两个字段是公开文案，不要写入原站地址或敏感信息。主站仍独立使用 `APP_NAME` / `APP_SUBTITLE`，互不影响。
- 副站的 `GET /api/config` 由自身网关直接返回，仅包含副站 `name` / `subtitle`，不调用 `BACKEND`，不返回主站品牌、存储类型或寄件配置。配置加载失败时，页面保留独立的 `pickupfiles` 默认名称。
- 修改本地项目名不会自动重命名或停用已经部署的旧 Pages 项目。
- 支持文本、文件、密码取件和文件 `Range` / `HEAD` 请求。只有分享元信息、取件和文件下载会转发给后端；寄件、上传、分片、安装、管理等接口均返回 404，且不转发管理 Cookie。
- 浏览器只向取件站发出请求。ImgBed 下载重定向由取件站服务端跟随并流式返回，不把存储地址或上游 Cookie 发送给浏览器；Telegram 下载仍通过 Worker 流式返回。

取件站不会在页面或请求中配置原站网址，但这不等于给原站 Pages 增加访问控制，已经知道原站地址的人仍可直接访问。分享内容由寄件人提供，如果需要隐藏原站，请不要在分享的文本、文件名或副站的公开文案中写入原站地址。

### 5. 首次绑定 Passkey

1. 在固定的 HTTPS 前端打开“管理后台”；
2. 输入 `ADMIN_API_TOKEN`，获得 10 分钟绑定会话；
3. 创建 Passkey，保存只显示一次的 **Backup code**；
4. 之后用 Passkey 登录。API Token 不再能读取、删除或清理分享。

Passkey 与 `ADMIN_ORIGIN` 绑定；更换域名会更换 RP ID，旧 Passkey 失效，需要用 Backup code 在新域名恢复。

## 本地开发与测试

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

`.dev.vars.example`：

```dotenv
ADMIN_ORIGIN=http://localhost:8787
ADMIN_API_TOKEN=your-local-admin-api-token
FILE_SECRET=your-local-file-secret
APP_NAME=文件快递柜
IMG_BED_URL=https://imgbed.test
# TG_BOT_TOKEN=...
# TG_CHAT_ID=-1001234567890
```

测试：

```bash
npm test                 # 分享、管理、上传核心测试
npm run test:runtime     # 真实 workerd + D1 关键流程
npm run test:pages       # Pages 转发入口
npm run test:pickup      # 取件站网关与前端流程
npm run pickup:build     # 构建取件专用 Pages
```

Telegram 本地端到端测试（内置 mock，无需真实 Bot）：

```bash
FCB_TG_MODE=1 PORT=8088 node preview_local.mjs
BASE=http://127.0.0.1:8088 node tg_e2e_test.mjs
```

## Telegram 存储

### 配置

1. Telegram 搜索 **@BotFather**，发送 `/newbot`，获得 `123456789:AA...` 形式的 Bot Token；
2. 把机器人加入目标群组/频道，至少授予“发送消息”权限；频道需管理员权限；
3. 获取目标会话 ID：
   - 私聊：给 `@userinfobot` 发消息，使用返回的数字 ID；
   - 群组/频道：把 `@RawDataBot` 加入会话发一条消息，或调用 `https://api.telegram.org/bot<TOKEN>/getUpdates`，读取 `message.chat.id` / `my_chat_member.chat.id`；
4. 在 Worker 配置 `TG_BOT_TOKEN`、`TG_CHAT_ID`；两者同时存在时启用 Telegram，否则使用 ImgBed。

> Bot 默认开启 Privacy Mode 时可能收不到普通群消息；发 `/start@机器人` 或 @ 提及即可。必要时在 BotFather 用 `/setprivacy` 关闭，并把机器人移出后重新加入。

### 行为与限制

- 小文件（≤ 20 MiB）：`/api/imgbed/upload` 单发 `sendDocument`；
- 大文件：前端 `init → 逐片 /api/chunk/upload → /api/chunk/merge`，每片最多 20 MiB，最多 1000 片；
- 取件：Worker 服务端用 bot token 调 `getFile`，流式返回；文件响应强制 `attachment` + `application/octet-stream` + `nosniff`；
- 删除分享只删取件码，**不删除 Telegram 频道/群组里的文件**；
- 单文件下载受 Telegram `getFile` 的 20 MiB 限制；分片文件按片拼接，支持 Range/HEAD。

| 场景 | 限制 |
|---|---|
| 单文件上传 | ≤ 20 MiB |
| 分片上传 | 每片 ≤ 20 MiB；最多 1000 片 |
| 单文件下载 | ≤ 20 MiB（`getFile` 限制） |
| 分片下载 | 逐片 `getFile` 拼接，支持 Range/HEAD |

## API 速查

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/share` | 创建分享。`multipart`/JSON：`type=text\|file`、`text`、`file_key`+`upload_token`+`file_name`+`file_type`+`file_size`、`expire_ms`、`download_limit`、`password` |
| `POST` | `/api/imgbed/upload` | 上传入口；返回 `{ id, src, upload_token }`（`upload_token` 1 小时有效） |
| `POST` | `/api/chunk/init` | 初始化 Telegram 分块，返回 `{ chunkSize }`（20 MiB） |
| `POST` | `/api/chunk/upload` | 上传单个分片，返回 `{ success, index, fileId, size, fileName, chunkToken }` |
| `POST` | `/api/chunk/merge` | 校验 `chunks` 的 `chunkToken` 并合并，返回 `{ id, src, upload_token }` |
| `GET` | `/api/share/:code` | 取件码元信息（不消耗次数） |
| `POST` | `/api/share/:code/claim` | 取件并原子扣减一次；文件返回 `/file/:key?c=CODE&t=TOKEN` |
| `GET` | `/file/:key?c=CODE&t=TOKEN` | 校验 10 分钟 token 与分享状态；ImgBed 302 / Telegram 附件返回 |
| `GET` | `/api/admin/status` | 是否已绑定、当前会话状态；不返回凭证 |
| `POST` | `/api/admin/login` | `{code}`：首次 API Token 或绑定后的备用码，获得绑定/恢复会话 |
| `POST` | `/api/admin/passkey/register/options`、`/verify` | 创建 Passkey 并签发管理会话 |
| `POST` | `/api/admin/passkey/login/options`、`/verify` | Passkey 登录 |
| `POST` | `/api/admin/backup/rotate` | 轮换备用码并撤销其他会话 |
| `POST` | `/api/admin/logout` | 撤销当前会话 |
| `GET` | `/api/admin/stats`、`/shares` | 统计 / 分享列表（需管理会话 Cookie） |
| `DELETE` | `/api/admin/share/:code` | 删除分享（需管理会话） |
| `POST` | `/api/admin/sweep` | 清理过期/超额分享（需管理会话） |
| `GET`/`POST` | `/api/install` | 初始化 D1（幂等） |
| `GET` | `/api/config`、`/api/health` | 公共配置 / 健康检查 |

## 安全与边界

- 管理员使用 Passkey（WebAuthn）；会话 Cookie 为 `Secure`、`HttpOnly`、`SameSite=Strict`，最长 8 小时；管理写请求要求 JSON 且 `Origin === ADMIN_ORIGIN`。
- 分享密码使用 PBKDF2（随机盐 + 10 万次迭代），并兼容旧 SHA-256 记录。
- 文件 token 绑定分享码、10 分钟过期；上传/分片使用独立 `upload_token`/`chunkToken`，文件 key 经过白名单校验。
- 管理密钥/备用码验证及挑战签发按 IP 限流：每 5 分钟 30 次。
- ImgBed 模式下 Worker 流式转发请求，但**仍受 Workers 请求体上限约束**（通常 100 MB，企业版更高）；Telegram 模式受 20 MiB 单文件与 1000 片限制。
- Telegram 模式删除分享不会删除频道/群组中的文件；ImgBed 模式配置 `IMG_BED_ADMIN_TOKEN` 时会同步清理对象。
- 所有密钥都应通过 Cloudflare Secret 配置，不要提交 `.dev.vars`、`backupcode.txt` 或真实 token。

## 升级提示

- 旧版 `/file/:key?t=...` 直链（缺少 `c=` 分享码）已失效，请重新取件。
- 旧版未带 `upload_token` 的建分享请求会被拒绝。
- `ADMIN_KEY` 和旧 Bearer token 不再用于管理登录；首次使用 `ADMIN_API_TOKEN` 绑定 Passkey。
