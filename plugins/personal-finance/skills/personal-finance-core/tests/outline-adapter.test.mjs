import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import {
  deterministicOutlineDocumentId,
  OutlineAssetAdapter,
} from "../outline-adapter.mjs"
import { REQUIRED_BLOCKING_ITEM_IDS } from "../handoff.mjs"
import { projectLedger } from "../ledger.mjs"

const COLLECTION_ID = "123e4567-e89b-42d3-a456-426614174000"
const BASE_URL = "https://outline.example.com"
const API_TOKEN = "test-api-token"

function response(status, body, statusText = "", headers = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )
  return {
    headers: {
      get(name) {
        return normalizedHeaders[name.toLowerCase()] ?? null
      },
    },
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async json() {
      return structuredClone(body)
    },
  }
}

function assertPayloadKeys(payload, keys) {
  assert.deepEqual(Object.keys(payload).sort(), [...keys].sort())
}

function normalizeOutlineMarkdown(text) {
  const output = []
  const plainText = (line) => typeof line === "string"
    && line.length > 0
    && !/^(?:#|>|[*+-] |\d+\. |```|\|)/.test(line)
  const normalized = text
    .replace(/^- /gm, "* ")
    .replace(/(?<=[\p{L}\p{N}])\\_(?=[\p{L}\p{N}])/gu, "_")
    .replace(/(?<=\s)~(?=\s)/g, "\\~")
    .replaceAll("| 항목 | 금액 |\n| --- | ---: |", "| 항목  | 금액  |\n|-----|----:|")
  for (const sourceLine of normalized.split("\n")) {
    const line = sourceLine.startsWith("|") && sourceLine.endsWith("|")
      ? sourceLine.replace(/(?<!\\)(\|)(\s*)([+-])(?=\d)/g, "$1$2\\$3")
      : sourceLine
    const previous = output.at(-1)
    if (plainText(previous) && plainText(line)) output[output.length - 1] += ` ${line}`
    else output.push(line)
  }
  return output.join("\n")
}

class FakeOutline {
  calls = []
  documents = new Map()
  maxInfoConcurrency = 0
  maxMutationConcurrency = 0
  repeatListPage = false
  reverseListResults = false
  #activeInfo = 0
  #activeMutations = 0
  #ambiguous = new Map()
  #delays = new Map()
  #httpFailures = new Map()
  #infoDelays = new Map()
  #infoFailures = new Map()
  #invalidHttp = new Map()
  #invalidJson = new Map()
  #rateLimits = new Map()
  #sequence = 0

  fetch = async (url, options) => {
    const endpoint = new URL(url).pathname.split("/api/")[1]
    const payload = JSON.parse(options.body)
    this.calls.push({ endpoint, options: structuredClone(options), payload, url })

    if (this.#take(this.#httpFailures, endpoint)) {
      return response(500, { message: "server exploded", ok: false }, "Internal Server Error")
    }
    const retryAfter = this.#takeValue(this.#rateLimits, endpoint)
    if (retryAfter !== undefined) {
      return response(
        429,
        { message: "rate limited", ok: false },
        "Too Many Requests",
        { "Retry-After": retryAfter },
      )
    }
    const invalidHttp = this.#takeValue(this.#invalidHttp, endpoint)
    if (invalidHttp) {
      return {
        headers: {
          get(name) {
            return name.toLowerCase() === "retry-after" ? invalidHttp.retryAfter : null
          },
        },
        ok: false,
        status: invalidHttp.status,
        statusText: invalidHttp.statusText,
        async json() {
          throw new SyntaxError("invalid JSON")
        },
      }
    }
    if (this.#take(this.#invalidJson, endpoint)) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          throw new SyntaxError("invalid JSON")
        },
      }
    }

    const infoRequest = endpoint === "documents.info"
    const mutationRequest = new Set(["documents.create", "documents.update"]).has(endpoint)
    if (infoRequest) {
      this.#activeInfo += 1
      this.maxInfoConcurrency = Math.max(this.maxInfoConcurrency, this.#activeInfo)
    }
    if (mutationRequest) {
      this.#activeMutations += 1
      this.maxMutationConcurrency = Math.max(this.maxMutationConcurrency, this.#activeMutations)
    }
    try {
      const delay = endpoint === "documents.info"
        ? this.#infoDelays.get(payload.id) ?? this.#delays.get(endpoint) ?? 0
        : this.#delays.get(endpoint) ?? 0
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      switch (endpoint) {
      case "documents.info": {
        assertPayloadKeys(payload, ["id"])
        if (this.#take(this.#infoFailures, payload.id)) {
          return response(500, { message: "targeted info failure", ok: false }, "Internal Server Error")
        }
        const document = this.documents.get(payload.id)
        return document
          ? response(200, { data: document, ok: true })
          : response(404, { message: "Resource not found", ok: false }, "Not Found")
      }
      case "documents.create": {
        assertPayloadKeys(payload, [
          "collectionId",
          "id",
          ...(payload.parentDocumentId === undefined ? [] : ["parentDocumentId"]),
          "publish",
          "text",
          "title",
        ])
        assert.equal(payload.publish, true)
        if (this.documents.has(payload.id)) {
          return response(409, { message: "id must be unique", ok: false }, "Conflict")
        }
        const document = {
          archivedAt: null,
          collectionId: payload.collectionId,
          createdAt: this.#createdAt(),
          id: payload.id,
          parentDocumentId: payload.parentDocumentId ?? null,
          publishedAt: this.#createdAt(),
          text: normalizeOutlineMarkdown(payload.text),
          title: payload.title,
          url: `/doc/${payload.id}`,
        }
        this.documents.set(document.id, document)
        if (this.#take(this.#ambiguous, endpoint)) throw new Error("connection closed")
        return response(200, { data: document, ok: true })
      }
      case "documents.update": {
        assertPayloadKeys(payload, ["editMode", "id", "publish", "text", "title"])
        assert.equal(payload.editMode, "replace")
        assert.equal(payload.publish, true)
        const document = this.documents.get(payload.id)
        if (!document) return response(404, { message: "Resource not found", ok: false }, "Not Found")
        Object.assign(document, {
          publishedAt: this.#createdAt(),
          text: normalizeOutlineMarkdown(payload.text),
          title: payload.title,
        })
        if (this.#take(this.#ambiguous, endpoint)) throw new Error("connection closed")
        return response(200, { data: document, ok: true })
      }
      case "documents.list": {
        assertPayloadKeys(payload, [
          "collectionId",
          "direction",
          "limit",
          "offset",
          "parentDocumentId",
          "sort",
          "statusFilter",
        ])
        const documents = [...this.documents.values()]
          .filter((document) => {
            return document.collectionId === payload.collectionId
              && document.parentDocumentId === payload.parentDocumentId
              && (payload.statusFilter.includes("archived") && document.archivedAt != null
                || payload.statusFilter.includes("published")
                  && document.publishedAt != null && document.archivedAt == null
                || payload.statusFilter.includes("draft")
                  && document.publishedAt == null && document.archivedAt == null)
          })
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        if (this.reverseListResults) documents.reverse()
        const pageOffset = this.repeatListPage && payload.offset > 0 ? 0 : payload.offset
        const page = documents
          .slice(pageOffset, pageOffset + payload.limit)
          .map(({ text: _text, ...document }) => document)
        const nextOffset = payload.offset + page.length
        return response(200, {
          data: page,
          ok: true,
          pagination: {
            nextPath: nextOffset < documents.length ? `/api/documents.list?offset=${nextOffset}` : undefined,
            total: documents.length,
          },
        })
      }
      default:
        return response(404, { message: `unknown endpoint: ${endpoint}`, ok: false }, "Not Found")
      }
    } finally {
      if (infoRequest) this.#activeInfo -= 1
      if (mutationRequest) this.#activeMutations -= 1
    }
  }

  ambiguousOnce(endpoint) {
    this.#ambiguous.set(endpoint, (this.#ambiguous.get(endpoint) ?? 0) + 1)
  }

  failHttpOnce(endpoint) {
    this.#httpFailures.set(endpoint, (this.#httpFailures.get(endpoint) ?? 0) + 1)
  }

  rateLimitOnce(endpoint, retryAfter = "2") {
    const values = this.#rateLimits.get(endpoint) ?? []
    values.push(retryAfter)
    this.#rateLimits.set(endpoint, values)
  }

  invalidHttpOnce(endpoint, { retryAfter = "2", status = 429, statusText = "Too Many Requests" } = {}) {
    const values = this.#invalidHttp.get(endpoint) ?? []
    values.push({ retryAfter, status, statusText })
    this.#invalidHttp.set(endpoint, values)
  }

  failInfoOnce(id) {
    this.#infoFailures.set(id, (this.#infoFailures.get(id) ?? 0) + 1)
  }

  setInfoDelay(id, milliseconds) {
    this.#infoDelays.set(id, milliseconds)
  }

  setDelay(endpoint, milliseconds) {
    this.#delays.set(endpoint, milliseconds)
  }

  invalidJsonOnce(endpoint) {
    this.#invalidJson.set(endpoint, (this.#invalidJson.get(endpoint) ?? 0) + 1)
  }

  count(endpoint) {
    return this.calls.filter((call) => call.endpoint === endpoint).length
  }

  #createdAt() {
    const value = new Date(Date.parse("2099-01-15T00:00:00.000Z") + this.#sequence).toISOString()
    this.#sequence += 1
    return value
  }

  #take(collection, endpoint) {
    const remaining = collection.get(endpoint) ?? 0
    if (remaining === 0) return false
    collection.set(endpoint, remaining - 1)
    return true
  }

  #takeValue(collection, endpoint) {
    const values = collection.get(endpoint)
    if (!values?.length) return undefined
    return values.shift()
  }
}

function createAdapter(fake = new FakeOutline(), options = {}) {
  return {
    adapter: new OutlineAssetAdapter({
      apiToken: API_TOKEN,
      baseUrl: BASE_URL,
      collectionId: COLLECTION_ID,
      fetchImpl: fake.fetch,
      ...options,
    }),
    fake,
  }
}

function machineEnvelope(kind, key, dataJson) {
  const digestInput = `{"data":${dataJson},"key":"${key}","kind":"${kind}","version":1}`
  const digest = createHash("sha256").update(digestInput).digest("hex")
  return [
    "```json",
    `{"data":${dataJson},"digest":"${digest}","key":"${key}","kind":"${kind}","version":1}`,
    "```",
  ].join("\n")
}

function measured(amount) {
  return {
    amount,
    next_review_at: null,
    observed_at: "2099-01-15T09:00:00+09:00",
    value_kind: "exact",
  }
}

function validHandoff() {
  return {
    accounts: [{ account_id: "main", cash_like: true, label: "예시 계좌", liquidity: "immediate" }],
    budget_policy: {
      point_policy: "cash_centered",
      protected_categories: [],
      refund_period_policy: "receipt",
    },
    cashflow_horizon: {
      essential_obligations: [],
      next_income: {
        amount: measured(3_000_000),
        expected_at: "2099-01-25T09:00:00+09:00",
        source_label: "예시 급여",
      },
      payment_capacity: {
        assessed_at: "2099-01-15T09:00:00+09:00",
        can_cover: true,
        policy_available: measured(1_000_000),
        required_before_next_income: measured(0),
      },
    },
    created_at: "2099-01-15T10:00:00+09:00",
    follow_ups: [],
    goals: [],
    liabilities: [],
    onboarding_checklist: REQUIRED_BLOCKING_ITEM_IDS.map((item_id) => ({
      classification: "blocking",
      item_id,
      note: "확인",
      status: "complete",
    })),
    opening_positions: [{
      account_id: "main",
      allocation_id: null,
      policy: "available",
      position_id: "main-free",
      value: measured(1_000_000),
    }],
    operations: {
      execution_mode: "direct",
      settlement_cadence: "weekly",
    },
    profile: {
      currency: "KRW",
      lifecycle_stage: "early_career",
      timezone: "Asia/Seoul",
    },
    recurring_flows: [],
    risk_rules: { deficit_period_threshold: 2 },
    schema_version: "1.0.0",
    snapshot: { as_of: "2099-01-15T09:00:00+09:00" },
    storage: { adapter: "outline", location: null },
  }
}

function ledgerEvent(eventId, overrides = {}) {
  return {
    accounting_period_id: "2099-01",
    event_id: eventId,
    occurred_at: "2099-01-15T09:00:00+09:00",
    payload: { amount: 1, position_id: "main-free" },
    recognition_status: "recognized",
    settlement_status: "not_applicable",
    source: { fingerprint: eventId, kind: "user" },
    type: "cash_purchase",
    verification_status: "confirmed",
    ...overrides,
  }
}

function replayOpening() {
  return {
    accounts: [{ account_id: "main", cash_like: true, label: "주계좌", liquidity: "immediate" }],
    liabilities: [{
      accrued_interest: 0,
      fees_due: 0,
      label: "예시 부채",
      liability_id: "loan",
      principal: 0,
      type: "card_loan",
    }],
    points: [],
    positions: [{
      account_id: "main",
      amount: 0,
      policy: "available",
      position_id: "main-free",
    }],
  }
}

function replayHandoff() {
  const handoff = validHandoff()
  handoff.cashflow_horizon.payment_capacity.policy_available = measured(0)
  handoff.liabilities = [{
    accrued_interest: measured(0),
    annual_rate: null,
    fees_due: measured(0),
    label: "예시 부채",
    liability_id: "loan",
    minimum_payment: null,
    next_payment: {
      amount: measured(0),
      due_at: "2099-01-30T09:00:00+09:00",
    },
    overdue: false,
    payment_account_id: "main",
    principal: measured(0),
    remaining_installments: null,
    total_installments: null,
    type: "card_loan",
  }]
  handoff.opening_positions[0].value = measured(0)
  return handoff
}

function orderedReplayEvents() {
  const plans = Array.from({ length: 99 }, (_, index) => ledgerEvent(`plan-${index}`, {
    payload: { commitment_id: `commitment-${index}`, label: `계획 ${index}` },
    recognition_status: "planned",
    type: "plan_created",
  }))
  return [
    ...plans,
    ledgerEvent("income", {
      payload: { amount: 200, income_kind: "earned", position_id: "main-free" },
      type: "income_received",
    }),
    ledgerEvent("purchase-after-income", {
      payload: { amount: 100, position_id: "main-free" },
    }),
    ledgerEvent("draw", {
      payload: { liability_id: "loan", position_id: "main-free", principal: 50 },
      settlement_status: "unsettled",
      type: "debt_draw",
    }),
    ledgerEvent("payment-after-draw", {
      payload: { liability_id: "loan", position_id: "main-free", principal: 50 },
      settlement_status: "settled",
      type: "debt_payment",
    }),
    ledgerEvent("refundable-purchase", {
      payload: { amount: 10, position_id: "main-free" },
    }),
    ledgerEvent("refund-after-purchase", {
      payload: { amount: 10, position_id: "main-free", source_event_id: "refundable-purchase" },
      recognition_status: "reversal",
      type: "refund",
    }),
  ]
}

test("FakeOutline은 실제 API에서 관찰한 읽기용 Markdown 정규화를 재현한다", () => {
  const source = [
    "- 결산 주기: every\\_event",
    "첫 문장",
    "둘째 문장",
    "",
    "| 항목 | 금액 |",
    "| --- | ---: |",
    "| 값 | 1 |",
    "| 손익 | -23,658 KRW |",
    "| 증감 | +500 KRW |",
    "| 기간 | 2099-01-01 ~ 2099-01-31 |",
  ].join("\n")
  assert.equal(normalizeOutlineMarkdown(source), [
    "* 결산 주기: every_event",
    "첫 문장 둘째 문장",
    "",
    "| 항목  | 금액  |",
    "|-----|----:|",
    "| 값 | 1 |",
    "| 손익 | \\-23,658 KRW |",
    "| 증감 | \\+500 KRW |",
    "| 기간 | 2099-01-01 \\~ 2099-01-31 |",
  ].join("\n"))
})

test("Outline 요청은 Bearer JSON을 사용하고 404 missing과 API 오류를 구분한다", async () => {
  const { adapter, fake } = createAdapter()
  assert.equal(await adapter.readHandoff(), null)

  const firstCall = fake.calls[0]
  assert.equal(firstCall.options.method, "POST")
  assert.equal(firstCall.options.headers.Authorization, `Bearer ${API_TOKEN}`)
  assert.equal(firstCall.options.headers["Content-Type"], "application/json")
  assert.equal(Object.hasOwn(firstCall.options.headers, "X-API-Version"), false)
  assert.equal(firstCall.options.redirect, "error")
  assert.equal(JSON.stringify(firstCall.payload).includes(API_TOKEN), false)

  const failed = createAdapter()
  failed.fake.failHttpOnce("documents.info")
  await assert.rejects(failed.adapter.bootstrap(), /Outline documents.info failed \(HTTP 500\): server exploded/)

  const invalidJson = createAdapter()
  invalidJson.fake.invalidJsonOnce("documents.info")
  await assert.rejects(invalidJson.adapter.bootstrap(), /returned invalid JSON \(HTTP 200\)/)

  const rateLimited = createAdapter()
  rateLimited.fake.rateLimitOnce("documents.info", "3")
  const callsBefore = rateLimited.fake.count("documents.info")
  await assert.rejects(rateLimited.adapter.bootstrap(), (error) => {
    assert.equal(error.status, 429)
    assert.equal(error.retryAfter, "3")
    assert.deepEqual(error.responseBody, { message: "rate limited", ok: false })
    assert.match(error.message, /HTTP 429.*Retry-After=3/)
    return true
  })
  assert.equal(rateLimited.fake.count("documents.info"), callsBefore + 1)
  await rateLimited.adapter.bootstrap()

  const invalidRateLimit = createAdapter()
  invalidRateLimit.fake.invalidHttpOnce("documents.info", { retryAfter: "5" })
  await assert.rejects(invalidRateLimit.adapter.bootstrap(), (error) => {
    assert.equal(error.status, 429)
    assert.equal(error.retryAfter, "5")
    assert.equal(error.responseBody, undefined)
    assert.match(error.message, /HTTP 429.*Retry-After=5/)
    return true
  })
})

test("constructor는 env fallback과 명시적 HTTP opt-in을 지원하고 credential을 직렬화하지 않는다", async () => {
  const previous = {
    OUTLINE_API_TOKEN: process.env.OUTLINE_API_TOKEN,
    OUTLINE_COLLECTION_ID: process.env.OUTLINE_COLLECTION_ID,
    OUTLINE_URL: process.env.OUTLINE_URL,
  }
  process.env.OUTLINE_URL = BASE_URL
  process.env.OUTLINE_API_TOKEN = API_TOKEN
  process.env.OUTLINE_COLLECTION_ID = COLLECTION_ID
  try {
    const fake = new FakeOutline()
    const adapter = new OutlineAssetAdapter({ fetchImpl: fake.fetch })
    assert.equal(adapter.collectionId, COLLECTION_ID)
    assert.equal(JSON.stringify(adapter).includes(API_TOKEN), false)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  assert.throws(
    () => createAdapter(undefined, { baseUrl: "http://outline.example.com" }),
    /must use https unless allowInsecureHttp is explicitly enabled/,
  )
  const insecure = createAdapter(undefined, {
    allowInsecureHttp: true,
    baseUrl: "http://outline.example.com",
  })
  assert.equal(insecure.adapter.collectionId, COLLECTION_ID)
  await insecure.adapter.bootstrap()
  assert.ok(insecure.fake.calls.every((call) => call.url.startsWith("http://outline.example.com/api/")))
  assert.throws(
    () => createAdapter(undefined, { allowInsecureHttp: "yes" }),
    /allowInsecureHttp must be a boolean/,
  )
})

test("bootstrap은 전용 계층을 멱등 생성하고 위치 충돌을 거부한다", async () => {
  const { adapter, fake } = createAdapter()
  const ids = await adapter.bootstrap()
  assert.equal(fake.count("documents.create"), 11)
  const updatesAfterFirstBootstrap = fake.count("documents.update")
  await adapter.bootstrap()
  assert.equal(fake.count("documents.create"), 11)
  assert.equal(fake.count("documents.update"), updatesAfterFirstBootstrap)
  for (const id of Object.values(ids)) {
    assert.match(id, /^[0-9a-f-]{36}$/)
    assert.equal(id[14], "4")
  }
  assert.equal(fake.documents.get(ids.rawRoot).parentDocumentId, null)
  assert.equal(fake.documents.get(ids.rawRoot).title, "원본 JSON (기계 전용)")
  assert.match(fake.documents.get(ids.rawRoot).text, /^# 원본 JSON\n/)
  assert.doesNotMatch(fake.documents.get(ids.rawRoot).text, /```json/)
  assert.equal(fake.documents.get(ids.root).parentDocumentId, ids.rawRoot)
  assert.equal(fake.documents.get(ids.root).title, "시스템 manifest")
  assert.match(fake.documents.get(ids.root).text, /^```json\n/)
  assert.equal(fake.documents.get(ids.overview).parentDocumentId, null)
  assert.equal(fake.documents.get(ids.overview).title, "자산관리 시스템")
  assert.match(fake.documents.get(ids.overview).text, /^# 자산관리 시스템\n/)
  assert.doesNotMatch(fake.documents.get(ids.overview).text, /```json/)
  assert.equal(ids.principles, deterministicOutlineDocumentId(COLLECTION_ID, "view:handoff"))
  assert.equal(ids.assets, deterministicOutlineDocumentId(COLLECTION_ID, "view:current-state"))
  for (const id of [ids.principles, ids.assets, ids.recurringFlows, ids.monthly]) {
    assert.equal(fake.documents.get(id).parentDocumentId, ids.overview)
  }
  assert.match(fake.documents.get(ids.principles).text, /^# 개인화된 자산관리 원칙\n/)
  assert.match(fake.documents.get(ids.assets).text, /^# 개인 자산 목록\n/)
  assert.match(fake.documents.get(ids.recurringFlows).text, /^# 고정 수입·지출\n/)
  assert.match(fake.documents.get(ids.monthly).text, /^# 월별 수입·지출\n/)
  assert.equal(fake.documents.get(ids.events).parentDocumentId, ids.root)
  assert.equal(fake.documents.get(ids.notifications).parentDocumentId, ids.root)
  assert.equal(fake.documents.get(ids.eventIndex).parentDocumentId, ids.events)
  assert.equal(fake.documents.get(ids.notificationIndex).parentDocumentId, ids.notifications)

  fake.documents.get(ids.root).parentDocumentId = null
  await assert.rejects(adapter.bootstrap(), /unexpected parent/)
  fake.documents.get(ids.root).parentDocumentId = ids.rawRoot

  fake.documents.get(ids.events).parentDocumentId = "11111111-1111-4111-8111-111111111111"
  await assert.rejects(adapter.bootstrap(), /unexpected parent/)
  fake.documents.get(ids.events).parentDocumentId = ids.root
  fake.documents.get(ids.events).publishedAt = null
  await assert.rejects(adapter.bootstrap(), /must be published and not archived/)

  const collision = createAdapter()
  const rootId = collision.adapter.documentIds.root
  collision.fake.documents.set(rootId, {
    collectionId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2099-01-15T00:00:00.000Z",
    id: rootId,
    parentDocumentId: null,
    text: "invalid",
    title: "collision",
  })
  await assert.rejects(collision.adapter.bootstrap(), /another collection/)

  const versioned = createAdapter()
  await versioned.adapter.bootstrap()
  versioned.fake.documents.get(versioned.adapter.documentIds.eventIndex).text = machineEnvelope(
    "asset-management-index",
    "events-index",
    '{"entries":[],"index_version":2}',
  )
  await assert.rejects(versioned.adapter.readEvents(), /index has unsupported version: 2/)
})

test("handoff는 validation 후 고정 문서로 round trip하고 입력을 변경하지 않는다", async () => {
  const { adapter, fake } = createAdapter()
  const handoff = validHandoff()
  const before = structuredClone(handoff)
  await adapter.writeHandoff(handoff)
  assert.deepEqual(handoff, before)
  assert.deepEqual(await adapter.readHandoff(), handoff)

  const callsBeforeChange = fake.calls.length
  const changed = structuredClone(handoff)
  changed.profile.household_notes = "합성 가구 정보"
  changed.operations.settlement_cadence = "every_event"
  changed.budget_policy.refund_period_policy = "source"
  await adapter.writeHandoff(changed)
  assert.deepEqual(await adapter.readHandoff(), changed)
  const changedCalls = fake.calls.slice(callsBeforeChange)
  const rawUpdates = changedCalls.filter((call) => {
    return call.endpoint === "documents.update" && call.payload.id === adapter.documentIds.handoff
  })
  const principleUpdates = changedCalls.filter((call) => {
    return call.endpoint === "documents.update" && call.payload.id === adapter.documentIds.principles
  })
  assert.equal(rawUpdates.length, 1)
  assert.equal(principleUpdates.length, 1)
  assert.ok(fake.calls.indexOf(rawUpdates[0]) < fake.calls.indexOf(principleUpdates[0]))
  const rawDocument = fake.documents.get(adapter.documentIds.handoff)
  const principleDocument = fake.documents.get(adapter.documentIds.principles)
  const overviewDocument = fake.documents.get(adapter.documentIds.overview)
  const assetsDocument = fake.documents.get(adapter.documentIds.assets)
  assert.match(rawDocument.text, /^```json\n/)
  assert.match(principleDocument.text, /^# 개인화된 자산관리 원칙\n/)
  assert.match(overviewDocument.text, /\| 순자산 \| 1,000,000 KRW \|/)
  assert.match(assetsDocument.text, /\| 현금성 자산 \| 1,000,000 KRW \|/)
  assert.match(principleDocument.text, /환불은 원거래 월의 지출을 조정해요/)
  assert.doesNotMatch(principleDocument.text, /every\\_event|합성 가구 정보/)
  const assetsCreate = fake.calls.find((call) => {
    return call.endpoint === "documents.create" && call.payload.id === adapter.documentIds.assets
  })
  const overviewCreate = fake.calls.find((call) => {
    return call.endpoint === "documents.create" && call.payload.id === adapter.documentIds.overview
  })
  assert.match(assetsCreate.payload.text, /\| 항목 \| 금액 \|\n\| --- \| --- \|/)
  assert.match(overviewCreate.payload.text, /## 자산 현황/)
  for (const document of [
    overviewDocument,
    principleDocument,
    assetsDocument,
  ]) {
    assert.equal(document.text, normalizeOutlineMarkdown(document.text))
    assert.doesNotMatch(document.text, /^- /m)
  }
  assert.doesNotMatch(principleDocument.text, /```json|schema_version|합성 가구 정보|예시 계좌/)
  assert.doesNotMatch(overviewDocument.text, /```json|schema_version|합성 가구 정보|예시 계좌/)
  assert.match(assetsDocument.text, /예시 계좌/)

  overviewDocument.text = overviewDocument.text.replace(/^\* /gm, "- ")
  principleDocument.text = principleDocument.text
    .replace("| 코드 | 원칙 | 적용 |", "|  코드 |원칙   | 적용|")
    .replace("| --- | --- | --- |", "|--------|------|---|")
  assetsDocument.text = assetsDocument.text
    .replace("| 항목 | 금액 |", "|항목   |  금액|")
    .replace("| --- | --- |", "|---|----------|")
  const updatesBeforeEquivalentFormatting = fake.count("documents.update")
  await adapter.bootstrap()
  assert.equal(fake.count("documents.update"), updatesBeforeEquivalentFormatting)

  overviewDocument.text = overviewDocument.text.replace(/^- /m, "* ")
  const updatesBeforeMixedListRepair = fake.count("documents.update")
  await adapter.bootstrap()
  assert.equal(fake.count("documents.update"), updatesBeforeMixedListRepair + 1)
  assert.doesNotMatch(overviewDocument.text, /^- /m)

  principleDocument.text = principleDocument.text.replace("|--------|------|---|", "|:--------|------|---|")
  const updatesBeforeAlignmentRepair = fake.count("documents.update")
  await adapter.bootstrap()
  assert.equal(fake.count("documents.update"), updatesBeforeAlignmentRepair + 1)
  assert.match(principleDocument.text, /\| --- \| --- \| --- \|/)

  principleDocument.text = principleDocument.text.replace(
    "| 코드 | 원칙 | 적용 |",
    '|["코드","원칙","적용"]',
  )
  const updatesBeforeMalformedTableRepair = fake.count("documents.update")
  await adapter.bootstrap()
  assert.equal(fake.count("documents.update"), updatesBeforeMalformedTableRepair + 1)
  assert.match(principleDocument.text, /\| 코드 \| 원칙 \| 적용 \|/)

  overviewDocument.text = overviewDocument.text.replace("원본 replay 결과", "다른 결과")
  assetsDocument.text = assetsDocument.text.replace("# 개인 자산 목록", "## 다른 자산 목록")
  principleDocument.text = principleDocument.text.replace("P-04", "P-99")
  const updatesBeforeContentRepair = fake.count("documents.update")
  await adapter.bootstrap()
  assert.equal(fake.count("documents.update"), updatesBeforeContentRepair + 3)
  assert.match(overviewDocument.text, /원본 replay 결과/)
  assert.match(assetsDocument.text, /^# 개인 자산 목록$/m)
  assert.match(principleDocument.text, /P-04/)

  const invalid = structuredClone(handoff)
  delete invalid.profile.currency
  await assert.rejects(adapter.writeHandoff(invalid), /handoff.profile.currency is required/)
  const changedTimezone = structuredClone(changed)
  changedTimezone.profile.timezone = "Etc/UTC"
  await assert.rejects(adapter.writeHandoff(changedTimezone), /timezone cannot change/)
  const changedOpeningSnapshot = structuredClone(changed)
  changedOpeningSnapshot.snapshot.as_of = "2099-01-16T09:00:00+09:00"
  await assert.rejects(adapter.writeHandoff(changedOpeningSnapshot), /snapshot.as_of cannot change/)
  assert.equal([...fake.documents.values()].some((document) => document.text.includes(API_TOKEN)), false)
})

test("handoff가 없으면 원장에 event를 commit하지 않는다", async () => {
  const { adapter, fake } = createAdapter()
  const event = ledgerEvent("missing-handoff")
  await assert.rejects(adapter.appendEvent(event), /handoff must be stored/)
  assert.equal(fake.documents.has(adapter.eventDocumentId(event.event_id)), false)
  assert.deepEqual(await adapter.readEvents(), [])
})

test("사람용 계층은 자산, 고정 흐름, 월별 발생 손익과 현금흐름을 원본 replay에서 만든다", async () => {
  const { adapter, fake } = createAdapter()
  const handoff = validHandoff()
  handoff.budget_policy.protected_categories = ["의료"]
  handoff.cashflow_horizon.essential_obligations = [{
    amount: measured(50),
    due_at: "2099-01-20T09:00:00+09:00",
    label: "이전 카드 의무",
    obligation_id: "previous-card-obligation",
    payment_account_id: "main",
    source_liability_id: "card",
  }]
  handoff.cashflow_horizon.payment_capacity.required_before_next_income = measured(50)
  handoff.liabilities = [
    {
      accrued_interest: measured(0),
      fees_due: measured(0),
      label: "예시 카드",
      liability_id: "card",
      next_payment: {
        amount: measured(100),
        due_at: "2099-02-10T09:00:00+09:00",
      },
      overdue: false,
      payment_account_id: "main",
      principal: measured(0),
      type: "credit_card",
    },
    {
      accrued_interest: measured(0),
      annual_rate: 5,
      fees_due: measured(0),
      label: "예시 할부",
      liability_id: "installment",
      minimum_payment: measured(20),
      next_payment: {
        amount: measured(20),
        due_at: "2099-02-20T09:00:00+09:00",
      },
      overdue: false,
      payment_account_id: "main",
      principal: measured(100),
      remaining_installments: 5,
      total_installments: 10,
      type: "installment",
    },
  ]
  handoff.liabilities[1].principal.observed_at = "2099-01-14T09:00:00+09:00"
  handoff.operations.last_closed_period_id = "2099-01"
  handoff.recurring_flows = [
    {
      amount: measured(300),
      direction: "income",
      essential: true,
      flow_id: "salary",
      label: "예시 월급",
      schedule: "매월 25일",
    },
    {
      amount: measured(80),
      direction: "expense",
      essential: true,
      flow_id: "rent",
      label: "예시 월세",
      schedule: "매월 1일",
    },
  ]
  await adapter.writeHandoff(handoff)

  const events = [
    ledgerEvent("rich-income", {
      occurred_at: "2099-01-16T09:00:00+09:00",
      payload: { amount: 300, income_kind: "earned", position_id: "main-free" },
      type: "income_received",
    }),
    ledgerEvent("rich-card-purchase", {
      occurred_at: "2099-01-17T09:00:00+09:00",
      payload: { amount: 100, liability_id: "card" },
      settlement_status: "unsettled",
      type: "card_purchase",
    }),
    ledgerEvent("rich-installment-purchase", {
      occurred_at: "2099-01-18T09:00:00+09:00",
      payload: { amount: 50, liability_id: "installment" },
      settlement_status: "unsettled",
      type: "installment_purchase",
    }),
    ledgerEvent("rich-points", {
      occurred_at: "2099-01-19T09:00:00+09:00",
      payload: { amount: 7, program_id: "rewards" },
      recognition_status: "not_applicable",
      type: "points_earned",
    }),
    ledgerEvent("rich-card-payment", {
      occurred_at: "2099-01-20T09:00:00+09:00",
      payload: { amount: 100, liability_id: "card", position_id: "main-free" },
      settlement_status: "settled",
      type: "card_payment",
    }),
    ledgerEvent("rich-debt-payment", {
      occurred_at: "2099-01-21T09:00:00+09:00",
      payload: { liability_id: "installment", position_id: "main-free", principal: 20 },
      settlement_status: "settled",
      type: "debt_payment",
    }),
    ledgerEvent("rich-february-purchase", {
      accounting_period_id: "2099-02",
      occurred_at: "2099-02-02T09:00:00+09:00",
      payload: { amount: 10, position_id: "main-free" },
    }),
    ledgerEvent("rich-pending", {
      accounting_period_id: "2099-03",
      occurred_at: "2099-03-01T09:00:00+09:00",
      payload: { amount: 5, position_id: "main-free" },
      verification_status: "pending",
    }),
  ]
  for (const event of events) await adapter.appendEvent(event)

  const ids = adapter.documentIds
  const year = fake.documents.get(adapter.yearDocumentId("2099"))
  const january = fake.documents.get(adapter.monthDocumentId("2099-01"))
  const february = fake.documents.get(adapter.monthDocumentId("2099-02"))
  const march = fake.documents.get(adapter.monthDocumentId("2099-03"))
  assert.equal(year.parentDocumentId, ids.monthly)
  assert.equal(january.parentDocumentId, year.id)
  assert.equal(february.parentDocumentId, year.id)
  assert.equal(march.parentDocumentId, year.id)
  assert.match(fake.documents.get(ids.principles).text, /보호 지출: 의료/)
  assert.match(fake.documents.get(ids.assets).text, /예시 카드/)
  assert.match(fake.documents.get(ids.assets).text, /예시 할부/)
  assert.match(fake.documents.get(ids.assets).text, /실제 잔액과 원장 계산값의 차이는 잔액 확인 기록이 추가된 뒤/)
  assert.match(fake.documents.get(ids.recurringFlows).text, /예시 월급/)
  assert.match(fake.documents.get(ids.recurringFlows).text, /예시 월세/)
  assert.match(fake.documents.get(ids.recurringFlows).text, /부채 다음 상환액 \| 20 KRW/)
  assert.match(fake.documents.get(ids.overview).text, /계산 기준 시각: 2099-02-02T09:00:00\+09:00/)
  assert.match(fake.documents.get(ids.overview).text, /1건의 입력을 확인해야 해요/)
  assert.match(fake.documents.get(ids.overview).text, /예시 카드/)
  assert.match(fake.documents.get(ids.overview).text, /2099-02-10/)

  assert.match(january.text, /상태: 마감/)
  assert.match(january.text, /\| 발생 \| 수입 \| 300 KRW \|/)
  assert.match(january.text, /\| 발생 \| 지출 \| 150 KRW \|/)
  assert.match(january.text, /\| 현금 \| 유출 \| 120 KRW \|/)
  assert.match(january.text, /\| 현금 \| 부채 원금 상환 \| 20 KRW \|/)
  assert.match(january.text, /7 포인트/)
  assert.doesNotMatch(january.text, /7 KRW/)
  assert.ok(january.text.indexOf("2099-01-16") < january.text.indexOf("2099-01-17"))
  assert.ok(january.text.indexOf("2099-01-17") < january.text.indexOf("2099-01-20"))
  assert.doesNotMatch(january.text, /rich-income|rich-card-purchase|rich-card-payment/)
  assert.match(february.text, /상태: 진행 중/)
  assert.match(february.text, /\| 발생 \| 지출 \| 10 KRW \|/)
  assert.match(march.text, /상태: 예정/)
  assert.match(march.text, /현금·계좌 구매/)
  assert.match(year.text, /확정 누계 기준 월: 2099-01/)
  assert.match(year.text, /\| 발생 지출 \| 150 KRW \|/)
})

test("읽기용 표 비교는 escaped pipe의 셀 경계를 보존한다", async () => {
  const { adapter, fake } = createAdapter()
  const handoff = validHandoff()
  handoff.profile.currency = "A|B"
  await adapter.writeHandoff(handoff)

  const assets = fake.documents.get(adapter.documentIds.assets)
  assert.match(assets.text, /\| 현금성 자산 \| 1,000,000 A\\\|B \|/)
  assets.text = assets.text.replace(
    "| 현금성 자산 | 1,000,000 A\\|B |",
    "| 현금성 자산 | 1,000,000 A\\ | B |",
  )
  const updatesBeforeRepair = fake.count("documents.update")
  await adapter.bootstrap()
  assert.equal(fake.count("documents.update"), updatesBeforeRepair + 1)
  assert.match(assets.text, /\| 현금성 자산 \| 1,000,000 A\\\|B \|/)
})

test("자산 표는 숫자 음수 앞에 추가된 escape만 동등하게 비교한다", async () => {
  const { adapter, fake } = createAdapter()
  const handoff = validHandoff()
  handoff.liabilities = [{
    accrued_interest: measured(0),
    fees_due: measured(0),
    label: "예시 부채",
    liability_id: "debt",
    overdue: false,
    principal: measured(1_023_658),
    type: "general_debt",
  }]
  await adapter.writeHandoff(handoff)

  const assets = fake.documents.get(adapter.documentIds.assets)
  assert.match(assets.text, /\| 순자산 \| \\-23,658 KRW \|/)
  const updatesBeforeEquivalentBootstrap = fake.count("documents.update")
  await adapter.bootstrap()
  assert.equal(fake.count("documents.update"), updatesBeforeEquivalentBootstrap)

  assets.text = assets.text.replace("\\-23,658 KRW", "23,658 KRW")
  const updatesBeforeSignRepair = fake.count("documents.update")
  await adapter.bootstrap()
  assert.equal(fake.count("documents.update"), updatesBeforeSignRepair + 1)
  assert.match(assets.text, /\| 순자산 \| \\-23,658 KRW \|/)

  assets.text = assets.text.replace("| 순자산 |", "| \\-순자산 |")
  const updatesBeforeNonnumericRepair = fake.count("documents.update")
  await adapter.bootstrap()
  assert.equal(fake.count("documents.update"), updatesBeforeNonnumericRepair + 1)
  assert.match(assets.text, /\| 순자산 \| \\-23,658 KRW \|/)
})

test("범위 물결표 escape만 동등하게 보고 단어 내부 Unicode underscore run을 보존한다", async () => {
  const { adapter, fake } = createAdapter()
  const handoff = validHandoff()
  handoff.accounts[0].label = "~~account__id cafe\u0301_id~~"
  handoff.opening_positions.push({
    ...structuredClone(handoff.opening_positions[0]),
    position_id: "main-reserve",
    value: {
      ...measured(10),
      observed_at: "2099-01-14T09:00:00+09:00",
    },
  })
  handoff.cashflow_horizon.payment_capacity.policy_available.amount += 10
  await adapter.writeHandoff(handoff)

  const assets = fake.documents.get(adapter.documentIds.assets)
  assert.match(assets.text, /~~account__id cafe\u0301_id~~/)
  assert.match(assets.text, / \\~ /)
  const updatesBeforeEquivalentBootstrap = fake.count("documents.update")
  await adapter.bootstrap()
  assert.equal(fake.count("documents.update"), updatesBeforeEquivalentBootstrap)

  assets.text = assets.text.replaceAll(
    "~~account__id cafe\u0301_id~~",
    "\\~\\~account__id cafe\u0301_id\\~\\~",
  )
  const updatesBeforeSyntaxRepair = fake.count("documents.update")
  await adapter.bootstrap()
  assert.equal(fake.count("documents.update"), updatesBeforeSyntaxRepair + 1)
  assert.match(assets.text, /~~account__id cafe\u0301_id~~/)
})

test("handoff와 event는 기존 원장에 replay된 뒤에만 원본을 commit한다", async () => {
  const { adapter, fake } = createAdapter()
  const handoff = validHandoff()
  await adapter.writeHandoff(handoff)
  const event = ledgerEvent("committed-event")
  await adapter.appendEvent(event)

  const handoffText = fake.documents.get(adapter.documentIds.handoff).text
  const incompatible = structuredClone(handoff)
  incompatible.accounts[0].account_id = "replacement"
  incompatible.opening_positions[0].account_id = "replacement"
  incompatible.opening_positions[0].position_id = "replacement-free"
  await assert.rejects(adapter.writeHandoff(incompatible), /unknown position: main-free/)
  assert.equal(fake.documents.get(adapter.documentIds.handoff).text, handoffText)
  assert.deepEqual(await adapter.readHandoff(), handoff)

  const indexText = fake.documents.get(adapter.documentIds.eventIndex).text
  const invalidEvent = ledgerEvent("invalid-position", {
    payload: { amount: 1, position_id: "missing-position" },
  })
  await assert.rejects(adapter.appendEvent(invalidEvent), /unknown position: missing-position/)
  assert.equal(fake.documents.has(adapter.eventDocumentId(invalidEvent.event_id)), false)
  assert.equal(fake.documents.get(adapter.documentIds.eventIndex).text, indexText)
  assert.deepEqual(await adapter.readEvents(), [event])
})

test("event append는 index 순서, pagination, retry 멱등성, conflict와 불변 문서를 보장한다", async () => {
  const { adapter, fake } = createAdapter()
  await adapter.writeHandoff(validHandoff())
  const inputs = Array.from({ length: 105 }, (_, index) => ledgerEvent(`event-${String(index).padStart(3, "0")}`))
  const before = structuredClone(inputs[0])
  for (const event of inputs) assert.equal((await adapter.appendEvent(event)).status, "accepted")
  assert.deepEqual(inputs[0], before)

  const eventDocuments = inputs.map((event) => fake.documents.get(adapter.eventDocumentId(event.event_id)))
  eventDocuments[0].createdAt = "2099-01-16T00:00:00.000Z"
  eventDocuments[1].createdAt = "2099-01-16T00:00:00.000Z"
  const read = await adapter.readEvents()
  assert.deepEqual(read.map((event) => event.event_id), inputs.map((event) => event.event_id))

  const listCalls = fake.calls.filter((call) => call.endpoint === "documents.list")
  assert.ok(listCalls.some((call) => call.payload.offset === 100))
  for (const call of listCalls) {
    assert.equal(call.payload.limit, 100)
    assert.equal(call.payload.collectionId, COLLECTION_ID)
    assert.equal(call.payload.parentDocumentId, adapter.documentIds.events)
    assert.deepEqual(call.payload.statusFilter, ["published", "draft", "archived"])
    assert.equal(call.payload.sort, "createdAt")
    assert.equal(call.payload.direction, "ASC")
    assert.equal(Object.hasOwn(call.payload, "filters"), false)
  }

  fake.maxInfoConcurrency = 0
  fake.setDelay("documents.info", 1)
  await adapter.readEvents()
  fake.setDelay("documents.info", 0)
  assert.ok(fake.maxInfoConcurrency >= 2)
  assert.ok(fake.maxInfoConcurrency <= 4)

  fake.maxInfoConcurrency = 0
  const firstId = adapter.eventDocumentId(inputs[0].event_id)
  fake.failInfoOnce(firstId)
  fake.setInfoDelay(firstId, 1)
  for (const event of inputs.slice(1, 4)) fake.setInfoDelay(adapter.eventDocumentId(event.event_id), 10)
  const failedRead = adapter.readEvents()
  const queuedRead = adapter.readEvents()
  await assert.rejects(failedRead, /targeted info failure/)
  await queuedRead
  assert.ok(fake.maxInfoConcurrency <= 4)

  fake.repeatListPage = true
  await assert.rejects(adapter.readEvents(), /repeated document ID/)
  fake.repeatListPage = false

  const updatesBefore = fake.count("documents.update")
  assert.equal((await adapter.appendEvent(inputs[0])).status, "duplicate")
  await assert.rejects(
    adapter.appendEvent({ ...inputs[0], payload: { ...inputs[0].payload, amount: 2 } }),
    /Outline (document|event) conflict/,
  )
  assert.equal(fake.count("documents.update"), updatesBefore)
})

test("createdAt 동률이 100개 경계를 지나도 index append 순서로 replay한다", async () => {
  const { adapter, fake } = createAdapter()
  await adapter.writeHandoff(replayHandoff())
  const events = orderedReplayEvents()
  for (const event of events) assert.equal((await adapter.appendEvent(event)).status, "accepted")

  const tiedAt = "2099-01-16T00:00:00.000Z"
  fake.documents.get(adapter.documentIds.eventIndex).createdAt = tiedAt
  for (const event of events) fake.documents.get(adapter.eventDocumentId(event.event_id)).createdAt = tiedAt
  fake.reverseListResults = true

  const stored = await adapter.readEvents()
  assert.deepEqual(stored.map((event) => event.event_id), events.map((event) => event.event_id))
  assert.ok(fake.calls.some((call) => {
    return call.endpoint === "documents.list"
      && call.payload.parentDocumentId === adapter.documentIds.events
      && call.payload.offset === 100
  }))
  const state = projectLedger(replayOpening(), stored)
  assert.equal(state.positions["main-free"].amount, 100)
  assert.equal(state.liabilities.loan.principal, 0)
  assert.equal(state.totals.expenses, 100)
})

test("ambiguous event create는 documents.info로 reconciliation한다", async () => {
  const { adapter, fake } = createAdapter()
  await adapter.writeHandoff(validHandoff())
  fake.ambiguousOnce("documents.create")
  const event = ledgerEvent("ambiguous-event")
  const result = await adapter.appendEvent(event)
  assert.equal(result.status, "accepted")
  assert.deepEqual((await adapter.readEvents()), [event])
  assert.equal((await adapter.appendEvent(event)).status, "duplicate")
  assert.equal(fake.calls.filter((call) => {
    return call.endpoint === "documents.update" && call.payload.id === adapter.documentIds.eventIndex
  }).length, 1)
})

test("event 재시도는 원본 index를 유지하면서 사람용 문서를 복구한다", async () => {
  const { adapter, fake } = createAdapter()
  await adapter.writeHandoff(validHandoff())
  const event = ledgerEvent("presentation-retry")
  await adapter.appendEvent(event)

  const month = fake.documents.get(adapter.monthDocumentId("2099-01"))
  month.text = "# stale presentation"
  const indexUpdatesBefore = fake.calls.filter((call) => {
    return call.endpoint === "documents.update" && call.payload.id === adapter.documentIds.eventIndex
  }).length

  assert.equal((await adapter.appendEvent(event)).status, "duplicate")
  assert.match(month.text, /^# 2099년 1월 수입·지출/)
  assert.equal(fake.calls.filter((call) => {
    return call.endpoint === "documents.update" && call.payload.id === adapter.documentIds.eventIndex
  }).length, indexUpdatesBefore)
})

test("ambiguous index update는 목표 manifest를 재조회해 commit을 확인한다", async () => {
  const { adapter, fake } = createAdapter()
  await adapter.writeHandoff(validHandoff())
  fake.ambiguousOnce("documents.update")
  const event = ledgerEvent("ambiguous-index")
  assert.equal((await adapter.appendEvent(event)).status, "accepted")
  assert.deepEqual(await adapter.readEvents(), [event])
})

test("event와 notification index는 moved, deleted, orphan과 index 유실을 감지하고 retry를 복구한다", async () => {
  const cases = [
    {
      append: (adapter, value) => adapter.appendEvent(value),
      indexId: (adapter) => adapter.documentIds.eventIndex,
      read: (adapter) => adapter.readEvents(),
      recordId: (adapter, value) => adapter.eventDocumentId(value.event_id),
      retryStatus: "duplicate",
      requiresHandoff: true,
      value: ledgerEvent("integrity-event"),
    },
    {
      append: (adapter, value) => adapter.appendNotification(value),
      indexId: (adapter) => adapter.documentIds.notificationIndex,
      read: (adapter) => adapter.readNotifications(),
      recordId: (adapter, value) => adapter.notificationDocumentId(value.period_id),
      retryStatus: "already_notified",
      value: { created_at: "2099-01-18T20:00:00+09:00", period_id: "integrity-period" },
    },
  ]

  for (const scenario of cases) {
    const moved = createAdapter()
    if (scenario.requiresHandoff) await moved.adapter.writeHandoff(validHandoff())
    await scenario.append(moved.adapter, scenario.value)
    moved.fake.documents.get(scenario.recordId(moved.adapter, scenario.value)).parentDocumentId = moved.adapter.documentIds.root
    await assert.rejects(scenario.read(moved.adapter), /unexpected parent/)

    const deleted = createAdapter()
    if (scenario.requiresHandoff) await deleted.adapter.writeHandoff(validHandoff())
    await scenario.append(deleted.adapter, scenario.value)
    deleted.fake.documents.delete(scenario.recordId(deleted.adapter, scenario.value))
    await assert.rejects(scenario.read(deleted.adapter), /missing or deleted/)

    const crashed = createAdapter()
    if (scenario.requiresHandoff) await crashed.adapter.writeHandoff(validHandoff())
    else await crashed.adapter.bootstrap()
    crashed.fake.failHttpOnce("documents.update")
    await assert.rejects(scenario.append(crashed.adapter, scenario.value), /HTTP 500/)
    await assert.rejects(scenario.read(crashed.adapter), /unindexed orphan/)
    assert.equal((await scenario.append(crashed.adapter, scenario.value)).status, scenario.retryStatus)
    assert.deepEqual(await scenario.read(crashed.adapter), [scenario.value])

    const lostIndex = createAdapter()
    if (scenario.requiresHandoff) await lostIndex.adapter.writeHandoff(validHandoff())
    await scenario.append(lostIndex.adapter, scenario.value)
    lostIndex.fake.documents.delete(scenario.indexId(lostIndex.adapter))
    await assert.rejects(lostIndex.adapter.bootstrap(), /unindexed orphan/)
  }
})

test("notification은 period별로 원본 기록을 보존하며 멱등 append한다", async () => {
  const { adapter, fake } = createAdapter()
  const notification = {
    created_at: "2099-01-18T20:00:00+09:00",
    period_id: "2099-W03",
  }
  assert.equal((await adapter.appendNotification(notification)).status, "created")
  const updatesAfterCreate = fake.count("documents.update")
  assert.equal((await adapter.appendNotification(notification)).status, "already_notified")
  const retry = await adapter.appendNotification({
    ...notification,
    created_at: "2099-01-19T20:00:00+09:00",
  })
  assert.equal(retry.status, "already_notified")
  assert.deepEqual(retry.notification, notification)
  assert.deepEqual(await adapter.readNotifications(), [notification])
  assert.equal(fake.count("documents.update"), updatesAfterCreate)
})

test("같은 process의 adapter instance들은 동일 external_id append를 직렬화한다", async () => {
  const fake = new FakeOutline()
  fake.setDelay("documents.create", 2)
  const firstAdapter = createAdapter(fake).adapter
  const secondAdapter = createAdapter(fake, { baseUrl: `${BASE_URL}/` }).adapter
  await firstAdapter.writeHandoff(validHandoff())
  const first = ledgerEvent("external-first", {
    source: { external_id: "transaction-1", kind: "api", system: "provider" },
  })
  const second = ledgerEvent("external-second", {
    source: { external_id: "transaction-1", kind: "api", system: "provider" },
  })

  const [firstResult, secondResult] = await Promise.all([
    firstAdapter.appendEvent(first),
    secondAdapter.appendEvent(second),
  ])
  assert.equal(firstResult.status, "accepted")
  assert.equal(secondResult.status, "duplicate")
  assert.equal(secondResult.existing_event_id, first.event_id)
  assert.deepEqual(await firstAdapter.readEvents(), [first])
  assert.equal(fake.maxMutationConcurrency, 1)
})

test("같은 pending target의 동시 superseder는 하나만 index에 append한다", async () => {
  const fake = new FakeOutline()
  const firstAdapter = createAdapter(fake).adapter
  const secondAdapter = createAdapter(fake).adapter
  await firstAdapter.writeHandoff(validHandoff())
  const source = { external_id: "pending-transaction", kind: "api", system: "provider" }
  const pending = ledgerEvent("pending", { source, verification_status: "pending" })
  await firstAdapter.appendEvent(pending)
  const first = ledgerEvent("confirmation-first", { source, supersedes_event_id: pending.event_id })
  const second = ledgerEvent("confirmation-second", { source, supersedes_event_id: pending.event_id })

  const [firstResult, secondResult] = await Promise.all([
    firstAdapter.appendEvent(first),
    secondAdapter.appendEvent(second),
  ])
  assert.equal(firstResult.status, "accepted")
  assert.equal(secondResult.status, "duplicate")
  assert.equal(secondResult.existing_event_id, first.event_id)
  assert.deepEqual(
    (await firstAdapter.readEvents()).map((event) => event.event_id),
    [pending.event_id, first.event_id],
  )
})

test("fixed document write도 adapter instance 사이에서 직렬화한다", async () => {
  const fake = new FakeOutline()
  const firstAdapter = createAdapter(fake).adapter
  const secondAdapter = createAdapter(fake).adapter
  await firstAdapter.writeSnapshot({ sequence: 0 })
  fake.maxMutationConcurrency = 0
  fake.setDelay("documents.update", 2)

  await Promise.all([
    firstAdapter.writeSnapshot({ sequence: 1 }),
    secondAdapter.writeSnapshot({ sequence: 2 }),
  ])
  assert.deepEqual(await firstAdapter.readSnapshot(), { sequence: 2 })
  assert.equal(fake.maxMutationConcurrency, 1)
})

test("snapshot은 replace round trip하고 ambiguous update를 reconciliation한다", async () => {
  const { adapter, fake } = createAdapter()
  await adapter.writeHandoff(validHandoff())
  const first = { active_event_ids: [], totals: { total_assets: 100_000 } }
  await adapter.writeSnapshot(first)
  assert.deepEqual(await adapter.readSnapshot(), first)

  fake.ambiguousOnce("documents.update")
  const second = { active_event_ids: ["event-1"], totals: { total_assets: 99_000 } }
  await adapter.writeSnapshot(second)
  const updatesAfterWrite = fake.count("documents.update")
  assert.deepEqual(await adapter.readSnapshot(), second)
  assert.equal(fake.count("documents.update"), updatesAfterWrite)
  const rawDocument = fake.documents.get(adapter.documentIds.snapshot)
  const assetsDocument = fake.documents.get(adapter.documentIds.assets)
  assert.match(rawDocument.text, /^```json\n/)
  assert.match(assetsDocument.text, /^# 개인 자산 목록\n/)
  assert.match(assetsDocument.text, /\| 현금성 자산 \| 1,000,000 KRW \|/)
  assert.doesNotMatch(assetsDocument.text, /```json|event-1|active_event_ids/)
  await assert.rejects(adapter.writeSnapshot({ auth_token: "leak" }), /snapshot.auth_token is forbidden/)
  for (const invalid of [null, [], "snapshot"]) {
    await assert.rejects(adapter.writeSnapshot(invalid), /snapshot must be an object/)
  }

  fake.documents.get(adapter.documentIds.snapshot).text = machineEnvelope(
    "asset-management-snapshot",
    "snapshot",
    '{"auth_token":"leak"}',
  )
  await assert.rejects(adapter.readSnapshot(), /snapshot.auth_token is forbidden/)
})

test("steady-state round trip은 원본을 바꾸지 않고 index 순서로 읽기용 현재 상태를 재생한다", async () => {
  const fake = new FakeOutline()
  const adapter = createAdapter(fake).adapter
  const handoff = validHandoff()
  const events = [ledgerEvent("event-first"), ledgerEvent("event-second", {
    payload: { amount: 2, position_id: "main-free" },
  })]
  const notifications = [
    { created_at: "2099-01-18T20:00:00+09:00", period_id: "2099-W03" },
    { created_at: "2099-01-25T20:00:00+09:00", period_id: "2099-W04" },
  ]
  const snapshot = { active_event_ids: ["snapshot-only"], totals: { total_assets: 7 } }

  await adapter.writeHandoff(handoff)
  for (const event of events) await adapter.appendEvent(event)
  for (const notification of notifications) await adapter.appendNotification(notification)
  await adapter.writeSnapshot(snapshot)

  const ids = adapter.documentIds
  const rawIds = [
    ids.root,
    ids.events,
    ids.eventIndex,
    ids.notifications,
    ids.notificationIndex,
    ids.handoff,
    ids.snapshot,
    ...events.map((event) => adapter.eventDocumentId(event.event_id)),
    ...notifications.map((notification) => adapter.notificationDocumentId(notification.period_id)),
  ]
  const rawTexts = new Map(rawIds.map((id) => [id, fake.documents.get(id).text]))

  await adapter.bootstrap()

  assert.equal(ids.root, deterministicOutlineDocumentId(COLLECTION_ID, "root"))
  assert.equal(ids.handoff, deterministicOutlineDocumentId(COLLECTION_ID, "fixed:handoff"))
  assert.equal(ids.snapshot, deterministicOutlineDocumentId(COLLECTION_ID, "fixed:snapshot"))
  assert.equal(fake.documents.get(ids.root).parentDocumentId, ids.rawRoot)
  for (const [id, text] of rawTexts) assert.equal(fake.documents.get(id).text, text)
  assert.deepEqual(await adapter.readHandoff(), handoff)
  assert.deepEqual(await adapter.readEvents(), events)
  assert.deepEqual(await adapter.readNotifications(), notifications)
  assert.deepEqual(await adapter.readSnapshot(), snapshot)
  assert.match(fake.documents.get(ids.principles).text, /^# 개인화된 자산관리 원칙\n/)
  assert.match(fake.documents.get(ids.assets).text, /^# 개인 자산 목록\n/)
  assert.match(fake.documents.get(ids.overview).text, /\| 순자산 \| 999,997 KRW \|/)
  assert.match(fake.documents.get(ids.assets).text, /\| 현금성 자산 \| 999,997 KRW \|/)
  const yearId = adapter.yearDocumentId("2099")
  const monthId = adapter.monthDocumentId("2099-01")
  assert.equal(fake.documents.get(yearId).parentDocumentId, ids.monthly)
  assert.equal(fake.documents.get(monthId).parentDocumentId, yearId)
  assert.match(fake.documents.get(monthId).text, /\| 발생 \| 지출 \| 3 KRW \|/)
  assert.match(fake.documents.get(monthId).text, /\| 현금 \| 유출 \| 3 KRW \|/)
  assert.doesNotMatch(fake.documents.get(ids.overview).text, /지급 가능/)
  assert.doesNotMatch(fake.documents.get(ids.assets).text, /snapshot-only|event-first|event-second/)
  assert.doesNotMatch(fake.documents.get(ids.principles).text, /```json/)
  assert.doesNotMatch(fake.documents.get(ids.assets).text, /```json/)
})

test("malformed, wrong kind/version/digest와 tampered location 문서를 거부한다", async () => {
  const cases = [
    ["malformed", (text) => `${text}\nnot allowed`, /malformed machine envelope/],
    [
      "wrong-kind",
      (text) => text.replace("asset-management-event", "asset-management-notification"),
      /wrong kind/,
    ],
    ["wrong-version", (text) => text.replace('"version":1', '"version":2'), /unsupported envelope version/],
    ["wrong-digest", (text) => text.replace('"amount":1', '"amount":2'), /digest mismatch/],
    [
      "duplicate-key",
      (text) => text.replace('"version":1}', '"version":1,"version":1}'),
      /canonical encoding/,
    ],
  ]
  for (const [name, mutate, pattern] of cases) {
    const { adapter, fake } = createAdapter()
    await adapter.writeHandoff(validHandoff())
    const event = ledgerEvent(name)
    await adapter.appendEvent(event)
    const document = fake.documents.get(adapter.eventDocumentId(name))
    document.text = mutate(document.text)
    await assert.rejects(adapter.readEvents(), pattern)
  }

  const location = createAdapter()
  await location.adapter.writeHandoff(validHandoff())
  const event = ledgerEvent("moved")
  await location.adapter.appendEvent(event)
  location.fake.documents.get(location.adapter.eventDocumentId(event.event_id)).parentDocumentId = location.adapter.documentIds.root
  await assert.rejects(location.adapter.appendEvent(event), /unexpected parent/)

  const archived = createAdapter()
  await archived.adapter.writeHandoff(validHandoff())
  const archivedEvent = ledgerEvent("archived")
  await archived.adapter.appendEvent(archivedEvent)
  archived.fake.documents.get(archived.adapter.eventDocumentId(archivedEvent.event_id)).archivedAt = "2099-01-16T00:00:00.000Z"
  await assert.rejects(archived.adapter.readEvents(), /must be published and not archived/)
})

test("깊은 open payload도 call stack 소진 없이 round trip한다", async () => {
  const { adapter } = createAdapter()
  await adapter.writeHandoff(validHandoff())
  const metadata = {}
  let cursor = metadata
  for (let depth = 0; depth < 10_001; depth += 1) {
    cursor.child = {}
    cursor = cursor.child
  }
  const event = ledgerEvent("deep-metadata", {
    payload: { amount: 1, metadata, position_id: "main-free" },
  })
  assert.equal((await adapter.appendEvent(event)).status, "accepted")
  const [stored] = await adapter.readEvents()
  cursor = stored.payload.metadata
  for (let depth = 0; depth < 10_001; depth += 1) cursor = cursor.child
  assert.deepEqual(cursor, {})
})

test("deterministic ID는 collection과 key에 종속된 UUIDv4다", () => {
  const first = deterministicOutlineDocumentId(COLLECTION_ID, "event:test")
  const retry = deterministicOutlineDocumentId(COLLECTION_ID, "event:test")
  const other = deterministicOutlineDocumentId(COLLECTION_ID, "event:other")
  assert.equal(first, retry)
  assert.equal(first, "8daf629f-ba9f-4225-a6dc-35c4ddd3e160")
  assert.notEqual(first, other)
  assert.equal(first[14], "4")
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})
