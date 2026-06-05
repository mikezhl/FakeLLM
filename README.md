# FakeLLM

小型假 OpenAI / Anthropic 接口服务，固定返回预设内容，并在前端查看收到的请求。用于查看请求内容信息，了解agents运行原理。

## 运行

```powershell
pnpm install
pnpm dev
```

默认地址：`http://127.0.0.1:8787`

## 接口

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `GET /api/requests`
- `DELETE /api/requests`

`/v1/chat/completions`、`/v1/responses` 和 `/v1/messages` 都支持 `stream: true`。