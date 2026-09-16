# infrlo-vless

VLESS over WebSocket，部署到 [Infrlo](https://infrlo.com) 免费套餐。

## 部署

1. Fork 本仓库
2. [Infrlo Dashboard](https://dash.infrlo.com/) → Create App → 填入仓库 URL
3. Runtime 配置：
   - Build: `npm install`
   - Run: `node index.js`
4. 部署

## 环境变量（可选）

| 变量 | 说明 |
|------|------|
| `UUID` | VLESS 节点 UUID，逗号分隔最多 5 个。不足 5 个时基于第一个 UUID 稳定派生补足 |
| `SUB_TOKEN` | 订阅接口访问密码，不设则公开 |
| `TRAFFIC_TOTAL_GB` | Clash 显示的套餐总流量，默认 `60` GB |
| `TRAFFIC_EXPIRE` | 套餐到期 Unix 时间戳（秒），默认 `0` |

示例：
```
UUID = b3a1c9d2-e4f5-4a6b-8c7d-9e0f1a2b3c4d,e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8a9b
SUB_TOKEN = mypassword
```

## 使用

| 地址 | 用途 |
|------|------|
| `https://域名/` | Clash 主页面、VLESS 全部节点订阅与二维码 |
| `https://域名/sub?format=clash` | Clash Meta 订阅 |
| `https://域名/sub` | V2Ray 订阅（Base64） |
| `https://域名/api/stats` | 按节点统计的实时流量 JSON 接口 |

首页每 5 秒刷新一次流量统计，包含上传、下载、当前连接和累计连接。
统计数据只保存在当前进程内存中，服务重启或部署后从零开始累计。
订阅响应会附带 `Subscription-Userinfo`，Clash / Mihomo 可直接显示已用流量。该数值同样从本次进程启动开始累计；套餐总量默认按 60 GB 展示，可通过环境变量调整。
转发连接启用 16 MB 单消息上限和双向背压，在保留正常大包兼容性的同时避免慢连接持续占用内存。统计仅在内存中维护固定数量的节点计数器，不引入数据库或后台服务。

节点名称会自动带上当前部署服务器的地区，例如 `infrlo-vless1 · 中国`。
节点路径为 `/vless1` ~ `/vless5`，其中 `/vless` 始终兼容映射到节点 1。

## 实测记录

包含 IP 风控检测、订阅页面和速度测试截图，详见 [实测结果](docs/test-results.md)。
