# Cloudflare Workers 代理 + Clash Verge

这是一个私有的 Cloudflare Workers 代理。Clash Verge 通过 **VLESS over WebSocket（TLS 443）** 连上它之后，国内网站直连，其余网站（包括谷歌）走代理。

WebSocket 路径就是 `/{UUID}`。UUID 相当于密码，只放在 Cloudflare Secret 和本机生成的 Clash 配置里。

## 准备

- Node.js 20 或更新版本
- 一个 Cloudflare 账号
- Clash Verge（mihomo 内核）
- 可选：已经托管在 Cloudflare 上的域名。没有域名时使用 `workers.dev`

Workers 免费套餐大约每天 10 万次请求，日常浏览够用。长时间连接更稳妥的是 Workers 付费套餐，因为免费套餐的单次 CPU 时间很短。

## 部署

```bash
cd worker
npm install
npx wrangler login
node -e "console.log(crypto.randomUUID())"
npx wrangler secret put UUID
```

`wrangler secret put UUID` 时粘贴上一步打印的 UUID。

自定义域名是 `vpn.lm191549149.me`，已经写在 [worker/wrangler.toml](worker/wrangler.toml) 里。域名在 Cloudflare 上由 Worker 路由接管，证书自动签发。`workers.dev` 地址仍然可用。

```bash
npx wrangler deploy
```

记下部署输出里的主机名，例如 `cf-clash-vpn.<账号>.workers.dev` 或你的自定义域名。

## 生成 Clash Verge 配置

在仓库根目录执行，`--domain` 和 `--uuid` 与上面部署时使用的值相同：

```bash
node scripts/generate-profile.mjs --domain <域名> --uuid <UUID>
```

脚本写出 `clash/clash-verge.yaml`。这个文件含有 UUID，已经被 git 忽略。

配置内容：

- 同一节点会生成 443、8443、2053、2083、2087、2096 以及几个 Cloudflare 入口地址。`PROXY` 会自动选用能连上的那个。默认的 443 地址在部分网络上会超时
- `mode: rule`，并下载 mihomo 的 geoip / geosite
- DNS 使用 fake-ip。国内解析用 `223.5.5.5` 和 `119.29.29.29`。境外 fallback 使用 `1.1.1.1` 和 `8.8.8.8` 的 DoT，并经由 `PROXY` 发出
- 私有地址、`GEOSITE,cn`、`GEOIP,CN` 直连，其余走代理

## 导入 Clash Verge

1. 打开 Clash Verge，进入「配置」
2. 新建本地配置，选择 `clash/clash-verge.yaml`
3. 把这份配置设为当前配置
4. 打开系统代理
5. 浏览器访问 <https://www.google.com>

第一次启用时，Clash Verge 会按配置里的地址下载 geoip 和 geosite。下载完成后再访问境外网站。

## 限制

- Workers 免费额度大约每天 10 万次请求。日常浏览够用，大量视频会超限。
- 部分网站会屏蔽 Cloudflare 出口 IP。谷歌一般可以打开。
- 节点必须保密。UUID 泄漏后，别人可以使用你的 Worker 额度。

## 本地检查

```bash
cd worker
npm test
npm run typecheck
```
