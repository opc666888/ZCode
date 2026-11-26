#!/bin/zsh
# Claude 360 防泄露检查（Mac）。发版铁律见 docs/c360/RELEASE-NO-LEAK.md。
# 在「已接管网络」的测试电脑上跑；升级前跑一次、升级后跑一次，两次结果必须一致且全部 PASS，才能换下载区。
# 用法：zsh leak-check.sh [期望的静态 IP]   （不给就只要求所有路径出口一致且在美国）
# 只读：不改任何设置，不登录、不碰 Claude 账号（只请求公开的 cdn-cgi/trace 和一个不带凭据的 HEAD）。
set -u
EXPECT_IP="${1:-}"
fail=0
pass() { print "PASS  $1"; }
bad()  { print "FAIL  $1"; fail=1; }

trace() { # $1 = 方式说明, 其余 = curl 参数
  local how=$1; shift
  local out; out=$(curl -s -m 15 "$@" https://claude.ai/cdn-cgi/trace 2>/dev/null)
  print -- "$out" | awk -F= -v h="$how" '/^ip=/{ip=$2} /^loc=/{loc=$2} END{print h" "ip" "loc}'
}

# 1) 生效代理（以 scutil 为准，不看 networksetup）：开着的话端口必须有人听
http_on=$(scutil --proxy | awk '/HTTPEnable/{print $3}')
port=$(scutil --proxy | awk '/HTTPSPort/{print $3}')
pac=$(scutil --proxy | awk '/ProxyAutoConfigEnable/{print $3}')
[ "$pac" = "1" ] && bad "开着自动代理配置（PAC），浏览器走的路不可控"
if [ "$http_on" = "1" ] && [ -n "$port" ]; then
  if nc -z -w 3 127.0.0.1 "$port" 2>/dev/null; then pass "系统代理 127.0.0.1:$port 有人在听"; else bad "系统代理 127.0.0.1:$port 没人听（浏览器会断网或绕路）"; fi
fi

# 2) 三条路的出口：不走代理（TUN 接管）/ 按系统代理（浏览器同路）/ 环境变量代理清空
a=$(trace direct --noproxy '*')
if [ "$http_on" = "1" ] && [ -n "$port" ]; then b=$(trace sysproxy -x "http://127.0.0.1:$port"); else b=$(trace sysproxy); fi
c=$(env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy -u all_proxy curl -s -m 15 https://claude.ai/cdn-cgi/trace 2>/dev/null | awk -F= '/^ip=/{ip=$2} /^loc=/{loc=$2} END{print "noenv "ip" "loc}')
for line in "$a" "$b" "$c"; do
  print "      $line"
  set -- ${=line}
  [ -z "${2:-}" ] && { bad "$1 拿不到出口（不通也算失败，要查清）"; continue; }
  [ "${3:-}" != "US" ] && bad "$1 出口不在美国：$2 $3"
  [ -n "$EXPECT_IP" ] && [ "$2" != "$EXPECT_IP" ] && bad "$1 出口 $2 不是期望的静态 IP $EXPECT_IP"
done
ips=$(print -l "$a" "$b" "$c" | awk '{print $2}' | sort -u | wc -l | tr -d ' ')
[ "$ips" = "1" ] && pass "三条路出口一致" || bad "三条路出口不一致（有路径绕过了接管）"

# 3) DNS：Claude 相关域名必须被接管层解析（假地址 198.18.0.0/15），不能拿到真实解析结果（说明 DNS 直连）
for d in claude.ai api.anthropic.com statsig.anthropic.com; do
  ip=$(curl -s -m 10 -o /dev/null -w '%{remote_ip}' -I "https://$d/" 2>/dev/null)
  case "$ip" in
    198.18.*|198.19.*) pass "$d 解析走接管层（$ip）" ;;
    "") bad "$d 连不上，无法判断 DNS 走向" ;;
    *) bad "$d 解析到真实地址 $ip（DNS 可能直连泄露）" ;;
  esac
done

# 4) 接管网卡还在
ifconfig | grep -q '^utun' && pass "接管网卡在" || bad "没有 utun 网卡（接管没在跑）"

print
[ $fail = 0 ] && print "RESULT PASS" || print "RESULT FAIL —— 不许发版"
exit $fail
