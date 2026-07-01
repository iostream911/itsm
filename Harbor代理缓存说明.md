# Harbor 代理缓存使用说明

> 最后更新: 2026-07-01

## 架构

```
K3s / 任何服务器
    ↓ containerd 拉取 harbor.szctdg.tech/<proxy-project>/...
Harbor (172.24.10.8)
    ↓ HTTP_PROXY → 172.18.0.1:16894
socat 中继 (systemd: harbor-proxy-relay)
    ↓ → 127.0.0.1:16893
SSH 反向隧道 (Mac → Harbor, 端口 16893)
    ↓ → Mac 127.0.0.1:16893
gost HTTP→HTTP 桥接 (Mac 端口 16893)
    ↓ → 127.0.0.1:7990
淘气兔 VPN HTTP 代理 (Mac 端口 7990)
    ↓
Docker Hub / quay.io / registry.k8s.io / 外网
```

首次拉取走完整链路，之后 Harbor 缓存后秒拉。

---

## 三个代理缓存项目

| Harbor 项目 | 上游 Registry | 用途 |
|------|------|------|
| `docker-hub-proxy` | Docker Hub (`https://hub.docker.com`) | 通用镜像 |
| `quay-proxy` | Quay.io (`https://quay.io`) | cert-manager 等 |
| `k8s-proxy` | registry.k8s.io (`https://registry.k8s.io`) | ingress-nginx 等 |

---

## 组件清单

| 组件 | 位置 | 说明 |
|------|------|------|
| Harbor | 172.24.10.8 | core/jobservice 已配 HTTP_PROXY，registry 手动添加 |
| socat 中继 | `harbor-proxy-relay` (systemd，开机自启) | Harbor 宿主机 16894 → 127.0.0.1:16893 |
| SSH 隧道 | Mac → Harbor | `ssh -R 16893:127.0.0.1:16893`（Mac 端执行） |
| gost 桥接 | Mac 端口 16893 → 7990 | HTTP→HTTP 转发 |
| 淘气兔 VPN | Mac 端口 7990 | HTTP 代理，出墙 |
| Docker 代理 | Harbor 宿主机 `/etc/systemd/system/docker.service.d/http-proxy.conf` | 用于 `docker build`/`docker pull` |
| Harbor Registry 代理 | `/root/harbor/harbor/docker-compose.yml` | registry 容器添加 HTTP_PROXY |
| k3s 认证 | `/etc/rancher/k3s/registries.yaml` | 全局 robot 账户 |
| 机器人账户 | `robot$global-puller` | 所有项目拉取权限 |

---

## 使用方法

### 拉取镜像格式

```
# Docker Hub
harbor.szctdg.tech/docker-hub-proxy/library/<image>:<tag>

# quay.io
harbor.szctdg.tech/quay-proxy/<org>/<image>:<tag>

# registry.k8s.io
harbor.szctdg.tech/k8s-proxy/<image>:<tag>
```

### 示例

```bash
# Docker Hub 镜像
crictl pull harbor.szctdg.tech/docker-hub-proxy/library/nginx:alpine

# quay.io 镜像 (cert-manager)
crictl pull harbor.szctdg.tech/quay-proxy/jetstack/cert-manager-controller:v1.16.3

# k8s.io 镜像 (ingress-nginx)
crictl pull harbor.szctdg.tech/k8s-proxy/ingress-nginx/controller:v1.12.0
```

### K3s 已通过 Harbor 部署的组件

| 组件 | 镜像来源 |
|------|------|
| cert-manager (controller + webhook + cainjector) | `harbor.szctdg.tech/quay-proxy/jetstack/*` |
| ingress-nginx controller | `harbor.szctdg.tech/k8s-proxy/ingress-nginx/*` |

---

## 维护

### 启动步骤（Mac 开机后按顺序执行）

**1. 确保淘气兔 VPN 已连接**（端口 7990）

**2. 启动 gost 桥接**（Mac 上）：
```bash
/tmp/gost -L http://127.0.0.1:16893 -F http://127.0.0.1:7990 &
```

**3. 建立 SSH 隧道**（Mac 上）：
```bash
sshpass -p '@Yangren930924' ssh -T -o StrictHostKeyChecking=no -fN \
  -o ServerAliveInterval=30 \
  -R 16893:127.0.0.1:16893 root@172.24.10.8
```

### 验证链路

**Mac 端测试**：
```bash
curl -s --max-time 10 -x http://127.0.0.1:16893 https://registry-1.docker.io/v2/ -I
# 正常：HTTP/2 401
```

**Harbor 端测试**：
```bash
curl -s --max-time 10 -x http://127.0.0.1:16894 https://registry-1.docker.io/v2/ -I
# 正常：HTTP/1.1 401 Unauthorized
```

**Docker pull 测试**：
```bash
docker pull docker.io/library/alpine:latest
# 正常：下载成功
```

### 故障排查

| 问题 | 检查 |
|------|------|
| Harbor 端 503 | gost 没启动，或淘气兔端口变了 |
| Harbor 端 502 | Harbor 代理端点 unhealthy，等 5 分钟健康检查 |
| Docker pull EOF | SSH 隧道断开，重新执行步骤 3 |
| 构建卡住 | `ENV HTTP_PROXY` 没设，Dockerfile 里需要加上 |

### Docker 代理配置

Harbor 宿主机 `/etc/systemd/system/docker.service.d/http-proxy.conf`：
```ini
[Service]
Environment="HTTP_PROXY=http://172.18.0.1:16894"
Environment="HTTPS_PROXY=http://172.18.0.1:16894"
Environment="NO_PROXY=localhost,127.0.0.1,172.24.10.8,harbor.szctdg.tech"
```

Dockerfile 中确保容器内也走代理：
```dockerfile
ENV HTTP_PROXY=http://172.18.0.1:16894
ENV HTTPS_PROXY=http://172.18.0.1:16894
```

### 检查 socat 中继

```bash
ssh root@172.24.10.8
systemctl status harbor-proxy-relay
ss -tlnp | grep 16894   # 应显示 LISTEN
```

### 管理 Harbor

浏览器打开 `https://harbor.szctdg.tech`：

| 账号 | 密码 | 权限 |
|------|------|------|
| `admin` | `Harbor12345` | 全局管理 |
| `yangren` | `@Yangren930924` | 项目管理 |

- 查看缓存：项目 → `docker-hub-proxy` / `quay-proxy` / `k8s-proxy` → 仓库
- 清理缓存：勾选镜像 → 删除

### 添加新的代理目标

Harbor 管理端 → Registries → New Endpoint → 填上游 URL → 创建 Proxy Cache 项目关联该 registry。

### k3s 认证

机器人账户 `robot$global-puller` 配置在 `/etc/rancher/k3s/registries.yaml`：

```yaml
configs:
  "harbor.szctdg.tech":
    auth:
      username: robot$global-puller
      password: n6PHLcJrqlMEbuB3fBZkc7ORAstfLUIO
```

---

## 2026-07-01 修复记录

**问题**：Harbor 代理缓存不可用，无法拉取外网镜像和下载 ES 插件。

**原因**：
1. 旧 VPN（byx-core）已停用，gost 指向的 16891 端口失效
2. SSH 隧道断开
3. Harbor registry 容器没有代理配置

**修复步骤**：
1. 找到新 VPN 端口：淘气兔 `127.0.0.1:7990`
2. 重启 gost：`/tmp/gost -L http://127.0.0.1:16893 -F http://127.0.0.1:7990`
3. 重建 SSH 隧道：`ssh -R 16893:127.0.0.1:16893 root@172.24.10.8`
4. 配置 Docker 代理：`/etc/systemd/system/docker.service.d/http-proxy.conf`
5. 配置 Harbor registry 代理：修改 `docker-compose.yml` 添加 `HTTP_PROXY`
6. 验证：`docker pull alpine` 成功

## 已知限制

- Harbor Proxy Cache 的 URL 格式与 Docker 默认不兼容，需显式使用 `harbor.szctdg.tech/<proxy-project>/...`
- Mac 必须开着隧道和淘气兔 VPN，Docker build 需 `ENV HTTP_PROXY`
- Harbor 代理端点 health check 每 5 分钟一次，隧道恢复后最多等 5 分钟
