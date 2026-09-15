# infrlo-vless

VLESS over WebSocket，专为 infrlo.com 等 PaaS 平台设计。支持多节点、Clash 订阅。

## 环境变量

| 变量名 | 必须 | 默认值 | 说明 |
|--------|------|--------|------|
| `UUID` | 否 | 随机生成 | VLESS 用户 UUID，逗号分隔最多 5 个（如 `uuid1,uuid2,uuid3`） |
| `SUB_TOKEN` | 否 | 无 | 订阅接口访问令牌，不设则公开访问 |
| `PORT` | 否 | `5000` | HTTP 监听端口（Infrlo 无需手动设置） |

## 多节点

设置逗号分隔的 UUID 即可生成多个节点：

```
UUID = aaa-bbb,ccc-ddd,eee-fff
```

路径自动分配为 `/vless1`、`/vless2`、`/vless3`。单个 UUID 则使用 `/vless`。

## 订阅接口

| 端点 | 说明 |
|------|------|
| `https://域名/sub` | Base64 编码的 VLESS 链接列表（V2Ray 格式） |
| `https://域名/sub?format=clash` | Clash Meta YAML 配置 |
| `https://域名/sub?token=你的TOKEN` | 带令牌访问（需设 SUB_TOKEN） |
| `https://域名/health` | 健康检查 |

## 本地测试

```bash
cd infrlo-vless
npm install
UUID=test1,test2 npm start
```

## 部署到 infrlo.com

1. Fork 本仓库
2. 登录 https://dash.infrlo.com/ → Create App → 连接仓库
3. Runtime: `npm install` → `node index.js`
4. 设置环境变量（推荐）：
   ```
   UUID = uuid1,uuid2,uuid3,uuid4,uuid5
   ```
5. 部署完成，访问 `https://你的域名/sub`

## 客户端配置示例（单节点）

| 参数 | 值 |
|------|-----|
| 地址 | 你的 infrlo.com 域名 |
| 端口 | 443 |
| 用户 ID | 你设置的 UUID |
| 传输协议 | ws |
| 路径 | `/vless` |
| 传输安全 | tls |
| SNI | 你的 infrlo.com 域名 |

## 注意事项

- Infrlo 免费套餐：512MB RAM / 2GB 存储，代理够用
- WebSocket 连接可能被负载均衡器超时断开
- 仅支持 TCP（VLESS+WS），不支持 UDP
- 仅供学习研究使用