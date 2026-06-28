#!/bin/bash
# ITSM 一键部署脚本
# 用法: ./deploy.sh v1.2.3   （版本号）
#       ./deploy.sh           （默认读取 k8s/deployment.yaml 里的版本）

set -e

VERSION="${1:-$(grep 'image:.*itsm/itsm' k8s/deployment.yaml | sed 's/.*://')}"
IMAGE="harbor.szctdg.tech/itsm/itsm:${VERSION}"
SERVER="huozhe@172.24.16.40"
PASSWORD="Hz011020.."

echo "=== 1. Build ==="
docker build -t "$IMAGE" .

echo ""
echo "=== 2. Push ==="
echo '@Yangren930924' | docker login harbor.szctdg.tech -u yangren --password-stdin 2>/dev/null
docker push "$IMAGE"

echo ""
echo "=== 3. Deploy ==="
sshpass -p "$PASSWORD" ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR "$SERVER" "
  echo $PASSWORD | sudo -S kubectl -n itsm set image deploy/itsm itsm=$IMAGE 2>&1
  echo ''
  echo '=== 等待就绪 ==='
  echo $PASSWORD | sudo -S kubectl -n itsm rollout status deploy/itsm --timeout=60s 2>&1
"

echo ""
echo "=== 完成 ==="
echo "访问: http://172.24.16.40:30081"
