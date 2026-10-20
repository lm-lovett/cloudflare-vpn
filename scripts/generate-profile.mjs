import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function usage() {
  console.error(
    "usage: node scripts/generate-profile.mjs --domain <host> --uuid <uuid>",
  );
  process.exit(2);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

const domain = argument("--domain");
const uuidArgument = argument("--uuid");
if (!domain || !uuidArgument) usage();

if (
  !/^[a-z0-9.-]+$/i.test(domain) ||
  domain.includes("..") ||
  domain.startsWith(".") ||
  domain.endsWith(".") ||
  !domain.includes(".")
) {
  console.error("invalid domain");
  process.exit(2);
}

const uuid = uuidArgument.trim().toLowerCase();
if (!UUID_RE.test(uuid)) {
  console.error("invalid uuid");
  process.exit(2);
}

const ports = [8443, 2053, 2083, 2087, 2096, 443];
// These anycast addresses reach this hostname on 8443. They give Clash another
// path when the address returned by DNS times out.
const edgeAddresses = [
  "104.16.0.1",
  "104.16.160.1",
  "104.17.128.1",
  "104.18.32.1",
  "104.19.192.1",
  "104.20.0.1",
  "104.21.64.1",
  "104.24.0.1",
  "104.26.0.1",
  "162.159.128.1",
  "172.64.148.78",
  "172.66.0.1",
  "172.67.74.102",
  "188.114.96.1",
];

function proxyBlock(name, server, port) {
  return `  - name: ${name}
    type: vless
    server: ${server}
    port: ${port}
    uuid: ${uuid}
    udp: false
    tls: true
    servername: ${domain}
    client-fingerprint: chrome
    network: ws
    ip-version: ipv4
    ws-opts:
      path: /${uuid}?ed=2048
      max-early-data: 2048
      early-data-header-name: Sec-WebSocket-Protocol
      headers:
        Host: ${domain}`;
}

const proxies = [
  ...ports.map((port) => proxyBlock(`CF-${port}`, domain, port)),
  ...edgeAddresses.map((address) =>
    proxyBlock(`CF-${address}`, address, 8443),
  ),
];
const proxyNames = [
  ...ports.map((port) => `CF-${port}`),
  ...edgeAddresses.map((address) => `CF-${address}`),
];

const yaml = `mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
ipv6: false
geodata-mode: true
geox-url:
  geoip: https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat
  geosite: https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat
  mmdb: https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb

dns:
  enable: true
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  fake-ip-filter:
    - "*.lan"
    - "*.local"
    - "+.msftconnecttest.com"
    - "+.msftncsi.com"
    - "${domain}"
    - "+.${domain}"
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
  proxy-server-nameserver:
    - 223.5.5.5
    - 119.29.29.29
  nameserver:
    - 223.5.5.5
    - 119.29.29.29
  fallback:
    - "tls://1.1.1.1#PROXY"
    - "tls://8.8.8.8#PROXY"
  fallback-filter:
    geoip: true
    geoip-code: CN

proxies:
${proxies.join("\n")}

proxy-groups:
  - name: PROXY
    type: url-test
    proxies:
${proxyNames.map((name) => `      - ${name}`).join("\n")}
    url: http://www.gstatic.com/generate_204
    interval: 300
    timeout: 5
    tolerance: 20
    lazy: false

rules:
  - DOMAIN,${domain},DIRECT
  - DOMAIN-SUFFIX,google.com,PROXY
  - DOMAIN-SUFFIX,googleapis.com,PROXY
  - DOMAIN-SUFFIX,gstatic.com,PROXY
  - DOMAIN-SUFFIX,googleusercontent.com,PROXY
  - DOMAIN-SUFFIX,ggpht.com,PROXY
  - DOMAIN-KEYWORD,google,PROXY
  - GEOIP,private,DIRECT,no-resolve
  - GEOSITE,cn,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,PROXY
`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "clash", "clash-verge.yaml");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, yaml, "utf8");
console.log(output);
