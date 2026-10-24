#!/usr/bin/env bash
# 本地预览端到端功能测试（配合 preview_local.mjs）
set -u
cd "$(dirname "$0")"
B=http://127.0.0.1:8000
pass=0; fail=0
ok(){ if [ "$1" = "0" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  ✗ $2"; fi; }
code(){ curl -s -o /dev/null -w "%{http_code}" "$@"; }
CODE_RE='"code":"[A-Z0-9-]*"'

echo "== 1. 静态前端 =="
ok "$([ "$(code $B/)" = "200" ] && echo 0 || echo 1)" "GET / -> 200"
ok "$([ "$(code $B/styles.css)" = "200" ] && echo 0 || echo 1)" "GET /styles.css -> 200"
ok "$([ "$(code $B/app.js)" = "200" ] && echo 0 || echo 1)" "GET /app.js -> 200"

echo "== 2. 健康 & 配置 =="
ok "$([ "$(code $B/api/health)" = "200" ] && echo 0 || echo 1)" "GET /api/health -> 200"
ok "$(curl -s $B/api/config | grep -q 'CloudFlare-ImgBed' && echo 0 || echo 1)" "config 声明 ImgBed"

echo "== 3. 文本分享 =="
code1=$(curl -s -F type=text -F text='hello 快递柜' -F expire_ms=0 -F download_limit=0 $B/api/share)
tc=$(echo "$code1" | grep -o "$CODE_RE" | cut -d'"' -f4)
ok "$([ -n "$tc" ] && echo 0 || echo 1)" "生成取件码: $tc"
ok "$(curl -s $B/api/share/$tc | grep -q '"type":"text"' && echo 0 || echo 1)" "meta type=text"
ok "$(curl -s -X POST $B/api/share/$tc/claim | grep -q 'hello 快递柜' && echo 0 || echo 1)" "claim 取回文本"

echo "== 4. 文本 + 密码 =="
pc=$(curl -s -F type=text -F text=secret -F password=pw $B/api/share | grep -o "$CODE_RE" | cut -d'"' -f4)
ok "$([ "$(code -X POST -F password=bad $B/api/share/$pc/claim)" = "401" ] && echo 0 || echo 1)" "错误密码 401"
ok "$(curl -s -X POST -F password=pw $B/api/share/$pc/claim | grep -q secret && echo 0 || echo 1)" "正确密码取到"

echo "== 5. 文件分享（委托 ImgBed） =="
up=$(curl -s -F file=@/etc/hostname $B/api/imgbed/upload)
uid=$(echo "$up" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
ut=$(echo "$up" | grep -o '"upload_token":"[^"]*"' | cut -d'"' -f4)
ok "$([ -n "$uid" ] && [ -n "$ut" ] && echo 0 || echo 1)" "ImgBed 返回 id + upload_token: $uid"
fsz=$(wc -c < /etc/hostname)
fc=$(curl -s -F type=file -F file_key=$uid -F upload_token=$ut -F file_name=hostname -F file_type=text/plain -F file_size=$fsz -F expire_ms=0 -F download_limit=0 $B/api/share | grep -o "$CODE_RE" | cut -d'"' -f4)
ok "$([ -n "$fc" ] && echo 0 || echo 1)" "file share code: $fc"
ok "$(curl -s $B/api/share/$fc | grep -q '"type":"file"' && echo 0 || echo 1)" "fmeta type=file"
fclaim=$(curl -s -X POST $B/api/share/$fc/claim)
furl=$(echo "$fclaim" | grep -o '"/file/[^"]*"' | tr -d '"')
fkey_nq=$(echo "$furl" | sed 's/[?].*//')
ok "$(echo "$furl" | grep -q 't=' && echo 0 || echo 1)" "直链带 token"
ok "$([ "$(code "$B$fkey_nq")" = "403" ] && echo 0 || echo 1)" "缺 token 403"
ok "$([ "$(code "$B$furl")" = "302" ] && echo 0 || echo 1)" "带 token 302"
loc=$(curl -s -o /dev/null -w "%{redirect_url}" "$B$furl")
ok "$(echo "$loc" | grep -q '__imgbed-file' && echo 0 || echo 1)" "跳转指向同源 /__imgbed-file"
rawnl=$(cat /etc/hostname; printf X); want=${rawnl%X}
got=$(curl -s "$loc")
ok "$([ "$(printf '%s' "$got")" = "$(printf '%s' "$want")" ] && echo 0 || echo 1)" "跟随跳转取回内容一致 (got=$(printf %s "$got"|wc -c) want=$(printf %s "$want"|wc -c))"

echo "== 6. 取件次数上限 =="
c3=$(curl -s -F type=text -F text=once -F download_limit=1 $B/api/share | grep -o "$CODE_RE" | cut -d'"' -f4)
ok "$(curl -s -X POST $B/api/share/$c3/claim | grep -q once && echo 0 || echo 1)" "首次取件成功"
ok "$([ "$(code -X POST $B/api/share/$c3/claim)" = "410" ] && echo 0 || echo 1)" "次数用尽 410"

echo "== 7. 管理后台 =="
at=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"password":"preview-admin"}' $B/api/admin/login | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
ok "$([ -n "$at" ] && echo 0 || echo 1)" "admin 登录拿到 token"
ok "$([ "$(code $B/api/admin/shares)" = "401" ] && echo 0 || echo 1)" "无 token 401"
ok "$([ "$(code -H "Authorization: Bearer $at" $B/api/admin/shares)" = "200" ] && echo 0 || echo 1)" "带 token 列表 200"
echo "   stats: $(curl -s -H "Authorization: Bearer $at" $B/api/admin/stats)"

echo "== 8. 删除分享（同步清理 ImgBed） =="
up2j=$(curl -s -F file=@/etc/hostname $B/api/imgbed/upload)
up2=$(echo "$up2j" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
ut2=$(echo "$up2j" | grep -o '"upload_token":"[^"]*"' | cut -d'"' -f4)
dc=$(curl -s -F type=file -F file_key=$up2 -F upload_token=$ut2 -F file_name=h -F file_type=text/plain -F file_size=$fsz -F expire_ms=0 $B/api/share | grep -o "$CODE_RE" | cut -d'"' -f4)
ok "$([ "$(code -X DELETE -H "Authorization: Bearer $at" $B/api/admin/share/$dc)" = "200" ] && echo 0 || echo 1)" "删除 200"
ok "$([ "$(code $B/api/share/$dc)" = "404" ] && echo 0 || echo 1)" "删除后 404"
ok "$([ "$(code $B/__imgbed-file/$up2)" = "404" ] && echo 0 || echo 1)" "ImgBed 侧对象已清理"

echo "== 9. Cron/sweep 路径 =="
up3j=$(curl -s -F file=@/etc/hostname $B/api/imgbed/upload)
up3=$(echo "$up3j" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
ut3=$(echo "$up3j" | grep -o '"upload_token":"[^"]*"' | cut -d'"' -f4)
curl -s -F type=file -F file_key=$up3 -F upload_token=$ut3 -F file_name=h -F file_type=text/plain -F file_size=$fsz -F expire_ms=1 $B/api/share >/dev/null
sw=$(curl -s -X POST -H "Authorization: Bearer $at" $B/api/admin/sweep); echo "   sweep: $sw"
ok "$(echo "$sw" | grep -q cleaned && echo 0 || echo 1)" "sweep 返回 cleaned"
ok "$([ "$(code $B/__imgbed-file/$up3)" = "404" ] && echo 0 || echo 1)" "sweep 同步清理 ImgBed"

echo ""
echo "结果：通过 $pass，失败 $fail"
exit $fail
