import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || "127.0.0.1"
const IS_PROD = process.argv.includes("--prod") || process.env.NODE_ENV === "production"
const MAX_BODY_BYTES = 1024 * 1024
const MAX_LOGS = 200
const DEFAULT_MODEL = process.env.FAKE_LLM_MODEL || "fake-llm"
const DEFAULT_REPLY =
  process.env.FAKE_LLM_REPLY || "这是 FakeLLM 的固定回复。"
const STREAM_DELAY_MS = Number(process.env.FAKE_LLM_STREAM_DELAY_MS || 300)

const logs = []

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "*")
  res.setHeader("Access-Control-Max-Age", "86400")
}

function sendJson(res, statusCode, body) {
  setCorsHeaders(res)
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  })
  res.end(JSON.stringify(body))
}

function sendText(res, statusCode, body) {
  setCorsHeaders(res)
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  })
  res.end(body)
}

function sendSseHeaders(res) {
  setCorsHeaders(res)
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  })
}

function writeSseData(res, data) {
  res.write(`data: ${data}\n\n`)
}

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []

    req.on("data", (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"))
    })

    req.on("error", reject)
  })
}

function parseBody(rawBody) {
  if (!rawBody) {
    return { body: null, bodyParseError: null }
  }

  try {
    return { body: JSON.parse(rawBody), bodyParseError: null }
  } catch (error) {
    return {
      body: null,
      bodyParseError: error instanceof Error ? error.message : "Invalid JSON",
    }
  }
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text).length / 4))
}

function getModel(body) {
  if (body && typeof body === "object" && "model" in body) {
    const model = body.model
    if (typeof model === "string" && model.trim()) {
      return model
    }
  }
  return DEFAULT_MODEL
}

function getHeaderValue(headers, name) {
  const value = headers[name.toLowerCase()]
  if (Array.isArray(value)) {
    return value.join(", ")
  }
  return value || ""
}

function getBodyBytes(rawBody) {
  return Buffer.byteLength(rawBody || "", "utf8")
}

function inferClient(req, body) {
  const userAgent = getHeaderValue(req.headers, "user-agent").toLowerCase()
  const title = getHeaderValue(req.headers, "x-title").toLowerCase()

  if (
    req.headers["anthropic-version"] ||
    req.headers["anthropic-beta"] ||
    title.includes("claude") ||
    userAgent.includes("claude")
  ) {
    return "claude"
  }

  if (title.includes("cherry") || userAgent.includes("cherrystudio")) {
    return "cherry-studio"
  }

  if (userAgent.includes("curl")) {
    return "curl"
  }

  if (body && typeof body === "object" && "messages" in body) {
    return "openai-compatible"
  }

  return "unknown"
}

function makeRequestMeta(req, url, rawBody = "", body = null) {
  return {
    requestLine: {
      method: req.method,
      rawUrl: req.url || "",
      httpVersion: req.httpVersion,
    },
    url: {
      path: url.pathname,
      search: url.search,
      query: Object.fromEntries(url.searchParams),
    },
    source: {
      inferredClient: inferClient(req, body),
      directPeerAddress: req.socket.remoteAddress || "",
      directPeerPort: req.socket.remotePort || null,
      directPeerFamily: req.socket.remoteFamily || "",
    },
    body: {
      bodyBytes: getBodyBytes(rawBody),
      bodyChars: rawBody.length,
      parsedJson: body !== null,
      streamRequested: wantsStream(body),
    },
    lifecycle: {
      complete: Boolean(req.complete),
      aborted: Boolean(req.aborted),
    },
  }
}

function isAnthropicRequest(req) {
  return Boolean(
    req.headers["anthropic-version"] ||
      req.headers["anthropic-beta"] ||
      req.headers["x-api-key"] ||
      String(req.headers["user-agent"] || "")
        .toLowerCase()
        .includes("claude")
  )
}

function wantsStream(body) {
  return Boolean(body && typeof body === "object" && body.stream === true)
}

function includesUsage(body) {
  return Boolean(
    body &&
      typeof body === "object" &&
      body.stream_options &&
      typeof body.stream_options === "object" &&
      body.stream_options.include_usage === true
  )
}

function makeChatCompletion(body) {
  const id = `chatcmpl-${randomUUID().replaceAll("-", "")}`
  const model = getModel(body)
  const completionTokens = estimateTokens(DEFAULT_REPLY)

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: DEFAULT_REPLY,
        },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: completionTokens,
      total_tokens: completionTokens,
    },
  }
}

function makeChatCompletionChunk({
  id,
  created,
  model,
  delta,
  finishReason = null,
  usage,
}) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  }
}

function makeResponse(body) {
  const suffix = randomUUID().replaceAll("-", "")
  const model = getModel(body)
  const completionTokens = estimateTokens(DEFAULT_REPLY)
  const createdAt = Math.floor(Date.now() / 1000)

  return {
    id: `resp_${suffix}`,
    object: "response",
    created_at: createdAt,
    completed_at: createdAt,
    status: "completed",
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    max_output_tokens: null,
    model,
    output: [
      {
        id: `msg_${suffix}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: DEFAULT_REPLY,
            annotations: [],
          },
        ],
      },
    ],
    output_text: DEFAULT_REPLY,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    service_tier: "default",
    store: false,
    temperature:
      body && typeof body === "object" && typeof body.temperature === "number"
        ? body.temperature
        : 1,
    text: {
      format: {
        type: "text",
      },
    },
    tool_choice: "auto",
    tools: [],
    top_p:
      body && typeof body === "object" && typeof body.top_p === "number"
        ? body.top_p
        : 1,
    truncation: "disabled",
    usage: {
      input_tokens: 0,
      output_tokens: completionTokens,
      total_tokens: completionTokens,
    },
  }
}

function makeClaudeMessage(body) {
  const model = getModel(body)
  const outputTokens = estimateTokens(DEFAULT_REPLY)

  return {
    id: `msg_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model,
    content: [
      {
        type: "text",
        text: DEFAULT_REPLY,
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: estimateClaudeInputTokens(body),
      output_tokens: outputTokens,
    },
  }
}

function estimateClaudeInputTokens(body) {
  if (!body || typeof body !== "object") {
    return 0
  }

  const parts = []
  if ("system" in body) {
    parts.push(body.system)
  }
  if ("messages" in body) {
    parts.push(body.messages)
  }
  if ("tools" in body) {
    parts.push(body.tools)
  }

  return estimateTokens(JSON.stringify(parts))
}

async function streamChatCompletion(res, body, completion) {
  sendSseHeaders(res)

  const base = {
    id: completion.id,
    created: completion.created,
    model: completion.model,
  }

  writeSseData(
    res,
    JSON.stringify(
      makeChatCompletionChunk({
        ...base,
        delta: { role: "assistant" },
      })
    )
  )
  for (const char of Array.from(DEFAULT_REPLY)) {
    await sleep(STREAM_DELAY_MS)
    writeSseData(
      res,
      JSON.stringify(
        makeChatCompletionChunk({
          ...base,
          delta: { content: char },
        })
      )
    )
  }

  await sleep(STREAM_DELAY_MS)
  writeSseData(
    res,
    JSON.stringify(
      makeChatCompletionChunk({
        ...base,
        delta: {},
        finishReason: "stop",
      })
    )
  )

  if (includesUsage(body)) {
    writeSseData(
      res,
      JSON.stringify({
        id: completion.id,
        object: "chat.completion.chunk",
        created: completion.created,
        model: completion.model,
        choices: [],
        usage: completion.usage,
      })
    )
  }

  writeSseData(res, "[DONE]")
  res.end()
}

async function streamResponse(res, responseBody) {
  sendSseHeaders(res)

  let sequenceNumber = 0
  const outputItem = responseBody.output[0]
  const contentPart = outputItem.content[0]
  const inProgressResponse = {
    ...responseBody,
    completed_at: null,
    status: "in_progress",
    output: [],
    output_text: "",
  }
  const inProgressOutputItem = {
    ...outputItem,
    status: "in_progress",
    content: [],
  }
  const emptyContentPart = {
    ...contentPart,
    text: "",
  }

  writeSseEvent(res, "response.created", {
    type: "response.created",
    sequence_number: sequenceNumber++,
    response: inProgressResponse,
  })
  writeSseEvent(res, "response.in_progress", {
    type: "response.in_progress",
    sequence_number: sequenceNumber++,
    response: inProgressResponse,
  })
  writeSseEvent(res, "response.output_item.added", {
    type: "response.output_item.added",
    sequence_number: sequenceNumber++,
    output_index: 0,
    item: inProgressOutputItem,
  })
  writeSseEvent(res, "response.content_part.added", {
    type: "response.content_part.added",
    sequence_number: sequenceNumber++,
    item_id: outputItem.id,
    output_index: 0,
    content_index: 0,
    part: emptyContentPart,
  })

  for (const char of Array.from(DEFAULT_REPLY)) {
    await sleep(STREAM_DELAY_MS)
    writeSseEvent(res, "response.output_text.delta", {
      type: "response.output_text.delta",
      sequence_number: sequenceNumber++,
      item_id: outputItem.id,
      output_index: 0,
      content_index: 0,
      delta: char,
    })
  }

  await sleep(STREAM_DELAY_MS)
  writeSseEvent(res, "response.output_text.done", {
    type: "response.output_text.done",
    sequence_number: sequenceNumber++,
    item_id: outputItem.id,
    output_index: 0,
    content_index: 0,
    text: DEFAULT_REPLY,
  })
  writeSseEvent(res, "response.content_part.done", {
    type: "response.content_part.done",
    sequence_number: sequenceNumber++,
    item_id: outputItem.id,
    output_index: 0,
    content_index: 0,
    part: contentPart,
  })
  writeSseEvent(res, "response.output_item.done", {
    type: "response.output_item.done",
    sequence_number: sequenceNumber++,
    output_index: 0,
    item: outputItem,
  })
  writeSseEvent(res, "response.completed", {
    type: "response.completed",
    sequence_number: sequenceNumber++,
    response: responseBody,
  })

  res.end()
}

async function streamClaudeMessage(res, message) {
  sendSseHeaders(res)

  writeSseEvent(res, "message_start", {
    type: "message_start",
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: {
        ...message.usage,
        output_tokens: 0,
      },
    },
  })

  writeSseEvent(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "text",
      text: "",
    },
  })

  for (const char of Array.from(DEFAULT_REPLY)) {
    await sleep(STREAM_DELAY_MS)
    writeSseEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: char,
      },
    })
  }

  await sleep(STREAM_DELAY_MS)
  writeSseEvent(res, "content_block_stop", {
    type: "content_block_stop",
    index: 0,
  })
  writeSseEvent(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: "end_turn",
      stop_sequence: null,
    },
    usage: {
      output_tokens: message.usage.output_tokens,
    },
  })
  writeSseEvent(res, "message_stop", {
    type: "message_stop",
  })

  res.end()
}

function makeModels() {
  return {
    object: "list",
    data: [
      {
        id: DEFAULT_MODEL,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "fake-llm",
      },
    ],
  }
}

function makeClaudeModels() {
  const createdAt = new Date(0).toISOString()

  return {
    data: [
      {
        type: "model",
        id: DEFAULT_MODEL,
        display_name: DEFAULT_MODEL,
        created_at: createdAt,
      },
      {
        type: "model",
        id: "claude-sonnet-4-5",
        display_name: "Claude Sonnet 4.5",
        created_at: createdAt,
      },
    ],
    has_more: false,
    first_id: DEFAULT_MODEL,
    last_id: "claude-sonnet-4-5",
  }
}

function getRequestType(pathname) {
  if (pathname === "/v1/messages") {
    return "claude"
  }
  if (pathname === "/v1/messages/count_tokens") {
    return "claude-tokens"
  }
  if (pathname === "/v1/chat/completions") {
    return "compatible"
  }
  if (pathname === "/v1/responses") {
    return "responses"
  }
  if (pathname === "/v1/models") {
    return "models"
  }
  return "unknown"
}

function makePreview(value, rawBody) {
  const source =
    value === null || value === undefined ? rawBody : JSON.stringify(value)
  return source.length > 160 ? `${source.slice(0, 160)}...` : source
}

function addLog(entry) {
  logs.unshift(entry)
  if (logs.length > MAX_LOGS) {
    logs.length = MAX_LOGS
  }
}

function summarizeLog(entry) {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    type: entry.type,
    method: entry.method,
    path: entry.path,
    statusCode: entry.statusCode,
    model: entry.model,
    durationMs: entry.durationMs,
    bodyPreview: entry.bodyPreview,
  }
}

function notFound(res) {
  sendJson(res, 404, { error: { message: "Not found", type: "not_found" } })
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    setCorsHeaders(res)
    res.writeHead(204)
    res.end()
    return true
  }

  if (url.pathname === "/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true })
    return true
  }

  if (url.pathname === "/api/requests" && req.method === "GET") {
    sendJson(res, 200, logs.map(summarizeLog))
    return true
  }

  if (url.pathname === "/api/requests" && req.method === "DELETE") {
    logs.length = 0
    sendJson(res, 200, { ok: true })
    return true
  }

  if (url.pathname.startsWith("/api/requests/") && req.method === "GET") {
    const id = decodeURIComponent(url.pathname.replace("/api/requests/", ""))
    const entry = logs.find((item) => item.id === id)
    if (!entry) {
      notFound(res)
      return true
    }
    sendJson(res, 200, entry)
    return true
  }

  if (url.pathname === "/v1/models" && req.method === "GET") {
    const startedAt = performance.now()
    const responseBody = isAnthropicRequest(req) ? makeClaudeModels() : makeModels()
    const entry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: getRequestType(url.pathname),
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      rawBody: "",
      body: null,
      bodyParseError: null,
      meta: makeRequestMeta(req, url),
      model: DEFAULT_MODEL,
      statusCode: 200,
      durationMs: Math.round(performance.now() - startedAt),
      bodyPreview: "",
      response: {
        statusCode: 200,
        body: responseBody,
      },
    }
    addLog(entry)
    sendJson(res, 200, responseBody)
    return true
  }

  if (url.pathname === "/v1/messages/count_tokens" && req.method === "POST") {
    const startedAt = performance.now()
    let rawBody = ""

    try {
      rawBody = await readRequestBody(req)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to read request body"
      sendJson(res, 413, {
        type: "error",
        error: { type: "invalid_request_error", message },
      })
      return true
    }

    const { body, bodyParseError } = parseBody(rawBody)
    const responseBody = {
      input_tokens: estimateClaudeInputTokens(body),
    }
    const model = getModel(body)
    const entry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: getRequestType(url.pathname),
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      rawBody,
      body,
      bodyParseError,
      meta: makeRequestMeta(req, url, rawBody, body),
      model,
      statusCode: 200,
      durationMs: Math.round(performance.now() - startedAt),
      bodyPreview: makePreview(body, rawBody),
      response: {
        statusCode: 200,
        body: responseBody,
      },
    }
    addLog(entry)
    sendJson(res, 200, responseBody)
    return true
  }

  if (url.pathname === "/v1/messages" && req.method === "POST") {
    const startedAt = performance.now()
    let rawBody = ""

    try {
      rawBody = await readRequestBody(req)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to read request body"
      sendJson(res, 413, {
        type: "error",
        error: { type: "invalid_request_error", message },
      })
      return true
    }

    const { body, bodyParseError } = parseBody(rawBody)
    const responseBody = makeClaudeMessage(body)
    const model = getModel(body)
    const entry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: getRequestType(url.pathname),
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      rawBody,
      body,
      bodyParseError,
      meta: makeRequestMeta(req, url, rawBody, body),
      model,
      statusCode: 200,
      durationMs: Math.round(performance.now() - startedAt),
      bodyPreview: makePreview(body, rawBody),
      response: {
        statusCode: 200,
        body: responseBody,
        streamed: wantsStream(body),
      },
    }

    addLog(entry)

    if (wantsStream(body)) {
      await streamClaudeMessage(res, responseBody)
      entry.durationMs = Math.round(performance.now() - startedAt)
      return true
    }

    sendJson(res, 200, responseBody)
    return true
  }

  if (
    (url.pathname === "/v1/chat/completions" ||
      url.pathname === "/v1/responses") &&
    req.method === "POST"
  ) {
    const startedAt = performance.now()
    let rawBody = ""

    try {
      rawBody = await readRequestBody(req)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to read request body"
      sendJson(res, 413, { error: { message, type: "invalid_request_error" } })
      return true
    }

    const { body, bodyParseError } = parseBody(rawBody)
    const responseBody =
      url.pathname === "/v1/responses"
        ? makeResponse(body)
        : makeChatCompletion(body)
    const model = getModel(body)
    const entry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: getRequestType(url.pathname),
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      rawBody,
      body,
      bodyParseError,
      meta: makeRequestMeta(req, url, rawBody, body),
      model,
      statusCode: 200,
      durationMs: Math.round(performance.now() - startedAt),
      bodyPreview: makePreview(body, rawBody),
      response: {
        statusCode: 200,
        body: responseBody,
        streamed: wantsStream(body),
      },
    }

    addLog(entry)

    if (wantsStream(body)) {
      if (url.pathname === "/v1/responses") {
        await streamResponse(res, responseBody)
        entry.durationMs = Math.round(performance.now() - startedAt)
        return true
      }

      await streamChatCompletion(res, body, responseBody)
      entry.durationMs = Math.round(performance.now() - startedAt)
      return true
    }

    sendJson(res, 200, responseBody)
    return true
  }

  if (url.pathname.startsWith("/v1/")) {
    notFound(res)
    return true
  }

  return false
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
  }
  return types[ext] || "application/octet-stream"
}

async function serveStatic(req, res, url) {
  const distDir = path.join(__dirname, "dist")
  const requestedPath = decodeURIComponent(url.pathname)
  const relativePath = requestedPath === "/" ? "/index.html" : requestedPath
  const filePath = path.normalize(path.join(distDir, relativePath))

  if (!filePath.startsWith(distDir)) {
    sendText(res, 403, "Forbidden")
    return
  }

  let finalPath = filePath
  try {
    const fileStat = await stat(finalPath)
    if (fileStat.isDirectory()) {
      finalPath = path.join(finalPath, "index.html")
    }
  } catch {
    finalPath = path.join(distDir, "index.html")
  }

  if (!existsSync(finalPath)) {
    sendText(res, 404, "Run pnpm build before starting with --prod.")
    return
  }

  res.writeHead(200, {
    "Content-Type": getContentType(finalPath),
    "Cache-Control": finalPath.endsWith("index.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
  })
  createReadStream(finalPath).pipe(res)
}

async function createRequestHandler() {
  if (IS_PROD) {
    return async (req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
      if (await handleApi(req, res, url)) {
        return
      }
      await serveStatic(req, res, url)
    }
  }

  const { createServer: createViteServer } = await import("vite")
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  })

  return async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
    if (await handleApi(req, res, url)) {
      return
    }

    vite.middlewares(req, res, (error) => {
      if (error) {
        vite.ssrFixStacktrace(error)
        sendText(res, 500, error.stack || error.message)
        return
      }
      notFound(res)
    })
  }
}

const requestHandler = await createRequestHandler()
const server = createServer((req, res) => {
  requestHandler(req, res).catch((error) => {
    console.error(error)
    sendJson(res, 500, {
      error: {
        message: "Internal server error",
        type: "server_error",
      },
    })
  })
})

server.listen(PORT, HOST, () => {
  const mode = IS_PROD ? "production" : "development"
  console.log(`FakeLLM (${mode}) listening on http://${HOST}:${PORT}`)
})
