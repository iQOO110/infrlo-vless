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
| `SUB_TOKEN` | 面板与订阅接口访问密码，不设则公开 |

示例：
```
UUID = b3a1c9d2-e4f5-4a6b-8c7d-9e0f1a2b3c4d,e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8a9b
SUB_TOKEN = mypassword
```

## 使用

| 地址 | 用途 |
|------|------|
| `https://域名/` | Clash 主页面、订阅导入与节点列表 |
| `https://域名/panel` | 管理面板（二维码、一键导入 Clash） |
| `https://域名/sub?format=clash` | Clash Meta 订阅 |
| `https://域名/sub` | V2Ray 订阅（Base64） |

节点名称会自动带上当前部署服务器的地区，例如 `infrlo-vless1 · 中国`。
节点路径为 `/vless1` ~ `/vless5`，其中 `/vless` 始终兼容映射到节点 1。
