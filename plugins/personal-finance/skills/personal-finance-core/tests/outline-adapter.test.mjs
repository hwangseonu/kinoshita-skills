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
          text: payload.text,
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
          text: payload.text,
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
  assert.equal(fake.count("documents.create"), 5)
  await adapter.bootstrap()
  assert.equal(fake.count("documents.create"), 5)
  for (const id of Object.values(ids)) {
    assert.match(id, /^[0-9a-f-]{36}$/)
    assert.equal(id[14], "4")
  }
  assert.equal(fake.documents.get(ids.root).parentDocumentId, null)
  assert.equal(fake.documents.get(ids.root).title, "자산관리 시스템")
  assert.equal(fake.documents.get(ids.events).parentDocumentId, ids.root)
  assert.equal(fake.documents.get(ids.notifications).parentDocumentId, ids.root)
  assert.equal(fake.documents.get(ids.eventIndex).parentDocumentId, ids.events)
  assert.equal(fake.documents.get(ids.notificationIndex).parentDocumentId, ids.notifications)

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

  const changed = structuredClone(handoff)
  changed.profile.household_notes = "합성 가구 정보"
  await adapter.writeHandoff(changed)
  assert.deepEqual(await adapter.readHandoff(), changed)
  assert.equal(fake.count("documents.update"), 1)

  const invalid = structuredClone(handoff)
  delete invalid.profile.currency
  await assert.rejects(adapter.writeHandoff(invalid), /handoff.profile.currency is required/)
  assert.equal([...fake.documents.values()].some((document) => document.text.includes(API_TOKEN)), false)
})

test("event append는 index 순서, pagination, retry 멱등성, conflict와 불변 문서를 보장한다", async () => {
  const { adapter, fake } = createAdapter()
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
  await adapter.bootstrap()
  fake.ambiguousOnce("documents.create")
  const event = ledgerEvent("ambiguous-event")
  const result = await adapter.appendEvent(event)
  assert.equal(result.status, "accepted")
  assert.deepEqual((await adapter.readEvents()), [event])
  assert.equal((await adapter.appendEvent(event)).status, "duplicate")
  assert.equal(fake.count("documents.update"), 1)
})

test("ambiguous index update는 목표 manifest를 재조회해 commit을 확인한다", async () => {
  const { adapter, fake } = createAdapter()
  await adapter.bootstrap()
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
    await scenario.append(moved.adapter, scenario.value)
    moved.fake.documents.get(scenario.recordId(moved.adapter, scenario.value)).parentDocumentId = moved.adapter.documentIds.root
    await assert.rejects(scenario.read(moved.adapter), /unexpected parent/)

    const deleted = createAdapter()
    await scenario.append(deleted.adapter, scenario.value)
    deleted.fake.documents.delete(scenario.recordId(deleted.adapter, scenario.value))
    await assert.rejects(scenario.read(deleted.adapter), /missing or deleted/)

    const crashed = createAdapter()
    await crashed.adapter.bootstrap()
    crashed.fake.failHttpOnce("documents.update")
    await assert.rejects(scenario.append(crashed.adapter, scenario.value), /HTTP 500/)
    await assert.rejects(scenario.read(crashed.adapter), /unindexed orphan/)
    assert.equal((await scenario.append(crashed.adapter, scenario.value)).status, scenario.retryStatus)
    assert.deepEqual(await scenario.read(crashed.adapter), [scenario.value])

    const lostIndex = createAdapter()
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
  const first = { active_event_ids: [], totals: { total_assets: 100_000 } }
  await adapter.writeSnapshot(first)
  assert.deepEqual(await adapter.readSnapshot(), first)

  fake.ambiguousOnce("documents.update")
  const second = { active_event_ids: ["event-1"], totals: { total_assets: 99_000 } }
  await adapter.writeSnapshot(second)
  assert.deepEqual(await adapter.readSnapshot(), second)
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
    const event = ledgerEvent(name)
    await adapter.appendEvent(event)
    const document = fake.documents.get(adapter.eventDocumentId(name))
    document.text = mutate(document.text)
    await assert.rejects(adapter.readEvents(), pattern)
  }

  const location = createAdapter()
  const event = ledgerEvent("moved")
  await location.adapter.appendEvent(event)
  location.fake.documents.get(location.adapter.eventDocumentId(event.event_id)).parentDocumentId = location.adapter.documentIds.root
  await assert.rejects(location.adapter.appendEvent(event), /unexpected parent/)

  const archived = createAdapter()
  const archivedEvent = ledgerEvent("archived")
  await archived.adapter.appendEvent(archivedEvent)
  archived.fake.documents.get(archived.adapter.eventDocumentId(archivedEvent.event_id)).archivedAt = "2099-01-16T00:00:00.000Z"
  await assert.rejects(archived.adapter.readEvents(), /must be published and not archived/)
})

test("깊은 open payload도 call stack 소진 없이 round trip한다", async () => {
  const { adapter } = createAdapter()
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
