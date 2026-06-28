    # ITSM 运维部署计划

## 服务器

| 项目 | 详情 |
|------|------|
| IP | 172.24.16.40 |
| SSH | `ssh -i ~/.ssh/id_ed25519_huiji huozhe@172.24.16.40` |
| OS | Ubuntu 24.04.1 LTS |
| CPU | 16 核 |
| 内存 | 31 GB |
| 磁盘 | 981 GB（已用 15 GB） |
| Node.js | v22.22.2 |
| Git | 2.43.0 |
| Docker | 29.1.3 |

## 整体架构

```
172.24.16.40  31GB 内存  16核  981GB 磁盘

┌──────────────────────────────────────────────────────────┐
│                   Rancher (管理 UI)                       │
│             一键看所有服务状态 / 日志 / 扩缩容               │
└──────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────────────────────────────────────┐
│                       K3s (轻量 K8s)                      │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │  ITSM    │  │  Huiji   │  │  Zammad               │  │
│  │  Node.js │  │  Next.js │  │  PostgreSQL+ES+Redis  │  │
│  │  x2 副本  │  │  x2 副本  │  │  +Rails              │  │
│  └──────────┘  └──────────┘  └──────────────────────┘  │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │ Grafana  │  │  Loki    │  │  Argo CD             │  │
│  │ 监控面板  │  │ 日志聚合  │  │  GitOps 自动部署      │  │
│  └──────────┘  └──────────┘  └──────────────────────┘  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  cert-manager — HTTPS 证书自动申请续签              │  │
│  └──────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## 三层能力

### 编排层 — K3s

- 容器自动编排、健康检查、资源限制
- 副本管理（挂了自动重启）
- 滚动更新（部署不停机）

### 监控层 — Grafana + Prometheus + Loki

- 资源监控：CPU / 内存 / 磁盘趋势
- 服务健康：HTTP 状态码、响应延迟
- 日志聚合：不用登服务器看日志
- 告警：磁盘 > 80%、服务 Down 自动通知

### 交付层 — Argo CD (GitOps)

- git push tag → GitHub Actions 构建镜像
- Argo CD 检测新镜像 → 自动同步到 K3s
- 手动改配置会被自动回滚（声明式）

## 日常开发流程

```
本地开发 → git commit → git tag v1.3.0 → git push
                                             │
                    ┌────────────────────────┘
                    ▼
          GitHub Actions (CI)
          npm install → docker build → docker push
                    │
                    ▼
          Argo CD (CD)
          检测新镜像 → 更新 K3s → 滚动重启
                    │
                    ▼
          Grafana (验证)
          看面板确认服务正常 / 无报错
```

## 版本对标

| 版本 | 内容 |
|------|------|
| v1.0.0 | 基础功能稳定版 |
| v1.1.0 | 集成短信验证码 |
| v1.1.1 | 修复短信接口 URL 与参数 |
| v1.2.0 | SSO 用户同步 + 未注册用户拦截 |
| v1.2.1 | 增量同步流水号 |

仓库地址：`git@github.com:iostream911/itsm.git`

## 部署阶段

### 第一阶段：平台搭建 (Day 1)

- [ ] 安装 K3s
- [ ] 安装 Helm
- [ ] 安装 Rancher
- [ ] 安装 cert-manager

```bash
# K3s
curl -sfL https://get.k3s.io | sh -s --disable traefik --write-kubeconfig-mode 644

# Helm
snap install helm --classic

# Rancher
helm repo add rancher-stable https://releases.rancher.com/server-charts/stable
helm install rancher rancher-stable/rancher \
  --namespace cattle-system --create-namespace \
  --set hostname=rancher.szmcjt.com \
  --set replicas=1

# cert-manager
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml
```

### 第二阶段：可观测性 (Day 1)

- [ ] Prometheus + Grafana
- [ ] Loki 日志聚合

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts

helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace

helm install loki grafana/loki-stack \
  --namespace logging --create-namespace
```

### 第三阶段：GitOps (Day 1)

- [ ] Argo CD

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

### 第四阶段：服务迁移

- [ ] 迁移 ITSM 到 K3s
- [ ] 迁移 Huiji 到 K3s
- [ ] 迁移 Zammad 到 K3s

### 第五阶段：CI/CD 流水线

- [ ] 配置 GitHub Actions
- [ ] 配置 Argo CD Application
- [ ] 测试 git push tag 自动部署

## 环境变量参考

| 变量 | 说明 |
|------|------|
| SMS_API_URL | http://118.178.135.212:9892 |
| SMS_LOGIN_NAME | szmckj |
| SMS_SIGNATURE | 【苏州名城文化科技】 |
| ZAMMAD_URL | http://localhost:8088 |

## 注意事项

- K3s 单节点没有高可用，生产够用
- Huiji 正在运行（Next.js, PID 79904），迁移时需小心
- Zammad 数据库迁移需单独做数据备份方案
- 整体 K3s 生态约占 3-4GB 内存，服务器资源充足
