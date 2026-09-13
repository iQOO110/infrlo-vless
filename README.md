# infrlo-vless

VLESS over WebSocket，专为 infrlo.com 等 PaaS 平台设计。

## 环境变量

| 变量名 | 必须 | 默认值 | 说明 |
|--------|------|--------|------|
| `PORT` | 否 | `3000` | HTTP 服务监听端口（PaaS 平台自动注入） |
| `UUID` | 否 | 随机生成 | VLESS 用户 UUID |
| `WS_PATH` | 否 | `/vless` | WebSocket 路径 |

## 本地测试

```bash
cd infrlo-vless
npm install
npm start
```

访问 `http://localhost:3000/health` 返回 `OK` 即正常。

## 部署到 infrlo.com

### 1. 注册 infrlo.com

访问 https://dash.infrlo.com/ 注册账号（免费，无需信用卡）。

### 2. 创建 Git 仓库

```bash
cd infrlo-vless
git init
git add .
git commit -m "VLESS+WS server for infrlo.com"
```

将代码推送到 GitHub / GitLab 仓库（公开或私有均可）。

### 3. 在 infrlo.com 部署

1. 登录 infrlo.com Dashboard
2. 创建新项目，连接你的 Git 仓库
3. 平台会自动检测 Node.js 框架
4. 设置环境变量（可选）：
   - `UUID` = 你的自定义 UUID（可用 `uuidgen` 或在线工具生成）
   - `WS_PATH` = 自定义 WebSocket 路径
5. 点击部署，等待构建完成

### 4. 获取节点配置

部署成功后，访问：

```
https://你的域名/sub
```

返回 Base64 编码的订阅链接，直接导入客户端即可。

## 客户端手动配置

| 参数 | 值 |
|------|-----|
| 地址 | 你的 infrlo.com 域名 |
| 端口 | 443 |
| 用户 ID | 你设置的 UUID |
| 传输协议 | ws (WebSocket) |
| 路径 | `/vless`（或你设置的 WS_PATH） |
| 传输安全 | tls |
| SNI | 你的 infrlo.com 域名 |

## 注意事项

- infrlo.com 免费套餐可能有流量、内存或连接时长限制
- WebSocket 连接可能被平台负载均衡器超时断开
- 本方案仅支持 TCP 代理（VLESS+WS），不支持 UDP
- 仅供个人学习和研究使用
