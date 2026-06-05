import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  FileJson,
  Loader2,
  RefreshCw,
  Search,
  Server,
  Trash2,
} from "lucide-react"
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type RequestType =
  | "compatible"
  | "responses"
  | "claude"
  | "claude-tokens"
  | "models"
  | "unknown"

type RequestSummary = {
  id: string
  timestamp: string
  type: RequestType
  method: string
  path: string
  statusCode: number
  model: string
  durationMs: number
  bodyPreview: string
}

type RequestDetail = RequestSummary & {
  query: Record<string, string>
  headers: Record<string, string | string[] | undefined>
  rawBody: string
  body: unknown
  bodyParseError: string | null
  meta?: unknown
  response: {
    statusCode: number
    body: unknown
  }
}

const requestTypeLabel: Record<RequestType, string> = {
  compatible: "兼容",
  responses: "Responses",
  claude: "Claude",
  "claude-tokens": "Tokens",
  models: "Models",
  unknown: "未知",
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value))
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value))
}

function formatJson(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return ""
  }
  return JSON.stringify(value, null, 2)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getNodeSummary(value: unknown) {
  if (Array.isArray(value)) {
    return `Array(${value.length})`
  }
  if (isRecord(value)) {
    return `Object(${Object.keys(value).length})`
  }
  if (value === null) {
    return "null"
  }
  return typeof value
}

function isExpandable(value: unknown) {
  return Array.isArray(value) || isRecord(value)
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "请求失败"
}

async function fetchRequestSummaries() {
  const response = await fetch("/api/requests")
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  return (await response.json()) as RequestSummary[]
}

function getNextSelectedId(
  current: string | null,
  nextRequests: RequestSummary[]
) {
  if (current && nextRequests.some((item) => item.id === current)) {
    return current
  }
  return nextRequests[0]?.id ?? null
}

function IconButton({
  label,
  onClick,
  children,
  variant = "outline",
  disabled,
  className,
}: {
  label: string
  onClick: () => void
  children: ReactNode
  variant?: ComponentProps<typeof Button>["variant"]
  disabled?: boolean
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          className={className}
          disabled={disabled}
          onClick={onClick}
          size="icon"
          type="button"
          variant={variant}
        >
          {children}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function RawTextBlock({ text }: { text: string }) {
  return (
    <pre className="min-h-40 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-3 font-mono text-xs leading-5 text-foreground">
      {text || "空"}
    </pre>
  )
}

function PrimitiveValue({ value }: { value: unknown }) {
  if (value === null) {
    return <span className="text-muted-foreground">null</span>
  }

  if (typeof value === "string") {
    const isLong = value.length > 96 || value.includes("\n")

    if (isLong) {
      return (
        <pre className="mt-1 max-w-full whitespace-pre-wrap break-words rounded-md border bg-background p-2 font-mono text-xs leading-5 text-foreground">
          {value}
        </pre>
      )
    }

    return <span className="text-emerald-700 dark:text-emerald-400">"{value}"</span>
  }

  if (typeof value === "number") {
    return <span className="text-blue-700 dark:text-blue-400">{value}</span>
  }

  if (typeof value === "boolean") {
    return (
      <span className="text-violet-700 dark:text-violet-400">
        {String(value)}
      </span>
    )
  }

  return <span className="text-muted-foreground">{String(value)}</span>
}

function JsonKey({ name }: { name?: string }) {
  if (name === undefined) {
    return null
  }

  return (
    <span className="mr-1 shrink-0 break-all text-muted-foreground">
      {name}
      <span className="text-border">:</span>
    </span>
  )
}

function JsonTreeLine({
  children,
  depth,
  interactive = false,
  onClick,
}: {
  children: ReactNode
  depth: number
  interactive?: boolean
  onClick?: () => void
}) {
  const className =
    "flex min-w-0 items-start gap-1.5 rounded-sm px-1 py-0.5 text-left"
  const style = {
    paddingLeft: `calc(${depth} * 1rem + 0.25rem)`,
  }

  if (interactive) {
    return (
      <button
        className={cn(className, "w-full hover:bg-muted")}
        onClick={onClick}
        style={style}
        type="button"
      >
        {children}
      </button>
    )
  }

  return (
    <div className={className} style={style}>
      {children}
    </div>
  )
}

type JsonTreeNodeProps = {
  name?: string
  value: unknown
  path: string
  depth: number
  expandedPaths: Set<string>
  collapsedPaths: Set<string>
  onToggle: (path: string, collapsed: boolean, depth: number) => void
}

function JsonTreeNode({
  name,
  value,
  path,
  depth,
  expandedPaths,
  collapsedPaths,
  onToggle,
}: JsonTreeNodeProps) {
  const expandable = isExpandable(value)
  const defaultCollapsed = depth >= 2
  const collapsed = expandable
    ? expandedPaths.has(path)
      ? false
      : collapsedPaths.has(path)
        ? true
        : defaultCollapsed
    : false

  if (!expandable) {
    return (
      <JsonTreeLine depth={depth}>
        <span className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <JsonKey name={name} />
          <PrimitiveValue value={value} />
        </span>
      </JsonTreeLine>
    )
  }

  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value)

  return (
    <div>
      <JsonTreeLine
        depth={depth}
        interactive
        onClick={() => onToggle(path, collapsed, depth)}
      >
        {collapsed ? (
          <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <JsonKey name={name} />
          <span className="text-foreground">{getNodeSummary(value)}</span>
          {collapsed ? (
            <span className="ml-2 text-muted-foreground">
              {entries.length === 0 ? "empty" : "..."}
            </span>
          ) : null}
        </span>
      </JsonTreeLine>

      {collapsed ? null : (
        <div>
          {entries.length === 0 ? (
            <JsonTreeLine depth={depth + 1}>
              <span className="mt-0.5 size-3.5 shrink-0" />
              <span className="text-muted-foreground">empty</span>
            </JsonTreeLine>
          ) : (
            entries.map(([entryName, entryValue]) => (
              <JsonTreeNode
                collapsedPaths={collapsedPaths}
                depth={depth + 1}
                expandedPaths={expandedPaths}
                key={`${path}.${entryName}`}
                name={entryName}
                onToggle={onToggle}
                path={`${path}.${entryName}`}
                value={entryValue}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function StructuredJsonView({ value }: { value: unknown }) {
  const [expandedPaths, setExpandedPaths] = useState(() => new Set<string>())
  const [collapsedPaths, setCollapsedPaths] = useState(() => new Set<string>())

  function handleToggle(path: string, collapsed: boolean, depth: number) {
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (collapsed) {
        next.add(path)
      } else {
        next.delete(path)
      }
      return next
    })

    setCollapsedPaths((current) => {
      const next = new Set(current)
      if (collapsed) {
        next.delete(path)
      } else if (depth < 2) {
        next.add(path)
      } else {
        next.delete(path)
      }
      return next
    })
  }

  return (
    <div className="min-h-40 overflow-x-auto rounded-md border bg-muted/30 p-2 font-mono text-xs leading-5">
      <JsonTreeNode
        collapsedPaths={collapsedPaths}
        depth={0}
        expandedPaths={expandedPaths}
        onToggle={handleToggle}
        path="$"
        value={value}
      />
    </div>
  )
}

function JsonInspector({
  value,
  rawText,
}: {
  value: unknown
  rawText: string
}) {
  return (
    <Tabs className="gap-3" defaultValue="structured">
      <TabsList variant="line">
        <TabsTrigger value="structured">结构</TabsTrigger>
        <TabsTrigger value="raw">原始</TabsTrigger>
      </TabsList>
      <TabsContent value="structured">
        <StructuredJsonView value={value} />
      </TabsContent>
      <TabsContent value="raw">
        <RawTextBlock text={rawText} />
      </TabsContent>
    </Tabs>
  )
}

function EmptyState({ title }: { title: string }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-muted-foreground">
      <FileJson className="size-8" />
      <div className="text-sm">{title}</div>
    </div>
  )
}

export function App() {
  const [requests, setRequests] = useState<RequestSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RequestDetail | null>(null)
  const [search, setSearch] = useState("")
  const [baseUrl] = useState(() => window.location.origin)
  const [error, setError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const refreshList = useCallback(async () => {
    setIsRefreshing(true)

    try {
      const nextRequests = await fetchRequestSummaries()
      setRequests(nextRequests)
      setSelectedId((current) => getNextSelectedId(current, nextRequests))
      setError(null)
    } catch (nextError) {
      setError(getErrorMessage(nextError))
    } finally {
      setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadRequests() {
      try {
        const nextRequests = await fetchRequestSummaries()
        if (cancelled) {
          return
        }
        setRequests(nextRequests)
        setSelectedId((current) => getNextSelectedId(current, nextRequests))
        setError(null)
      } catch (nextError) {
        if (!cancelled) {
          setError(getErrorMessage(nextError))
        }
      }
    }

    void loadRequests()

    const timer = window.setInterval(() => {
      void loadRequests()
    }, 1500)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!selectedId) {
      return
    }

    let cancelled = false

    async function loadDetail() {
      try {
        const response = await fetch(
          `/api/requests/${encodeURIComponent(selectedId!)}`
        )
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const nextDetail = (await response.json()) as RequestDetail
        if (!cancelled) {
          setDetail(nextDetail)
          setError(null)
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(getErrorMessage(nextError))
        }
      }
    }

    void loadDetail()

    return () => {
      cancelled = true
    }
  }, [selectedId])

  const filteredRequests = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) {
      return requests
    }

    return requests.filter((item) =>
      [
        item.id,
        item.type,
        item.method,
        item.path,
        item.model,
        item.bodyPreview,
      ]
        .join(" ")
        .toLowerCase()
        .includes(keyword)
    )
  }, [requests, search])

  async function clearRequests() {
    await fetch("/api/requests", { method: "DELETE" })
    setRequests([])
    setDetail(null)
    setSelectedId(null)
  }

  async function copyText(value: string) {
    if (!value) {
      return
    }
    await navigator.clipboard.writeText(value)
  }

  const selectedSummary = requests.find((item) => item.id === selectedId)
  const activeDetail = detail?.id === selectedId ? detail : null

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b">
        <div className="flex h-16 items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted">
              <Server className="size-4" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">FakeLLM</h1>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="size-3.5 text-emerald-600" />
                <span>假模型接口</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Badge variant={error ? "destructive" : "secondary"}>
              {error ? "异常" : "在线"}
            </Badge>
            <IconButton
              disabled={isRefreshing}
              label="刷新"
              onClick={() => void refreshList()}
            >
              {isRefreshing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
            </IconButton>
            <IconButton
              disabled={requests.length === 0}
              label="清空"
              onClick={() => void clearRequests()}
              variant="destructive"
            >
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        </div>
      </header>

      <main className="grid min-h-[calc(100svh-4rem)] grid-cols-1 lg:h-[calc(100svh-4rem)] lg:grid-cols-[minmax(420px,0.95fr)_minmax(0,1.25fr)]">
        <section className="flex min-h-[360px] flex-col border-b lg:min-h-0 lg:border-r lg:border-b-0">
          <div className="flex items-center gap-2 border-b px-4 py-3 sm:px-6">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="筛选路径、模型或内容"
                value={search}
              />
            </div>
            <Badge variant="outline">{filteredRequests.length}</Badge>
          </div>

          <ScrollArea className="h-[44svh] lg:h-auto lg:min-h-0 lg:flex-1">
            {filteredRequests.length === 0 ? (
              <EmptyState title="暂无请求" />
            ) : (
              <Table className="[&_td:first-child]:pl-4 [&_td:first-child]:sm:pl-6 [&_th:first-child]:pl-4 [&_th:first-child]:sm:pl-6 [&_td:last-child]:pr-4 [&_td:last-child]:sm:pr-6 [&_th:last-child]:pr-4 [&_th:last-child]:sm:pr-6">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">时间</TableHead>
                    <TableHead className="w-20">类型</TableHead>
                    <TableHead>请求</TableHead>
                    <TableHead className="hidden w-20 text-right sm:table-cell">
                      状态
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRequests.map((item) => (
                    <TableRow
                      className={cn(
                        "cursor-pointer",
                        selectedId === item.id && "bg-muted/70"
                      )}
                      key={item.id}
                      onClick={() => setSelectedId(item.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          setSelectedId(item.id)
                        }
                      }}
                      tabIndex={0}
                    >
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {formatTime(item.timestamp)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            item.type === "responses" || item.type === "claude"
                              ? "default"
                              : "outline"
                          }
                        >
                          {requestTypeLabel[item.type]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="min-w-0 space-y-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <Badge variant="secondary">{item.method}</Badge>
                            <span className="truncate font-mono text-xs">
                              {item.path}
                            </span>
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {item.model || item.bodyPreview || "空请求体"}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden text-right sm:table-cell">
                        <Badge
                          variant={
                            item.statusCode >= 400
                              ? "destructive"
                              : "secondary"
                          }
                        >
                          {item.statusCode}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </ScrollArea>
        </section>

        <section className="flex min-h-[520px] flex-col lg:min-h-0">
          <div className="border-b px-4 py-4 sm:px-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-2">
                  <Badge variant="secondary">Base URL</Badge>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {baseUrl || "-"}
                  </span>
                </div>
                <h2 className="truncate font-mono text-sm font-medium">
                  {selectedSummary
                    ? `${selectedSummary.method} ${selectedSummary.path}`
                    : "未选择请求"}
                </h2>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <IconButton
                  disabled={!baseUrl}
                  label="复制 Base URL"
                  onClick={() => void copyText(baseUrl)}
                >
                  <Copy className="size-4" />
                </IconButton>
                <Badge variant="outline">{requests.length} 条</Badge>
              </div>
            </div>
          </div>

          {activeDetail ? (
            <>
              <div className="grid grid-cols-2 gap-3 border-b px-4 py-4 sm:px-6 text-xs sm:grid-cols-4">
                <div>
                  <div className="text-muted-foreground">时间</div>
                  <div className="mt-1 font-mono">
                    {formatDateTime(activeDetail.timestamp)}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">类型</div>
                  <div className="mt-1">
                    {requestTypeLabel[activeDetail.type]}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">模型</div>
                  <div className="mt-1 truncate font-mono">
                    {activeDetail.model || "-"}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">耗时</div>
                  <div className="mt-1 font-mono">
                    {activeDetail.durationMs}ms
                  </div>
                </div>
              </div>

              <Tabs
                className="flex min-h-0 flex-1 flex-col px-4 py-4 sm:px-6"
                defaultValue="body"
              >
                <div className="flex items-center justify-between gap-2">
                  <TabsList variant="line">
                    <TabsTrigger value="body">Body</TabsTrigger>
                    <TabsTrigger value="headers">Headers</TabsTrigger>
                    <TabsTrigger value="response">Response</TabsTrigger>
                    <TabsTrigger value="meta">Meta</TabsTrigger>
                  </TabsList>
                  <IconButton
                    label="复制详情"
                    onClick={() =>
                      void copyText(JSON.stringify(activeDetail, null, 2))
                    }
                  >
                    <Copy className="size-4" />
                  </IconButton>
                </div>

                <Separator />

                <ScrollArea className="min-h-0 flex-1">
                  <TabsContent value="body">
                    {activeDetail.bodyParseError ? (
                      <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                        {activeDetail.bodyParseError}
                      </div>
                    ) : null}
                    <JsonInspector
                      rawText={activeDetail.rawBody}
                      value={
                        activeDetail.bodyParseError
                          ? activeDetail.rawBody
                          : activeDetail.body
                      }
                    />
                  </TabsContent>
                  <TabsContent value="headers">
                    <JsonInspector
                      rawText={formatJson(activeDetail.headers)}
                      value={activeDetail.headers}
                    />
                  </TabsContent>
                  <TabsContent value="response">
                    <JsonInspector
                      rawText={formatJson(activeDetail.response.body)}
                      value={activeDetail.response.body}
                    />
                  </TabsContent>
                  <TabsContent value="meta">
                    <JsonInspector
                      rawText={formatJson(activeDetail.meta ?? {})}
                      value={activeDetail.meta ?? {}}
                    />
                  </TabsContent>
                </ScrollArea>
              </Tabs>
            </>
          ) : (
            <EmptyState title="选择一条请求查看详情" />
          )}
        </section>
      </main>
    </div>
  )
}

export default App
