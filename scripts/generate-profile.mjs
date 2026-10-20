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
  - name: CF-VLESS
    type: vless
    server: ${domain}
    port: 443
    uuid: ${uuid}
    udp: false
    tls: true
    servername: ${domain}
    client-fingerprint: chrome
    network: ws
    ws-opts:
      path: /${uuid}
      headers:
        Host: ${domain}

proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - CF-VLESS
      - DIRECT

rules:
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
