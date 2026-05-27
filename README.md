# IT Service Management (ITSM)

企业 IT 服务管理系统，面向集团 IT 团队提供工单管理、自动派单、运维协作的一站式解决方案。支持桌面运维、网络运维、应用系统运维等多团队协同。

## 功能概览

| 模块 | 角色 | 功能 |
|------|------|------|
| 登录 | 全员 | 手机号 + 验证码登录，JWT 鉴权，角色自动识别 |
| 提交工单 | 全员 | 快速提单（8 种预设场景）、详细提单（类型 / 地点 / 紧急程度） |
| 我的工单 | 全员 | 工单列表、状态筛选、下拉刷新、催办、补充说明、详情弹窗 |
| 我的看板 | 运维 | 仅显示分配给自己处理的工单，支持回复客户、关闭、转派 |
| 管理看板 | 管理员 | 全局工单视图，按状态 / 时间筛选，分配处理人，关闭 / 重开工单 |
| 用户管理 | 管理员 | 用户列表、角色管理、VIP 标记、模糊搜索、详情弹窗 |

### 自动化能力

- **自动派单**：用户提交工单 → 按问题类型匹配对应分组 → VIP 优先 → 负载均衡分配
- **邮件通知**：新工单指派、催办、转派时，QQ 邮箱自动通知处理人 + 抄送管理员
- **状态联动**：分配处理人自动变更为"处理中"，关闭工单用户端同步显示"已完成"
- **Zammad 双向同步**：所有工单 / 用户 / 分组操作实时写入 Zammad

### 权限体系

| 角色 | 可见页面 |
|------|---------|
| 管理员 (admin) | 提交工单、我的工单、我的看板、管理看板、用户管理 |
| IT 运维 (agent) | 提交工单、我的工单、我的看板（仅自己负责的工单） |
| 普通用户 (customer) | 提交工单、我的工单（仅自己提交的工单） |

## 技术架构

```
┌──────────────────────────┐
│  H5 前端（6 个页面）       │
│  login / submit / list   │
│  agent / admin / users   │
└──────────┬───────────────┘
           │ HTTP + JWT Bearer Token
┌──────────▼───────────────┐
│  Node.js Express 服务层   │
│  - JWT 认证 & 角色识别    │
│  - API 代理 & 业务逻辑    │
│  - 自动派单 & VIP 优先级   │
│  - QQ 邮箱 SMTP 通知      │
└──────────┬───────────────┘
           │ Zammad REST API
┌──────────▼───────────────┐
│  Zammad (Docker)         │
│  - 工单引擎 & 用户管理     │
│  - PostgreSQL / Redis    │
│  - Elasticsearch 全文搜索 │
└──────────────────────────┘
```

## 目录结构

```
itsm/
├── server.js             # 核心后端（Express + JWT + 代理 + 业务逻辑）
├── docker-compose.yml    # Zammad 容器编排
├── package.json          # Node.js 依赖
├── .env.example          # 环境变量模板
├── h5/                   # 前端页面（纯 HTML/CSS/JS，零框架依赖）
│   ├── login.html        #   手机验证码登录
│   ├── submit.html       #   提交工单
│   ├── list.html         #   我的工单（用户端）
│   ├── agent.html        #   我的看板（运维端）
│   ├── admin.html        #   管理看板（管理员端）
│   └── users.html        #   用户管理（管理员端）
└── README.md
```

## 快速开始（本地开发）

### 环境要求

- Docker Desktop（或 Docker + Docker Compose）
- Node.js >= 18
- macOS / Linux / Windows WSL2

### 1. 克隆仓库

```bash
git clone git@github.com:iostream911/itsm.git
cd itsm
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填写：

| 变量 | 说明 |
|------|------|
| `EMAIL_USER` | QQ 邮箱地址（用于发送通知邮件） |
| `EMAIL_PASS` | QQ 邮箱 SMTP 授权码（非 QQ 密码） |
| `ZAMMAD_TOKEN` | Zammad API Token（首次启动后从 Zammad 后台获取） |
| `JWT_SECRET` | 随机字符串（`openssl rand -hex 32`） |

> QQ 邮箱授权码获取：登录 QQ 邮箱 → 设置 → 账户 → POP3/SMTP 服务 → 开启并生成授权码

### 3. 启动 Zammad

```bash
docker compose up -d
```

等待约 1-2 分钟初始化，访问 http://localhost:8088 完成 Zammad 初始设置。

### 4. 创建 Zammad API Token

Zammad 后台 → 管理（左下角齿轮）→ API → 添加 Token：
- 名称：`H5接入`
- 权限：勾选 `ticket.agent`、`admin.group`、`admin.organization`

将生成的 Token 填入 `.env` 的 `ZAMMAD_TOKEN`。

### 5. 安装依赖 & 启动

```bash
npm install
node server.js
```

访问 http://localhost:3000/login.html

### 6. 创建运维团队

在 Zammad 后台（http://localhost:8088）→ 管理 → 用户 → 新建：

| 姓名 | 角色 | 分组 | 说明 |
|------|------|------|------|
| 张伟 | Agent | 桌面运维 | 电脑、打印机、会议设备 |
| 李明 | Agent | 桌面运维 | 同上 |
| 王强 | Agent | 网络运维 | 网络、VPN、端口 |
| 陈静 | Agent | 应用系统运维 | ERP、OA 等系统 |

在用户详情中将核心运维人员标记为 VIP，系统将优先将工单分配给 VIP。

## 生产部署

```bash
# 1. 服务器安装依赖
apt install -y docker.io docker-compose-v2 nginx nodejs npm
npm install -g pm2

# 2. 部署代码
cd /opt && git clone git@github.com:iostream911/itsm.git
cd itsm && cp .env.example .env  # 编辑填写生产配置

# 3. 启动服务
docker compose up -d
npm install
pm2 start server.js --name itsm-server
pm2 save && pm2 startup

# 4. Nginx 反向代理 + HTTPS
certbot --nginx -d 你的域名.com
```

## API 接口

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | `/auth/send-code` | 发送验证码 | 无 |
| POST | `/auth/login` | 验证码登录 | 无 |
| GET | `/auth/me` | 获取当前用户 + 刷新 Token | JWT |
| POST | `/my-tickets` | 提交工单 | JWT |
| GET | `/my-tickets` | 查询我的工单 | JWT |
| POST | `/my-tickets/:id/urge` | 催办工单 | JWT |
| GET | `/my-dashboard` | 运维人员看板 | JWT (agent/admin) |
| PUT | `/api/v1/tickets/:id` | 更新工单（分配/关闭/转派） | 无（服务端 Token） |
| GET | `/api/v1/tickets` | 工单列表 | 无 |
| PUT | `/api/v1/users/:id` | 更新用户（角色/VIP） | 无 |

## 技术栈

- **后端**：Node.js + Express + `http-proxy-middleware` + `jsonwebtoken` + `nodemailer`
- **工单引擎**：Zammad 7.0 + PostgreSQL 17 + Redis 8 + Elasticsearch 9
- **前端**：纯 HTML/CSS/JS（无框架），响应式布局，移动端 H5
- **容器化**：Docker Compose
- **进程守护**：PM2

## License

MIT
