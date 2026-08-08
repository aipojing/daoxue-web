#!/usr/bin/env bash
# 绑定自定义域名到 Worker。
# 前提：域名的 NS 已切到 Cloudflare 且站点状态为 Active。
# 用法：bash scripts/bind-domain.sh aipojing.xyz

set -euo pipefail
DOMAIN="${1:?用法: bash scripts/bind-domain.sh <域名>}"

echo "1/3 检查 NS 是否已切到 Cloudflare…"
if ! dig NS "$DOMAIN" @8.8.8.8 +short | grep -q cloudflare; then
  echo "   ❌ NS 还没生效，当前是："
  dig NS "$DOMAIN" @8.8.8.8 +short | sed 's/^/      /'
  echo "   等 NS 切换完成后再运行本脚本。"
  exit 1
fi
echo "   ✅ NS 已指向 Cloudflare"

echo "2/3 部署 Worker（wrangler.jsonc 中的 routes 会自动创建自定义域名绑定）…"
npm run deploy

echo "3/3 验证（证书签发可能需要 1-3 分钟）…"
for i in $(seq 1 10); do
  if curl -s -m 10 "https://$DOMAIN/api/health" | grep -q '"ok":true'; then
    echo "   ✅ https://$DOMAIN 已可访问"
    curl -s -o /dev/null -w "   www 子域: %{http_code}\n" "https://www.$DOMAIN/" || true
    exit 0
  fi
  echo "   第 $i 次探测未通过，30 秒后重试…"
  sleep 30
done

echo "   ⚠️ 多次探测未通过，可能是证书仍在签发。稍后手动验证："
echo "      curl https://$DOMAIN/api/health"
