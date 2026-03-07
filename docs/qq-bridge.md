# QQ Bridge

`QQ bridge` 把 `NanoClaw` 变成一个只关心消息编排和 Agent 执行的核心进程，你自己的 QQ 接入层只需要做两件事：

1. 把归一化后的入站消息 `POST` 到 `http://127.0.0.1:8787/qq-bridge/inbound`
2. 提供一个接收 `NanoClaw` 出站消息的 HTTP 端点，并配置到 `QQ_BRIDGE_OUTBOUND_URL`

## 设计目标

- QQ 登录、保活、风控和发包节奏都留在你自己的连接器中
- `NanoClaw` 只负责会话记忆、工具调用、任务调度和容器隔离
- 群聊默认不自动注册，避免机器人无意中接管陌生群
- 所有出站消息走单独的队列、抖动和失败退避

## 入站接口

`POST /qq-bridge/inbound`

请求头：

- `Content-Type: application/json`
- `X-QQ-Bridge-Secret: <QQ_BRIDGE_SHARED_SECRET>`（如果配置了密钥）

请求体：

```json
{
  "eventId": "evt-123",
  "chat": {
    "id": "987654321",
    "type": "group",
    "name": "测试群"
  },
  "sender": {
    "id": "12345678",
    "name": "Alice"
  },
  "message": {
    "id": "msg-001",
    "text": "/ai 帮我总结今天的日志",
    "mentionsSelf": false,
    "isFromMe": false,
    "attachments": [
      {
        "type": "image",
        "name": "error.png",
        "url": "https://example.com/error.png"
      }
    ]
  },
  "timestamp": "2026-03-07T12:00:00.000Z"
}
```

行为：

- 私聊默认自动注册到 `qq:private:<chatId>`，并设置 `requiresTrigger=false`
- 群聊默认不自动注册；如果消息来自未注册群，则只记录 chat metadata，不进入 Agent 流程
- 群聊如果 `mentionsSelf=true`，或者命中了 `QQ_BRIDGE_COMMAND_PREFIXES`，会自动转换成 `@<ASSISTANT_NAME>` 触发词

## 注册接口

`POST /qq-bridge/chats/register`

```json
{
  "chat": {
    "id": "987654321",
    "type": "group",
    "name": "测试群"
  },
  "requiresTrigger": true
}
```

默认会创建：

- `groups/qq_group_987654321/`
- `groups/qq_group_987654321/CLAUDE.md`

## 出站接口

`QQ bridge` 会把 `NanoClaw` 的回复 `POST` 到 `QQ_BRIDGE_OUTBOUND_URL`：

```json
{
  "source": "nanoclaw",
  "deliveryId": "uuid",
  "event": "message",
  "chat": {
    "id": "987654321",
    "type": "group"
  },
  "message": {
    "text": "这是 NanoClaw 的回复"
  },
  "attempt": 1,
  "timestamp": "2026-03-07T12:00:05.000Z"
}
```

连接器返回任意 `2xx` 即视为成功；`429`、`5xx` 等可重试状态会自动退避重试。

## 推荐默认值

```env
QQ_BRIDGE_ENABLED=true
QQ_BRIDGE_HOST=127.0.0.1
QQ_BRIDGE_PORT=8787
QQ_BRIDGE_OUTBOUND_URL=http://127.0.0.1:3001/send
QQ_BRIDGE_SHARED_SECRET=change-me
QQ_BRIDGE_COMMAND_PREFIXES=/ai,#ai
QQ_BRIDGE_AUTO_REGISTER_PRIVATE=true
QQ_BRIDGE_AUTO_REGISTER_GROUPS=false
QQ_BRIDGE_STORE_UNREGISTERED_GROUP_MESSAGES=false
QQ_BRIDGE_MIN_SEND_DELAY_MS=1200
QQ_BRIDGE_SEND_JITTER_MS=400
QQ_BRIDGE_MAX_RETRIES=3
QQ_BRIDGE_BASE_BACKOFF_MS=2000
```
