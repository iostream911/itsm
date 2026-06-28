# Harbor 代理缓存使用说明

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
gost HTTP→SOCKS5 桥接 (Mac 端口 16893)
    ↓ → 127.0.0.1:16891
byx-core SOCKS5 (Mac 端口 16891)
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
| Harbor | 172.24.10.8 | 已配 HTTP_PROXY |
| socat 中继 | `harbor-proxy-relay` (systemd，开机自启) | 转发容器流量到 SSH 隧道 |
| SSH 隧道 | Mac → Harbor，端口 16893 | 需手动启动 |
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

### 启动 Mac 隧道

每次 Mac 开机后执行一次：

```bash
sshpass -p '@Yangren930924' ssh -T -o StrictHostKeyChecking=no -fN \
  -o ServerAliveInterval=30 \
  -R 16893:127.0.0.1:16893 root@172.24.10.8
```

### 检查隧道

```bash
# 在 Harbor 上执行
curl -s --max-time 5 -x http://127.0.0.1:16893 https://registry-1.docker.io/v2/ -I
# 正常：HTTP/2 401
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

## 已知限制

- Harbor Proxy Cache 的 URL 格式 `/v2/<project>/<image>` 与 Docker 默认 `/v2/<image>` 不兼容
- 无法像传统 registry mirror 那样透明代理（`docker pull nginx` → 自动走 Harbor）
- 需要显式使用 `harbor.szctdg.tech/<proxy-project>/...` 路径
- Mac 必须开着隧道才能从 Harbor 首次拉取新镜像，已缓存的镜像不受影响
