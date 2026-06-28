# ITSM + Zammad K3s 部署架构

> 最后更新: 2026-06-11  
> 服务器: 172.24.16.40 | K3s v1.35.5 | Ubuntu 24.04 | 16核 31GB

## 整体架构

```
172.24.16.40 (16核 31GB 981GB磁盘)
┌─────────────────────────────────────────────────┐
│  K3s (v1.35.5) — 单节点 control-plane            │
│                                                  │
│  ┌──────────────┐  ┌──────────────────────────┐ │
│  │  ITSM x2     │  │  Zammad 工单引擎          │ │
│  │  Node.js     │  │  ┌────────────────────┐  │ │
│  │  :30081      │  │  │ Railsserver :3000   │  │ │
│  └──────┬───────┘  │  │ Scheduler           │  │ │
│         │          │  │ Websocket   :6042   │  │ │
│         │ HTTP     │  │ Nginx       :8080   │  │ │
│         │          │  ├────────────────────┤  │ │
│         ▼          │  │ PostgreSQL  :5432   │  │ │
│  ┌──────────────┐  │  │ Redis       :6379   │  │ │
│  │ 外部服务      │  │  │ Memcached   :11211  │  │ │
│  │ 短信 :9892   │  │  │ Elasticsearch:9200 │  │ │
│  │ SMTP :465    │  │  └────────────────────┘  │ │
│  └──────────────┘  └──────────────────────────┘ │
│                                                  │
│  ┌──────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ Rancher  │ │ Argo CD  │ │ cert-manager   │  │
│  │ :30922   │ │ GitOps   │ │ HTTPS 证书     │  │
│  └──────────┘ └──────────┘ └────────────────┘  │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │  Grafana :30300  │  Loki  │  Prometheus  │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

## 命名空间: `itsm`

### 服务端口

| Service | 类型 | ClusterIP 端口 | NodePort | 用途 |
|---------|------|---------------|----------|------|
| itsm | NodePort | 3000 | **30081** | ITSM H5 前端 + API |
| zammad-ui | NodePort | 3000 | **30082** | Zammad 管理界面 |
| zammad | ClusterIP | 8080→3000 | — | ITSM→Zammad API 代理 |
| zammad-railsserver | ClusterIP | 3000 | — | Zammad Rails 主进程 |
| zammad-websocket | ClusterIP | 6042 | — | Zammad WebSocket |
| zammad-postgresql | ClusterIP | 5432 | — | PostgreSQL 17 |
| zammad-redis | ClusterIP | 6379 | — | Redis 8 |
| zammad-elasticsearch | ClusterIP | 9200 | — | Elasticsearch 9 |
| zammad-memcached | ClusterIP | 11211 | — | Memcached |

### 外部访问

| 服务 | 地址 |
|------|------|
| ITSM 工单系统 | `http://172.24.16.40:30081/login.html` |
| Zammad 管理后台 | `http://172.24.16.40:30082` |

### Pod 资源分配

| Pod | 副本 | CPU 请求 | 内存请求 | CPU 限制 | 内存限制 | 实际用量 |
|-----|------|---------|---------|---------|---------|---------|
| itsm | 2 | — | — | 500m | 512Mi | ~22Mi |
| zammad-railsserver | 1 | 100m | 384Mi | 500m | 768Mi | ~265Mi |
| zammad-scheduler | 1 | 50m | 256Mi | 300m | 512Mi | ~410Mi |
| zammad-websocket | 1 | 20m | 128Mi | 200m | 256Mi | ~244Mi |
| zammad-postgresql | 1 | 100m | 256Mi | 500m | 512Mi | ~105Mi |
| zammad-redis | 1 | 50m | 128Mi | 200m | 256Mi | ~5Mi |
| zammad-elasticsearch | 1 | 100m | 768Mi | 1000m | 1280Mi | ~919Mi |
| zammad-memcached | 1 | 10m | 32Mi | 100m | 96Mi | ~3Mi |

### 持久化存储 (PVC)

| PVC | 容量 | 存储类 | 挂载路径 |
|-----|------|--------|---------|
| zammad-postgresql-pvc | 10Gi | local-path | /var/lib/postgresql/data |
| zammad-redis-pvc | 2Gi | local-path | /data |
| zammad-elasticsearch-pvc | 10Gi | local-path | /usr/share/elasticsearch/data |
| zammad-storage-pvc | 5Gi | local-path | /opt/zammad/storage |
| zammad-backup-pvc | 5Gi | local-path | /var/tmp/zammad |

总计: **32Gi**

## 数据流

### 用户提交流程

```
用户浏览器                    ITSM (Node.js)                 Zammad
    │                             │                            │
    ├─ POST /auth/send-code ─────→│                            │
    │  (短信验证码)                ├─ fetch SMS API ──→ 118.178.135.212:9892
    │                             │                            │
    ├─ POST /auth/login ─────────→│                            │
    │  (手机号+验证码)             ├─ JWT 签发                  │
    │                             │                            │
    ├─ POST /my-tickets ─────────→│                            │
    │  (提交工单)                  ├─ POST /api/v1/tickets ───→│
    │                             │                            ├─ 创建工单
    │                             ├─ autoAssign() ────────────→│
    │                             │                            ├─ 分配处理人
    │                             ├─ SMTP ──→ QQ邮箱通知处理人  │
    │                             │                            │
    ├─ GET /my-tickets ──────────→│                            │
    │  (查看我的工单)              ├─ GET /api/v1/tickets ─────→│
    │                             │                            │
    ├─ POST /my-tickets/:id/urge →│                            │
    │  (催办)                     ├─ SMTP ──→ 邮件通知         │
```

### 自动派单逻辑

```
1. 按问题类型匹配 Zammad 分组 (桌面运维/网络运维/应用系统运维)
2. 筛选该分组的 Agent 角色用户
3. VIP 优先: 组内有 VIP 标记的处理人则只看 VIP
4. 负载均衡: 选 open 工单最少的处理人
5. 分配后自动改状态为"处理中"
6. QQ 邮箱通知处理人 + 抄送管理员
```

## 配置项

### ConfigMap: `itsm-config`

| 变量 | 值 | 说明 |
|------|-----|------|
| ZAMMAD_URL | http://zammad-railsserver:3000 | ITSM→Zammad 直连 |
| TZ | Asia/Shanghai | 时区 |

### Secret: `itsm-secret`

| 变量 | 说明 |
|------|------|
| JWT_SECRET | JWT 签名密钥 |
| ZAMMAD_TOKEN | Zammad API Token（rails console 生成） |
| EMAIL_USER / EMAIL_PASS | QQ 邮箱 SMTP 凭证 |
| SMS_LOGIN_NAME / SMS_PASSWORD | 短信网关凭证 |
| SMS_API_URL | http://118.178.135.212:9892 |
| SMS_SIGNATURE | 【苏州名城文化科技】 |

> **注意**: Secret 不在 Git 版本控制中。通过 `kubectl create secret generic` 手动创建。

### ConfigMap: `zammad-config`

| 变量 | 值 | 说明 |
|------|-----|------|
| POSTGRESQL_HOST | zammad-postgresql | K8s Service DNS |
| REDIS_URL | redis://zammad-redis:6379 | |
| MEMCACHE_SERVERS | zammad-memcached:11211 | |
| ELASTICSEARCH_HOST | zammad-elasticsearch | |
| ES_JAVA_OPTS | -Xms512m -Xmx512m | ES 堆内存 |

## GitOps 流程 (Argo CD)

```
GitHub (iostream911/itsm, main)
    │
    │ git push
    ▼
Argo CD (3分钟轮询)
    │
    │ 检测变更 → 自动同步
    ▼
K3s itsm namespace
    ├── Deployment: itsm (v1.2.2)
    ├── Deployment: zammad-*  (7个)
    ├── Service:   zammad-*  (8个)
    ├── ConfigMap: itsm-config, zammad-config
    ├── Secret:    itsm-secret (手动管理, 不在Git)
    ├── PVC:       zammad-*-pvc (5个)
    └── Job:       zammad-init (Completed)
```

### 发布流程

```
本地修改 k8s/*.yaml
  → git add & commit
  → git push origin main
  → Argo CD 自动检测并同步
  → kubectl get pods -n itsm 验证
```

## 维护操作

### 查看状态

```bash
ssh huozhe@172.24.16.40
kubectl get pods -n itsm
kubectl top pods -n itsm
kubectl top node
```

### 查看日志

```bash
kubectl logs -n itsm deployment/itsm --tail=50
kubectl logs -n itsm deployment/zammad-railsserver --tail=50
```

### 生成 Zammad API Token

```bash
kubectl exec -n itsm deployment/zammad-railsserver -- bundle exec rails r "
admin = User.find(1)
Token.where(name: 'ITSM-K8s-Integration').destroy_all
t = Token.create!(
  user_id: admin.id,
  name: 'ITSM-K8s-Integration',
  action: 'api',
  persistent: true,
  preferences: { permission: ['admin', 'ticket.agent'] }
)
puts t.token
"
# 将输出的 Token 更新到 Secret:
kubectl delete secret itsm-secret -n itsm
kubectl create secret generic itsm-secret -n itsm \
  --from-literal=ZAMMAD_TOKEN='<新token>' \
  --from-literal=JWT_SECRET='...' \
  ...
kubectl rollout restart deployment/itsm -n itsm
```

### 备份 Zammad 数据

```bash
# PostgreSQL 备份
kubectl exec -n itsm deployment/zammad-postgresql -- \
  pg_dump -U zammad zammad_production > zammad-backup-$(date +%Y%m%d).sql

# PVC 中的数据自动持久化在 local-path 上
ls /var/lib/rancher/k3s/storage/
```

## 已知限制

1. **单节点** — 无高可用，服务器宕机则全部服务中断
2. **local-path 存储** — 数据绑在单机上，迁移需手动拷贝
3. **Nginx DNS** — Zammad Nginx 未使用（ITSM 直连 Railsserver 绕过 DNS 解析问题）
4. **ES 单节点** — 无副本，数据丢失风险
5. **Secret 手动管理** — 不在 Git 中，Argo CD 同步时不会覆盖

## K8s 部署文件

| 文件 | 内容 |
|------|------|
| k8s/namespace.yaml | itsm 命名空间 |
| k8s/configmap.yaml | ITSM 环境变量 |
| k8s/deployment.yaml | ITSM Deployment + Service (NodePort 30081) |
| k8s/secret.yaml | Secret 模板（仅占位符，不在 Git 跟踪） |
| k8s/zammad-infra.yaml | Zammad ConfigMap + PVC + PostgreSQL/Redis/ES/Memcached + Init Job |
| k8s/zammad-app.yaml | Zammad Railsserver/Scheduler/Websocket + Services + Zammad UI NodePort |
