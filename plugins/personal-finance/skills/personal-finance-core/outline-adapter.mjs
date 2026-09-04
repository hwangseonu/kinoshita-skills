import { createHash } from "node:crypto"
import { assertValidHandoff, handoffToOpening } from "./handoff.mjs"
import {
  findForbiddenPaths,
  isIsoDateTime,
} from "./validation.mjs"
import {
  registerEvent,
  registerPeriodNotification,
  projectLedger,
  validateEvent,
} from "./ledger.mjs"

const ENVELOPE_VERSION = 1
const INDEX_VERSION = 1
const INFO_CONCURRENCY = 4
const PAGE_LIMIT = 100
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OPERATION_QUEUES = new Map()

const RAW_ROOT_MARKDOWN = [
  "# 원본 JSON",
  "",
  "이 문서 아래에는 재생과 무결성 검증에 사용하는 기계 전용 JSON 문서가 있어요.",
  "",
  "원본 문서를 직접 편집하거나 이동하지 마세요.",
].join("\n")

const EVENT_TYPE_LABELS = {
  account_transfer: "계좌 이체",
  fund_allocation: "목적 자금 배정",
  cash_purchase: "현금·계좌 구매",
  card_purchase: "카드 구매",
  installment_purchase: "할부 구매",
  card_payment: "카드 결제",
  debt_draw: "대출 실행",
  liability_transfer: "부채 이동",
  finance_charge: "이자·수수료 부과",
  debt_payment: "부채 상환",
  transfer_fee: "이체 수수료",
  refund: "환불",
  card_authorization_cancelled: "카드 승인 취소",
  event_cancelled: "거래 취소",
  income_received: "수입",
  points_earned: "포인트 적립",
  points_used: "포인트 사용",
  points_expired: "포인트 소멸",
  points_cash_out: "포인트 현금화",
  cashback_deposit: "캐시백 입금",
  plan_created: "계획",
  reservation_created: "예약",
  conditional_commitment_created: "조건부 의무",
  firm_commitment_created: "확정 의무",
}

const EVENT_GROUP_LABELS = {
  account_transfer: "이체",
  fund_allocation: "자금 배정",
  cash_purchase: "소비",
  card_purchase: "소비",
  installment_purchase: "소비",
  card_payment: "카드 결제",
  debt_draw: "부채",
  liability_transfer: "부채",
  finance_charge: "금융 비용",
  debt_payment: "부채 상환",
  transfer_fee: "금융 비용",
  refund: "환불",
  card_authorization_cancelled: "취소",
  event_cancelled: "취소",
  income_received: "수입",
  points_earned: "포인트",
  points_used: "포인트",
  points_expired: "포인트",
  points_cash_out: "수입",
  cashback_deposit: "수입",
  plan_created: "계획",
  reservation_created: "계획",
  conditional_commitment_created: "계획",
  firm_commitment_created: "계획",
}

const LIABILITY_TYPE_LABELS = {
  credit_card: "일반 카드",
  installment: "할부",
  revolving: "리볼빙",
  cash_advance: "현금서비스",
  card_loan: "카드론",
  student_loan: "학자금 대출",
  general_debt: "기타 부채",
}

const LIQUIDITY_LABELS = {
  immediate: "즉시 사용 가능",
  restricted: "사용 제한",
  illiquid: "비유동",
}

const VALUE_KIND_LABELS = {
  exact: "확정",
  estimated: "예상",
  upper_bound: "상한",
  variable: "변동",
  unbilled: "미청구",
}

const POINT_BALANCE_EVENT_TYPES = new Set(["points_earned", "points_used", "points_expired"])

const DOCUMENTS = {
  overview: {
    idKey: "view:root",
    title: "자산관리 시스템",
  },
  principles: {
    idKey: "view:handoff",
    title: "개인화된 자산관리 원칙",
  },
  assets: {
    idKey: "view:current-state",
    title: "개인 자산 목록",
  },
  recurringFlows: {
    idKey: "view:recurring-flows",
    title: "고정 수입·지출",
  },
  monthly: {
    idKey: "view:monthly",
    title: "월별 수입·지출",
  },
  rawRoot: {
    idKey: "raw:root",
    title: "원본 JSON (기계 전용)",
  },
  root: {
    idKey: "root",
    key: "root",
    kind: "asset-management-system-root",
    title: "시스템 manifest",
  },
  events: {
    idKey: "container:events",
    key: "events",
    kind: "asset-management-container",
    title: "이벤트",
  },
  notifications: {
    idKey: "container:notifications",
    key: "notifications",
    kind: "asset-management-container",
    title: "알림",
  },
  eventIndex: {
    idKey: "index:events",
    key: "events-index",
    kind: "asset-management-index",
    title: "이벤트 인덱스",
  },
  notificationIndex: {
    idKey: "index:notifications",
    key: "notifications-index",
    kind: "asset-management-index",
    title: "알림 인덱스",
  },
  handoff: {
    idKey: "fixed:handoff",
    key: "handoff",
    kind: "asset-management-handoff",
    title: "인계 데이터",
  },
  snapshot: {
    idKey: "fixed:snapshot",
    key: "snapshot",
    kind: "asset-management-snapshot",
    title: "파생 상태",
  },
}

const INDEXED_COLLECTIONS = {
  events: {
    acceptedStatus: "accepted",
    container: "events",
    index: "eventIndex",
    recordIdPrefix: "event",
    recordKeyField: "event_id",
    recordKind: "asset-management-event",
    resultField: "event",
    recordTitlePrefix: "이벤트",
  },
  notifications: {
    acceptedStatus: "created",
    container: "notifications",
    index: "notificationIndex",
    recordIdPrefix: "notification",
    recordKeyField: "period_id",
    recordKind: "asset-management-notification",
    resultField: "notification",
    recordTitlePrefix: "알림",
  },
}

function enqueueOperation(key, operation) {
  const previous = OPERATION_QUEUES.get(key) ?? Promise.resolve()
  const result = previous.then(operation)
  const settled = result.catch(() => {})
  OPERATION_QUEUES.set(key, settled)
  return result.finally(() => {
    if (OPERATION_QUEUES.get(key) === settled) OPERATION_QUEUES.delete(key)
  })
}

async function mapWithConcurrency(items, mapper) {
  const results = new Array(items.length)
  let firstError
  let nextIndex = 0
  async function worker() {
    while (!firstError && nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = await mapper(items[index], index)
      } catch (error) {
        firstError ??= error
      }
    }
  }
  const workerCount = Math.min(INFO_CONCURRENCY, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  if (firstError) throw firstError
  return results
}

function stableJson(value) {
  const ancestors = new WeakSet()
  const output = []
  const stack = [{ type: "value", value }]
  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame.type === "text") {
      output.push(frame.text)
      continue
    }
    if (frame.type === "leave") {
      ancestors.delete(frame.value)
      output.push(frame.text)
      continue
    }
    const current = frame.value
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      output.push(JSON.stringify(current))
      continue
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("Outline data must contain only finite JSON numbers")
      output.push(JSON.stringify(current))
      continue
    }
    if (!current || typeof current !== "object") {
      throw new Error("Outline data must be JSON-serializable")
    }
    if (ancestors.has(current)) throw new Error("Outline data must not contain cycles")
    const array = Array.isArray(current)
    if (!array) {
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Outline data must contain only plain JSON objects")
      }
    }
    const keys = array
      ? Array.from({ length: current.length }, (_, index) => index)
      : Object.keys(current).sort()
    if (keys.length === 0) {
      output.push(array ? "[]" : "{}")
      continue
    }
    ancestors.add(current)
    output.push(array ? "[" : "{")
    stack.push({ text: array ? "]" : "}", type: "leave", value: current })
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]
      let child = current[key]
      if (array && !Object.hasOwn(current, key)) child = null
      stack.push({ type: "value", value: child })
      stack.push({
        text: `${index === 0 ? "" : ","}${array ? "" : `${JSON.stringify(key)}:`}`,
        type: "text",
      })
    }
  }
  return output.join("")
}

function cloneJson(value) {
  return JSON.parse(stableJson(value))
}

function digestEnvelope(kind, key, data) {
  return createHash("sha256")
    .update(stableJson({ data, key, kind, version: ENVELOPE_VERSION }))
    .digest("hex")
}

function renderEnvelope(kind, key, data) {
  const envelope = {
    data,
    digest: digestEnvelope(kind, key, data),
    key,
    kind,
    version: ENVELOPE_VERSION,
  }
  return `\`\`\`json\n${stableJson(envelope)}\n\`\`\``
}

function parseEnvelope(text, expectedKind, expectedKey = undefined) {
  if (typeof text !== "string") throw new Error("Outline document is missing Markdown text")
  const match = /^```json\n([\s\S]+)\n```\n?$/.exec(text)
  if (!match) throw new Error("Outline document has a malformed machine envelope")
  let envelope
  try {
    envelope = JSON.parse(match[1])
  } catch (error) {
    throw new Error(`Outline document contains invalid envelope JSON: ${error.message}`)
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("Outline document envelope must be an object")
  }
  const fields = Object.keys(envelope).sort()
  if (fields.join(",") !== "data,digest,key,kind,version") {
    throw new Error("Outline document envelope has unexpected fields")
  }
  if (stableJson(envelope) !== match[1]) {
    throw new Error("Outline document envelope JSON must use canonical encoding")
  }
  if (envelope.kind !== expectedKind) {
    throw new Error(`Outline document has wrong kind: expected ${expectedKind}`)
  }
  if (envelope.version !== ENVELOPE_VERSION) {
    throw new Error(`Outline document has unsupported envelope version: ${envelope.version}`)
  }
  if (typeof envelope.key !== "string" || envelope.key.length === 0) {
    throw new Error("Outline document envelope key must be a non-empty string")
  }
  if (expectedKey !== undefined && envelope.key !== expectedKey) {
    throw new Error(`Outline document has wrong key: expected ${expectedKey}`)
  }
  const expectedDigest = digestEnvelope(envelope.kind, envelope.key, envelope.data)
  if (envelope.digest !== expectedDigest) throw new Error("Outline document envelope digest mismatch")
  return { data: envelope.data, key: envelope.key }
}

function uuidFromDigestInput(input) {
  const bytes = createHash("sha256").update(input).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function deterministicOutlineDocumentId(collectionId, key) {
  return uuidFromDigestInput(`asset-management:outline\0${collectionId.toLowerCase()}\0${key}`)
}

function assertSafeData(value, label) {
  const forbiddenPaths = findForbiddenPaths(value, label)
  if (forbiddenPaths.length > 0) throw new Error(`${forbiddenPaths[0]} is forbidden`)
  return value
}

function assertSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("snapshot must be an object")
  }
  const prototype = Object.getPrototypeOf(snapshot)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("snapshot must be a plain object")
  }
  return assertSafeData(snapshot, "snapshot")
}

function assertNotification(notification) {
  if (!notification || typeof notification !== "object" || Array.isArray(notification)) {
    throw new Error("notification must be an object")
  }
  registerPeriodNotification([], notification)
  if (notification.created_at !== undefined && !isIsoDateTime(notification.created_at)) {
    throw new Error("notification.created_at must be an ISO date-time")
  }
  assertSafeData(notification, "notification")
  return notification
}

function sameData(left, right) {
  return stableJson(left) === stableJson(right)
}

function canonicalPresentationTableLine(line) {
  if (!line.startsWith("|") || !line.endsWith("|")) return line
  const cells = line.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim())
  if (cells.length < 2) return line
  const separator = cells.every((cell) => /^:?-{3,}:?$/.test(cell))
  const canonicalCells = cells.map((cell) => {
    if (separator) {
      return `${cell.startsWith(":") ? ":" : ""}---${cell.endsWith(":") ? ":" : ""}`
    }
    return cell.replace(/^\\([+-])(?=\d)/, "$1")
  })
  // NUL keeps this internal token distinct from every valid Markdown table line.
  return `|\0${JSON.stringify(canonicalCells)}`
}

function canonicalPresentationMarkdown(text) {
  if (typeof text !== "string") return text
  const lines = text.split("\n")
    .map((line) => line.replace(/(?<=\s)\\~(?=\s)/g, "~"))
    .map(canonicalPresentationTableLine)
  for (let start = 0; start < lines.length;) {
    if (!/^(\s*)[-*] /.test(lines[start])) {
      start += 1
      continue
    }
    let end = start
    const markers = new Set()
    while (end < lines.length) {
      const match = /^(\s*)([-*]) /.exec(lines[end])
      if (!match) break
      markers.add(match[2])
      end += 1
    }
    if (markers.size === 1) {
      for (let index = start; index < end; index += 1) {
        lines[index] = lines[index].replace(/^(\s*)- /, "$1* ")
      }
    }
    start = end
  }
  const output = []
  const plainText = (line) => line.length > 0
    && !/^(?:#|>|[*+-] |\d+\. |```|\|)/.test(line)
  for (const line of lines) {
    const previous = output.at(-1)
    if (plainText(previous ?? "") && plainText(line)) output[output.length - 1] += ` ${line}`
    else output.push(line)
  }
  return output.join("\n")
}

function samePresentationMarkdown(left, right) {
  if (left === right) return true
  return canonicalPresentationMarkdown(left) === canonicalPresentationMarkdown(right)
}

function escapeMarkdown(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replace(/([`*[\]])/g, "\\$1")
    .replace(/_+/g, (underscores, offset, source) => {
      const before = source.slice(Math.max(0, offset - 2), offset)
      const after = source.slice(offset + underscores.length, offset + underscores.length + 2)
      if (/[\p{L}\p{N}\p{M}]$/u.test(before) && /^[\p{L}\p{N}\p{M}]/u.test(after)) return underscores
      return underscores.replaceAll("_", "\\_")
    })
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "기록 없음"
  const [integer, fraction] = String(value).split(".")
  const sign = integer.startsWith("-") ? "-" : ""
  const digits = sign ? integer.slice(1) : integer
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${sign}${grouped}${fraction === undefined ? "" : `.${fraction}`}`
}

function formatMoney(value, currency) {
  return `${formatNumber(value)} ${currency}`
}

function formatSignedMoney(value, currency) {
  if (!Number.isFinite(value)) return "기록 없음"
  return `${value > 0 ? "+" : ""}${formatMoney(value, currency)}`
}

function renderTable(headers, rows, emptyMessage) {
  if (rows.length === 0) return emptyMessage
  return [
    `| ${headers.map(escapeMarkdown).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdown).join(" | ")} |`),
  ].join("\n")
}

function isMonthlyPeriodId(value) {
  return typeof value === "string" && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)
}

function dateParts(value, timeZone) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  let formatter
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      month: "2-digit",
      timeZone,
      year: "numeric",
    })
  } catch {
    return null
  }
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter(({ type }) => new Set(["year", "month", "day"]).has(type))
      .map(({ type, value: part }) => [type, part]),
  )
}

function periodIdForDateTime(value, timeZone) {
  const parts = dateParts(value, timeZone)
  return parts ? `${parts.year}-${parts.month}` : null
}

function formatDate(value, timeZone) {
  const parts = dateParts(value, timeZone)
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : "기록 없음"
}

function periodTitle(periodId) {
  if (!isMonthlyPeriodId(periodId)) return periodId
  const [year, month] = periodId.split("-")
  return `${year}년 ${Number(month)}월`
}

function measuredTotal(values) {
  return values.reduce((total, value) => total + (value?.amount ?? 0), 0)
}

function measuredObservation(values) {
  const observed = values
    .map((value) => value?.observed_at)
    .filter((value) => typeof value === "string")
    .sort()
  if (observed.length === 0) return "기록 없음"
  if (observed[0] === observed.at(-1)) return observed[0]
  return `${observed[0]} ~ ${observed.at(-1)}`
}

function nextReview(values) {
  return values
    .map((value) => value?.next_review_at)
    .filter((value) => typeof value === "string")
    .sort()[0] ?? "해당 없음"
}

function valueKind(value) {
  return VALUE_KIND_LABELS[value?.value_kind] ?? "기록 없음"
}

function liabilityAmount(liability) {
  return (liability.principal ?? 0) + (liability.accrued_interest ?? 0) + (liability.fees_due ?? 0)
}

function handoffLiabilityAmount(liability) {
  return measuredTotal([liability.principal, liability.accrued_interest, liability.fees_due])
}

function liabilityMeasuredValues(liability) {
  return [liability.principal, liability.accrued_interest, liability.fees_due]
}

function latestObservation(handoff) {
  const values = [
    ...handoff.opening_positions.map((position) => position.value),
    ...handoff.liabilities.flatMap(liabilityMeasuredValues),
    ...handoff.recurring_flows.map((flow) => flow.amount),
  ]
  return values
    .map((value) => value?.observed_at)
    .filter((value) => typeof value === "string")
    .sort()
    .at(-1) ?? "기록 없음"
}

function principleRows(handoff) {
  const protectedCategories = handoff.budget_policy.protected_categories
  const refundPolicy = handoff.budget_policy.refund_period_policy === "source"
    ? "환불은 원거래 월의 지출을 조정해요."
    : "환불은 환불받은 월의 지출을 조정해요."
  return [
    ["P-01", protectedCategories.length > 0
      ? `보호 지출: ${protectedCategories.join(", ")}`
      : "보호 지출 분류가 아직 없어요.", "상시"],
    ["P-02", "포인트는 현금화되기 전까지 참고 잔액으로 관리해요.", "상시"],
    ["P-03", refundPolicy, "상시"],
    ["P-04", `현금흐름 적자가 ${handoff.risk_rules.deficit_period_threshold}회 이어지면 위험을 확인해요.`, "상시"],
  ]
}

function unresolvedPendingEvents(events, activeIds) {
  const resolved = new Set()
  for (const event of events) {
    if (!activeIds.has(event.event_id)) continue
    if (event.supersedes_event_id) resolved.add(event.supersedes_event_id)
    if (event.cancels_event_id) resolved.add(event.cancels_event_id)
  }
  return events.filter((event) => event.verification_status === "pending" && !resolved.has(event.event_id))
}

function reviewItems(handoff, state, pendingEvents) {
  const items = []
  const asOf = Date.parse(state.as_of)
  const accountLabels = new Map(handoff.accounts.map((account) => [account.account_id, account.label]))
  for (const liability of handoff.liabilities) {
    if (liability.overdue) items.push([liability.label, "연체 상태를 확인해 주세요.", "높음", "즉시"])
  }
  const measured = [
    ...handoff.opening_positions.map((position) => ({
      label: accountLabels.get(position.account_id) ?? position.position_id,
      value: position.value,
    })),
    ...handoff.liabilities.flatMap((liability) => liabilityMeasuredValues(liability).map((value) => ({
      label: liability.label,
      value,
    }))),
    ...handoff.recurring_flows.map((flow) => ({ label: flow.label, value: flow.amount })),
  ]
  const reviews = new Map()
  for (const { label, value } of measured) {
    if (value?.next_review_at && Date.parse(value.next_review_at) <= asOf) {
      const previous = reviews.get(label)
      if (previous === undefined || Date.parse(value.next_review_at) < Date.parse(previous)) {
        reviews.set(label, value.next_review_at)
      }
    }
  }
  for (const [label, reviewAt] of reviews) {
    items.push([label, "기록된 금액의 재확인 시점이 지났어요.", "보통", reviewAt])
  }
  if (pendingEvents.length > 0) {
    items.push(["확인 전 거래", `${pendingEvents.length}건의 입력을 확인해야 해요.`, "높음", "가능한 빨리"])
  }
  const pendingChecklist = handoff.onboarding_checklist.filter((item) => item.status === "pending").length
  if (pendingChecklist > 0) {
    items.push(["온보딩 확인", `${pendingChecklist}건의 후속 확인이 남아 있어요.`, "보통", "기록 없음"])
  }
  if (handoff.follow_ups.length > 0) {
    items.push(["후속 확인", `${handoff.follow_ups.length}건의 후속 확인이 기록돼 있어요.`, "보통", "기록 없음"])
  }
  const requiredBeforeIncome = handoff.cashflow_horizon.essential_obligations
    .reduce((total, obligation) => total + obligation.amount.amount, 0)
  if (state.totals.policy_available < requiredBeforeIncome) {
    items.push(["다음 수입 전 지급", "정책상 사용 가능액으로 필수지출을 충당하기 어려워요.", "높음", "즉시"])
  }
  return items
}

function eventEffects(event) {
  const result = {
    cashIn: 0,
    cashOut: 0,
    debtPrincipalPayment: 0,
    income: 0,
  }
  const payload = event.payload
  switch (event.type) {
    case "cash_purchase":
      result.cashOut = payload.amount
      break
    case "card_payment":
      result.cashOut = payload.amount
      break
    case "debt_draw":
      result.cashIn = payload.principal
      break
    case "debt_payment":
      result.cashOut = (payload.principal ?? 0) + (payload.interest ?? 0) + (payload.fees ?? 0)
      result.debtPrincipalPayment = payload.principal ?? 0
      break
    case "transfer_fee":
      result.cashOut = payload.amount
      break
    case "refund":
      if (payload.position_id) result.cashIn = payload.amount
      break
    case "income_received":
    case "points_cash_out":
    case "cashback_deposit":
      result.cashIn = payload.amount
      result.income = payload.amount
      break
    default:
      break
  }
  return result
}

function eventAmount(event) {
  if (event.type === "finance_charge") return (event.payload.interest ?? 0) + (event.payload.fees ?? 0)
  if (event.type === "debt_payment") {
    return (event.payload.principal ?? 0) + (event.payload.interest ?? 0) + (event.payload.fees ?? 0)
  }
  if (["debt_draw", "liability_transfer"].includes(event.type)) return event.payload.principal
  if (Number.isFinite(event.payload.amount)) return event.payload.amount
  if (Number.isFinite(event.payload.max_exposure)) return event.payload.max_exposure
  return null
}

function formatEventAmount(event, currency) {
  const amount = eventAmount(event)
  if (amount === null) return "해당 없음"
  return POINT_BALANCE_EVENT_TYPES.has(event.type)
    ? `${formatNumber(amount)} 포인트`
    : formatMoney(amount, currency)
}

function eventReferences(handoff) {
  const accounts = new Map(handoff.accounts.map((account) => [account.account_id, account.label]))
  return {
    liabilities: new Map(
      handoff.liabilities.map((liability) => [liability.liability_id, liability.label]),
    ),
    positions: new Map(
      handoff.opening_positions.map((position) => [position.position_id, accounts.get(position.account_id)]),
    ),
  }
}

function eventMethod(event, references) {
  const { liabilities, positions } = references
  const payload = event.payload
  if (payload.from_position_id && payload.to_position_id) {
    return `${positions.get(payload.from_position_id) ?? "계좌"} → ${positions.get(payload.to_position_id) ?? "계좌"}`
  }
  if (payload.position_id) return positions.get(payload.position_id) ?? "등록 계좌"
  if (payload.liability_id) return liabilities.get(payload.liability_id) ?? "등록 부채"
  if (payload.from_liability_id && payload.to_liability_id) {
    return `${liabilities.get(payload.from_liability_id) ?? "부채"} → ${liabilities.get(payload.to_liability_id) ?? "부채"}`
  }
  return "해당 없음"
}

function eventStatus(event, activeIds) {
  if (event.verification_status === "pending") return "확인 필요"
  if (event.verification_status === "rejected") return "반영 안 함"
  if (!activeIds.has(event.event_id)) return "대체·취소됨"
  if (event.cancels_event_id) return "취소 반영"
  if (event.supersedes_event_id) return "정정 반영"
  return {
    unsettled: "미결제",
    partially_settled: "일부 결제",
    settled: "결제 완료",
  }[event.settlement_status] ?? "반영 완료"
}

function eventDescription(event) {
  if ([
    "plan_created",
    "reservation_created",
    "conditional_commitment_created",
    "firm_commitment_created",
  ].includes(event.type)) return event.payload.label
  return EVENT_TYPE_LABELS[event.type] ?? event.type
}

function monthStatus(periodId, currentPeriodId, lastClosedPeriodId) {
  if (isMonthlyPeriodId(lastClosedPeriodId) && periodId <= lastClosedPeriodId) return "마감"
  if (periodId === currentPeriodId) return "진행 중"
  if (periodId < currentPeriodId) return "마감 상태 확인 필요"
  return "예정"
}

function buildMonthlyModels(handoff, state, events) {
  const timeZone = handoff.profile.timezone
  const currentPeriodId = periodIdForDateTime(state.as_of, timeZone)
  const activeIds = new Set(state.active_event_ids)
  const pendingEvents = unresolvedPendingEvents(events, activeIds)
  const pendingIds = new Set(pendingEvents.map((event) => event.event_id))
  const periodIds = new Set(currentPeriodId ? [currentPeriodId] : [])
  const metricsByPeriod = new Map()
  const confirmedByPeriod = new Map()
  const pendingByPeriod = new Map()
  const metricsFor = (periodId) => {
    const metrics = metricsByPeriod.get(periodId) ?? {
      cashIn: 0,
      cashOut: 0,
      debtPrincipalPayment: 0,
      income: 0,
    }
    metricsByPeriod.set(periodId, metrics)
    return metrics
  }
  for (const [index, event] of events.entries()) {
    const occurredPeriod = periodIdForDateTime(event.occurred_at, timeZone)
    if (occurredPeriod) {
      periodIds.add(occurredPeriod)
      if (event.verification_status === "confirmed") {
        const transactions = confirmedByPeriod.get(occurredPeriod) ?? []
        transactions.push({ event, index })
        confirmedByPeriod.set(occurredPeriod, transactions)
      }
      if (pendingIds.has(event.event_id)) {
        const transactions = pendingByPeriod.get(occurredPeriod) ?? []
        transactions.push(event)
        pendingByPeriod.set(occurredPeriod, transactions)
      }
      if (activeIds.has(event.event_id)) {
        const metrics = metricsFor(occurredPeriod)
        const effects = eventEffects(event)
        metrics.cashIn += effects.cashIn
        metrics.cashOut += effects.cashOut
        metrics.debtPrincipalPayment += effects.debtPrincipalPayment
        metrics.income += effects.income
      }
    }
    if (isMonthlyPeriodId(event.accounting_period_id)) periodIds.add(event.accounting_period_id)
  }
  for (const periodId of Object.keys(state.expenses_by_period)) {
    if (isMonthlyPeriodId(periodId)) periodIds.add(periodId)
  }
  const months = [...periodIds].sort().map((periodId) => {
    const metrics = metricsByPeriod.get(periodId) ?? {
      cashIn: 0,
      cashOut: 0,
      debtPrincipalPayment: 0,
      income: 0,
    }
    const confirmedTransactions = (confirmedByPeriod.get(periodId) ?? [])
      .sort((left, right) => Date.parse(left.event.occurred_at) - Date.parse(right.event.occurred_at)
        || left.index - right.index)
      .map(({ event }) => event)
    return {
      cashIn: metrics.cashIn,
      cashOut: metrics.cashOut,
      confirmedTransactions,
      debtPrincipalPayment: metrics.debtPrincipalPayment,
      expense: state.expenses_by_period[periodId] ?? 0,
      income: metrics.income,
      pendingTransactions: pendingByPeriod.get(periodId) ?? [],
      periodId,
      status: monthStatus(periodId, currentPeriodId, handoff.operations.last_closed_period_id),
    }
  })
  return {
    activeIds,
    currentPeriodId,
    months,
    pendingEvents,
  }
}

function scheduledItems(handoff, state, currentPeriodId) {
  if (!currentPeriodId) return []
  const timeZone = handoff.profile.timezone
  const currency = handoff.profile.currency
  const accountLabels = new Map(handoff.accounts.map((account) => [account.account_id, account.label]))
  const liabilities = new Map(
    handoff.liabilities.map((liability) => [liability.liability_id, liability]),
  )
  const rows = []
  const matchedLiabilities = new Set()
  const push = (dueAt, label, type, amount, accountId, overdue = false) => {
    if (periodIdForDateTime(dueAt, timeZone) !== currentPeriodId) return
    const status = overdue || Date.parse(dueAt) < Date.parse(state.as_of) ? "처리 여부 확인 필요" : "예정"
    rows.push([
      formatDate(dueAt, timeZone),
      label,
      type,
      formatMoney(amount, currency),
      accountLabels.get(accountId) ?? "기록 없음",
      status,
    ])
  }
  const nextIncome = handoff.cashflow_horizon.next_income
  push(nextIncome.expected_at, nextIncome.source_label, "수입", nextIncome.amount.amount, null)
  for (const obligation of handoff.cashflow_horizon.essential_obligations) {
    const liability = liabilities.get(obligation.source_liability_id)
    if (liability?.next_payment
      && liability.next_payment.amount.amount === obligation.amount.amount
      && Date.parse(liability.next_payment.due_at) === Date.parse(obligation.due_at)
      && liability.payment_account_id === obligation.payment_account_id) {
      matchedLiabilities.add(liability.liability_id)
    }
    push(
      obligation.due_at,
      obligation.label,
      obligation.source_liability_id ? "부채 상환" : "생활·서비스",
      obligation.amount.amount,
      obligation.payment_account_id,
    )
  }
  for (const liability of handoff.liabilities) {
    if (!liability.next_payment || matchedLiabilities.has(liability.liability_id)) continue
    push(
      liability.next_payment.due_at,
      liability.label,
      liability.type === "credit_card" ? "카드 결제" : "부채 상환",
      liability.next_payment.amount.amount,
      liability.payment_account_id,
      liability.overdue,
    )
  }
  return rows.sort((left, right) => left[0].localeCompare(right[0]))
}

function buildPresentation(handoff, state, events) {
  if (handoff === null || state === null) return null
  const monthly = buildMonthlyModels(handoff, state, events)
  const attention = reviewItems(handoff, state, monthly.pendingEvents)
  const assignedExpenses = monthly.months.reduce((total, month) => total + month.expense, 0)
  if (assignedExpenses !== state.totals.expenses) {
    attention.push(["월 미배정 지출", "월 형식의 회계 기간이 없는 지출을 확인해 주세요.", "높음", "가능한 빨리"])
  }
  return {
    attention,
    handoff,
    monthly,
    scheduled: scheduledItems(handoff, state, monthly.currentPeriodId),
    state,
  }
}

function assertStableHandoffProjection(stored, input) {
  if (stored === undefined) return
  if (stored.profile.timezone !== input.profile.timezone) {
    throw new Error("handoff.profile.timezone cannot change after the first write")
  }
  if (Date.parse(stored.snapshot.as_of) !== Date.parse(input.snapshot.as_of)) {
    throw new Error("handoff.snapshot.as_of cannot change after the first write")
  }
}

function emptyPresentation(title, message) {
  return [
    `# ${title}`,
    "",
    message,
    "",
    "> 이 문서는 읽기용이에요. 재생과 검증에는 기계 전용 원본 JSON을 사용해요.",
  ].join("\n")
}

function renderOverview(presentation) {
  if (presentation === null) {
    return emptyPresentation("자산관리 시스템", "저장된 인계 데이터가 없어요.")
  }
  const { attention, handoff, monthly, scheduled, state } = presentation
  const currency = handoff.profile.currency
  const liabilities = Object.values(state.liabilities)
  const cardLiabilities = liabilities.filter((liability) => liability.type === "credit_card")
  const debtLiabilities = liabilities.filter((liability) => liability.type !== "credit_card")
  const nextCardPayment = handoff.liabilities
    .filter((liability) => liability.type === "credit_card")
    .reduce((total, liability) => total + (liability.next_payment?.amount.amount ?? 0), 0)
  const currentMonth = monthly.months.find((month) => month.periodId === monthly.currentPeriodId)
  return [
    "# 자산관리 시스템",
    "",
    "> 이 문서는 원본 replay 결과를 보여주는 읽기용 첫 화면이에요.",
    "",
    `* 계산 기준 시각: ${state.as_of}`,
    `* 마지막 인계 관측 시각: ${latestObservation(handoff)}`,
    "",
    "## 자산 현황",
    "",
    renderTable(["항목", "금액"], [
      ["현금성 자산", formatMoney(state.totals.cash_like, currency)],
      ["일반 카드 결제 예정액", formatMoney(nextCardPayment, currency)],
      ["할부·대출 잔액", formatMoney(debtLiabilities.reduce((total, item) => total + liabilityAmount(item), 0), currency)],
      ["순자산", formatMoney(state.totals.net_worth, currency)],
      ["전월 말 대비 순자산 변화", "월말 관측 기록 없음"],
    ], "표시할 자산 합계가 없어요."),
    "",
    renderTable(["유형", "금액", "상태"], [
      ["현금성 자산", formatMoney(state.totals.cash_like, currency), "원장 계산값"],
      ["비현금성 자산", formatMoney(state.totals.total_assets - state.totals.cash_like, currency), "원장 계산값"],
      ["일반 카드", formatMoney(cardLiabilities.reduce((total, item) => total + liabilityAmount(item), 0), currency), "원장 계산값"],
      ["할부·기타 부채", formatMoney(debtLiabilities.reduce((total, item) => total + liabilityAmount(item), 0), currency), "원장 계산값"],
    ], "표시할 유형별 합계가 없어요."),
    "",
    "## 확인이 필요한 항목",
    "",
    renderTable(["항목", "확인 이유", "중요도", "기한"], attention, "지금 확인이 필요한 항목이 없어요."),
    "",
    "## 현재 적용 중인 핵심 원칙",
    "",
    renderTable(["코드", "원칙", "적용"], principleRows(handoff), "기록된 원칙이 없어요."),
    "",
    "## 이번 달 수입·지출",
    "",
    currentMonth
      ? renderTable(["항목", "금액"], [
        ["발생 수입", formatMoney(currentMonth.income, currency)],
        ["발생 지출", formatMoney(currentMonth.expense, currency)],
        ["예산 사용률", "분류별 예산 기록 없음"],
        ["순현금 변화", formatSignedMoney(currentMonth.cashIn - currentMonth.cashOut, currency)],
        ["고정 항목 처리 상태", "예정·실제 연결 기록 없음"],
      ], "이번 달 합계가 없어요.")
      : "이번 달로 계산할 기록이 없어요.",
    "",
    "## 이번 달 남은 고정 일정",
    "",
    renderTable(
      ["예정일", "항목", "구분", "예정 금액", "계좌", "상태"],
      scheduled,
      "이번 달에 구조화된 일정이 없어요.",
    ),
    "",
    "반복 흐름의 자유 형식 일정은 날짜로 추정하지 않아요. 처리 상태는 원본 거래와 연결 정보가 생긴 뒤 자동으로 판단할 수 있어요.",
    "",
    "## 상세 문서",
    "",
    "* `개인화된 자산관리 원칙`",
    "* `개인 자산 목록`",
    "* `고정 수입·지출`",
    "* `월별 수입·지출`",
    "* `원본 JSON (기계 전용)`",
  ].join("\n")
}

function renderPrinciples(presentation) {
  if (presentation === null) {
    return emptyPresentation("개인화된 자산관리 원칙", "저장된 인계 데이터가 없어요.")
  }
  const { handoff } = presentation
  return [
    "# 개인화된 자산관리 원칙",
    "",
    "> 원칙 변경은 사용자 승인을 받은 뒤 인계 데이터에 반영해요.",
    "",
    `* 기준 시각: ${handoff.snapshot.as_of}`,
    "",
    "## 상시 원칙",
    "",
    renderTable(["코드", "원칙", "적용"], principleRows(handoff), "기록된 상시 원칙이 없어요."),
    "",
    "## 임시 원칙",
    "",
    "구조화된 임시 원칙이 아직 없어요.",
    "",
    "## 상세 해설",
    "",
    "### P-01 보호 지출",
    "",
    "보호 지출은 일반 예산 감축 대상으로 자동 분류하지 않아요.",
    "",
    "### P-02 포인트",
    "",
    "포인트 적립과 사용은 참고 잔액으로 관리하고, 현금화되거나 계좌로 입금될 때 기타수입으로 반영해요.",
    "",
    "### P-03 환불",
    "",
    handoff.budget_policy.refund_period_policy === "source"
      ? "환불액은 원거래가 발생한 월의 지출에서 차감해요."
      : "환불액은 환불받은 월의 지출에서 차감해요.",
    "",
    "### P-04 현금흐름 위험",
    "",
    `현금흐름 적자가 ${handoff.risk_rules.deficit_period_threshold}회 이어지면 제한 지원 조건을 확인해요.`,
    "",
    "## 변경 기록",
    "",
    "현재 schema는 원칙 변경 이력을 별도로 저장하지 않아요.",
  ].join("\n")
}

function renderAssets(presentation) {
  if (presentation === null) {
    return emptyPresentation("개인 자산 목록", "저장된 인계 데이터가 없어요.")
  }
  const { attention, handoff, state } = presentation
  const currency = handoff.profile.currency
  const positionsByAccount = new Map()
  for (const position of handoff.opening_positions) {
    const positions = positionsByAccount.get(position.account_id) ?? []
    positions.push(position)
    positionsByAccount.set(position.account_id, positions)
  }
  const accountRows = handoff.accounts.map((account) => {
    const openingPositions = positionsByAccount.get(account.account_id) ?? []
    const current = Object.values(state.positions)
      .filter((position) => position.account_id === account.account_id)
      .reduce((total, position) => total + position.amount, 0)
    const observed = measuredTotal(openingPositions.map((position) => position.value))
    return [
      account.label,
      account.cash_like ? "현금성" : "비현금성",
      LIQUIDITY_LABELS[account.liquidity] ?? account.liquidity,
      formatMoney(current, currency),
      formatMoney(observed, currency),
      formatSignedMoney(current - observed, currency),
      measuredObservation(openingPositions.map((position) => position.value)),
      nextReview(openingPositions.map((position) => position.value)),
    ]
  })
  const accountLabels = new Map(handoff.accounts.map((account) => [account.account_id, account.label]))
  const liabilityRows = (types) => handoff.liabilities
    .filter((liability) => types.has(liability.type))
    .map((liability) => {
      const current = state.liabilities[liability.liability_id]
      const observed = handoffLiabilityAmount(liability)
      return [
        liability.label,
        LIABILITY_TYPE_LABELS[liability.type] ?? liability.type,
        formatMoney(liabilityAmount(current), currency),
        formatMoney(observed, currency),
        formatSignedMoney(liabilityAmount(current) - observed, currency),
        measuredObservation(liabilityMeasuredValues(liability)),
        liability.next_payment
          ? `${formatMoney(liability.next_payment.amount.amount, currency)} / ${formatDate(liability.next_payment.due_at, handoff.profile.timezone)}`
          : "기록 없음",
        accountLabels.get(liability.payment_account_id) ?? "기록 없음",
      ]
    })
  const liabilityHeaders = ["항목", "유형", "현재 원장 계산값", "인계 시 관측값", "인계 후 원장 변동", "관측 시각", "다음 납부", "결제 계좌"]
  return [
    "# 개인 자산 목록",
    "",
    "> 현재 금액은 원본 replay 결과예요. 인계 시 관측값은 현재 실제 잔액으로 간주하지 않아요.",
    "",
    `* 원장 계산 기준 시각: ${state.as_of}`,
    `* 마지막 인계 관측 시각: ${latestObservation(handoff)}`,
    "",
    "## 전체 요약",
    "",
    renderTable(["항목", "금액"], [
      ["현금성 자산", formatMoney(state.totals.cash_like, currency)],
      ["총부채", formatMoney(state.totals.total_liabilities, currency)],
      ["순자산", formatMoney(state.totals.net_worth, currency)],
      ["확인이 필요한 항목 수", String(attention.length)],
    ], "표시할 합계가 없어요."),
    "",
    "## 등록된 통장과 계좌",
    "",
    renderTable(
      ["계좌", "자산 성격", "유동성", "현재 원장 계산값", "인계 시 관측값", "인계 후 원장 변동", "관측 시각", "다음 확인"],
      accountRows,
      "등록된 계좌가 없어요.",
    ),
    "",
    "## 일반 카드",
    "",
    renderTable(liabilityHeaders, liabilityRows(new Set(["credit_card"])), "등록된 일반 카드가 없어요."),
    "",
    "## 할부",
    "",
    renderTable(liabilityHeaders, liabilityRows(new Set(["installment"])), "등록된 할부가 없어요."),
    "",
    "## 기타 부채",
    "",
    renderTable(
      liabilityHeaders,
      liabilityRows(new Set(["revolving", "cash_advance", "card_loan", "student_loan", "general_debt"])),
      "등록된 기타 부채가 없어요.",
    ),
    "",
    "## 확인이 필요한 항목",
    "",
    renderTable(["항목", "확인 이유", "중요도", "기한"], attention, "지금 확인이 필요한 항목이 없어요."),
    "",
    "## 미사용·확인 필요",
    "",
    "현재 schema에는 계좌와 카드의 사용 상태가 없어서 자동으로 미사용 항목을 분류하지 않아요.",
    "",
    "실제 잔액과 원장 계산값의 차이는 잔액 확인 기록이 추가된 뒤 표시할 수 있어요.",
  ].join("\n")
}

function renderRecurringFlows(presentation) {
  if (presentation === null) {
    return emptyPresentation("고정 수입·지출", "저장된 인계 데이터가 없어요.")
  }
  const { handoff } = presentation
  const currency = handoff.profile.currency
  const flowRows = (direction) => handoff.recurring_flows
    .filter((flow) => flow.direction === direction)
    .map((flow) => [
      flow.label,
      formatMoney(flow.amount.amount, currency),
      valueKind(flow.amount),
      flow.schedule,
      flow.amount.observed_at,
      flow.amount.next_review_at ?? "해당 없음",
      flow.essential === true ? "필수" : flow.essential === false ? "일반" : "기록 없음",
    ])
  const debtRows = handoff.liabilities
    .filter((liability) => liability.type !== "credit_card" && liability.next_payment)
    .map((liability) => [
      liability.label,
      LIABILITY_TYPE_LABELS[liability.type] ?? liability.type,
      formatMoney(liability.next_payment.amount.amount, currency),
      formatDate(liability.next_payment.due_at, handoff.profile.timezone),
      liability.remaining_installments == null ? "기록 없음" : String(liability.remaining_installments),
      liability.annual_rate == null ? "기록 없음" : `${liability.annual_rate}%`,
    ])
  const incomeTotal = measuredTotal(
    handoff.recurring_flows.filter((flow) => flow.direction === "income").map((flow) => flow.amount),
  )
  const expenseTotal = measuredTotal(
    handoff.recurring_flows.filter((flow) => flow.direction === "expense").map((flow) => flow.amount),
  )
  const debtPaymentTotal = handoff.liabilities
    .filter((liability) => liability.type !== "credit_card")
    .reduce((total, liability) => total + (liability.next_payment?.amount.amount ?? 0), 0)
  return [
    "# 고정 수입·지출",
    "",
    "> 반복 조건의 기준표예요. 실제 수령과 결제 여부는 월별 문서에서 확인해요.",
    "",
    `* 기준 시각: ${handoff.snapshot.as_of}`,
    "",
    "## 등록 금액 요약",
    "",
    renderTable(["항목", "금액"], [
      ["고정 수입 등록 금액", formatMoney(incomeTotal, currency)],
      ["반복 지출 등록 금액", formatMoney(expenseTotal, currency)],
      ["부채 다음 상환액", formatMoney(debtPaymentTotal, currency)],
      ["전체 고정 현금 유출", "중복 확인 전 계산 보류"],
    ], "표시할 등록 금액이 없어요."),
    "",
    "자유 형식 일정은 월 단위 금액으로 환산하지 않아요. 반복 지출과 부채 상환을 연결할 정보가 없어 전체 현금 유출도 합산하지 않아요.",
    "",
    "## 고정 수입",
    "",
    renderTable(
      ["항목", "금액", "금액 성격", "일정", "관측 시각", "다음 확인", "필수 여부"],
      flowRows("income"),
      "등록된 고정 수입이 없어요.",
    ),
    "",
    "## 생활·서비스 고정비",
    "",
    "현재 schema는 반복 지출의 세부 유형을 구분하지 않아서 등록된 지출을 이 구역의 후보로 보여줘요.",
    "",
    renderTable(
      ["항목", "금액", "금액 성격", "일정", "관측 시각", "다음 확인", "필수 여부"],
      flowRows("expense"),
      "등록된 반복 지출이 없어요.",
    ),
    "",
    "## 부채 상환",
    "",
    renderTable(
      ["부채", "유형", "다음 납부액", "다음 납부일", "남은 회차", "연이율"],
      debtRows,
      "등록된 부채 상환 일정이 없어요.",
    ),
    "",
    "## 이번 달 예정표",
    "",
    "구조화된 반복 규칙과 실제 거래 연결 정보가 없어 반복 항목의 월별 예정·실제를 자동으로 만들지 않아요.",
    "",
    "## 확인이 필요한 항목",
    "",
    "금액 범위, 결제 수단, 적용 기간과 실제 거래 연결은 다음 schema에서 구조화해야 해요.",
  ].join("\n")
}

function renderMonthlyRoot(presentation) {
  if (presentation === null) {
    return emptyPresentation("월별 수입·지출", "저장된 인계 데이터가 없어요.")
  }
  const years = [...new Set(presentation.monthly.months.map((month) => month.periodId.slice(0, 4)))]
  return [
    "# 월별 수입·지출",
    "",
    "> 연도 문서 아래에서 월별 수입·지출과 현금흐름을 확인할 수 있어요.",
    "",
    `* 계산 기준 시각: ${presentation.state.as_of}`,
    `* 현재 월: ${presentation.monthly.currentPeriodId
      ? periodTitle(presentation.monthly.currentPeriodId)
      : "기록 없음"}`,
    "",
    "## 연도",
    "",
    renderTable(["연도", "월 수", "상태"], years.map((year) => [
      `${year}년`,
      String(presentation.monthly.months.filter((month) => month.periodId.startsWith(`${year}-`)).length),
      year === presentation.monthly.currentPeriodId?.slice(0, 4) ? "진행 중" : "기록됨",
    ]), "표시할 연도가 없어요."),
  ].join("\n")
}

function renderYear(presentation, year) {
  const { handoff, monthly } = presentation
  const currency = handoff.profile.currency
  const months = monthly.months.filter((month) => month.periodId.startsWith(`${year}-`))
  const closed = months.filter((month) => month.status === "마감")
  const current = months.find((month) => month.periodId === monthly.currentPeriodId)
  return [
    `# ${year}년 수입·지출`,
    "",
    "> 마감된 달의 누계와 진행 중인 달을 분리해 보여줘요.",
    "",
    `* 확정 누계 기준 월: ${closed.at(-1)?.periodId ?? "기록 없음"}`,
    "",
    "## 마감된 달 누계",
    "",
    closed.length > 0
      ? renderTable(["항목", "금액"], [
        ["발생 수입", formatMoney(closed.reduce((total, month) => total + month.income, 0), currency)],
        ["발생 지출", formatMoney(closed.reduce((total, month) => total + month.expense, 0), currency)],
        ["수입·지출 차액", formatSignedMoney(closed.reduce((total, month) => total + month.income - month.expense, 0), currency)],
        ["현금 증감", formatSignedMoney(closed.reduce((total, month) => total + month.cashIn - month.cashOut, 0), currency)],
        ["연초 대비 순자산 변화", "월말 관측 기록 없음"],
      ], "마감된 달이 없어요.")
      : "마감된 달이 없어요.",
    "",
    "## 진행 중인 달",
    "",
    current
      ? renderTable(["항목", "값"], [
        ["현재 월", periodTitle(current.periodId)],
        ["발생 수입", formatMoney(current.income, currency)],
        ["발생 지출", formatMoney(current.expense, currency)],
        ["예산 사용률", "분류별 예산 기록 없음"],
        ["현금 증감", formatSignedMoney(current.cashIn - current.cashOut, currency)],
      ], "진행 중인 달이 없어요.")
      : "진행 중인 달이 없어요.",
    "",
    "## 월별 흐름",
    "",
    renderTable(
      ["월", "상태", "수입", "지출", "수입·지출 차액", "현금 증감"],
      months.map((month) => [
        periodTitle(month.periodId),
        month.status,
        formatMoney(month.income, currency),
        formatMoney(month.expense, currency),
        formatSignedMoney(month.income - month.expense, currency),
        formatSignedMoney(month.cashIn - month.cashOut, currency),
      ]),
      "표시할 월이 없어요.",
    ),
    "",
    "## 분류별 연간 지출",
    "",
    "거래 분류와 월별 예산이 구조화되어 있지 않아 아직 집계하지 않아요.",
    "",
    "## 자산 변화",
    "",
    "월말 실제 잔액 관측 기록이 없어 과거 순자산을 추정하지 않아요.",
  ].join("\n")
}

function renderMonth(presentation, month) {
  const { handoff, monthly } = presentation
  const currency = handoff.profile.currency
  const timeZone = handoff.profile.timezone
  const references = eventReferences(handoff)
  const transactionRows = month.confirmedTransactions.map((event) => {
    return [
      formatDate(event.occurred_at, timeZone),
      eventDescription(event),
      EVENT_GROUP_LABELS[event.type] ?? "기타",
      "분류 미기록",
      eventMethod(event, references),
      formatEventAmount(event, currency),
      eventStatus(event, monthly.activeIds),
    ]
  })
  const pendingRows = month.pendingTransactions.map((event) => [
    formatDate(event.occurred_at, timeZone),
    eventDescription(event),
    EVENT_GROUP_LABELS[event.type] ?? "기타",
    formatEventAmount(event, currency),
  ])
  return [
    `# ${periodTitle(month.periodId)} 수입·지출`,
    "",
    "> 발생 기준 수입·지출과 실제 현금흐름을 분리해 보여줘요.",
    "",
    `* 상태: ${month.status}`,
    `* 마감 시각: ${month.status === "마감" ? "별도 기록 없음" : "해당 없음"}`,
    "",
    "## 한눈에 보기",
    "",
    renderTable(["기준", "항목", "금액"], [
      ["발생", "수입", formatMoney(month.income, currency)],
      ["발생", "지출", formatMoney(month.expense, currency)],
      ["발생", "수입·지출 차액", formatSignedMoney(month.income - month.expense, currency)],
      ["현금", "유입", formatMoney(month.cashIn, currency)],
      ["현금", "유출", formatMoney(month.cashOut, currency)],
      ["현금", "증감", formatSignedMoney(month.cashIn - month.cashOut, currency)],
      ["현금", "부채 원금 상환", formatMoney(month.debtPrincipalPayment, currency)],
    ], "표시할 월 합계가 없어요."),
    "",
    "## 확인할 일",
    "",
    renderTable(
      ["발생일", "항목", "구분", "금액"],
      pendingRows,
      "확인 전 거래가 없어요. 고정 항목 처리와 예산 초과는 연결 정보가 생긴 뒤 판단할 수 있어요.",
    ),
    "",
    "## 고정 수입·지출 예정과 실제",
    "",
    "반복 항목과 실제 거래의 연결 정보가 없어 자동으로 비교하지 않아요.",
    "",
    "## 분류별 지출",
    "",
    renderTable(["분류", "예산", "실제 지출", "남은 금액", "사용률"], [
      ["미분류", "기록 없음", formatMoney(month.expense, currency), "기록 없음", "기록 없음"],
    ], "표시할 지출이 없어요."),
    "",
    "## 전체 거래 내역",
    "",
    renderTable(
      ["발생일", "내용", "거래 유형", "분류", "결제·입금 수단", "금액", "상태"],
      transactionRows,
      "확정 거래가 없어요.",
    ),
    "",
    "같은 시각의 거래는 원본 이벤트 index 순서로 표시해요. 원본 event ID는 사람용 문서에 노출하지 않아요.",
    "",
    "## 월 마감",
    "",
    isMonthlyPeriodId(handoff.operations.last_closed_period_id)
      ? `마지막 월 마감 포인터는 ${handoff.operations.last_closed_period_id}예요.`
      : "월 마감 시각과 당시 수치는 구조화되어 있지 않아요.",
    "",
    "## 마감 후 정정",
    "",
    "현재 수치는 취소·대체·환불을 모두 replay한 결과예요. 마감 시각이 없어 마감 후에 들어온 정정만 따로 판별하지 않아요.",
  ].join("\n")
}

export class OutlineAssetAdapter {
  #apiToken
  #baseUrl
  #collectionId
  #fetch
  #ids
  #queueKey

  constructor({
    baseUrl = process.env.OUTLINE_URL,
    apiToken = process.env.OUTLINE_API_TOKEN,
    collectionId = process.env.OUTLINE_COLLECTION_ID,
    fetchImpl = globalThis.fetch,
    allowInsecureHttp = false,
  } = {}) {
    if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
      throw new Error("OUTLINE_URL is required")
    }
    if (typeof apiToken !== "string" || apiToken.trim().length === 0) {
      throw new Error("OUTLINE_API_TOKEN is required")
    }
    if (typeof collectionId !== "string" || !UUID_PATTERN.test(collectionId)) {
      throw new Error("OUTLINE_COLLECTION_ID must be a valid UUID")
    }
    if (typeof fetchImpl !== "function") throw new Error("Outline fetch implementation is required")
    if (typeof allowInsecureHttp !== "boolean") {
      throw new Error("allowInsecureHttp must be a boolean")
    }
    const parsedUrl = new URL(baseUrl)
    if (!new Set(["http:", "https:"]).has(parsedUrl.protocol)) {
      throw new Error("OUTLINE_URL must use http or https")
    }
    if (parsedUrl.protocol === "http:" && !allowInsecureHttp) {
      throw new Error("OUTLINE_URL must use https unless allowInsecureHttp is explicitly enabled")
    }
    this.#baseUrl = parsedUrl.toString().replace(/\/+$/, "")
    this.#apiToken = apiToken
    this.#collectionId = collectionId.toLowerCase()
    this.#fetch = fetchImpl
    this.#ids = Object.freeze(Object.fromEntries(
      Object.entries(DOCUMENTS).map(([name, spec]) => [name, this.#documentId(spec.idKey)]),
    ))
    this.#queueKey = `${this.#baseUrl}\0${this.#collectionId}`
  }

  get collectionId() {
    return this.#collectionId
  }

  get documentIds() {
    return { ...this.#ids }
  }

  eventDocumentId(eventId) {
    return this.#documentId(`event:${eventId}`)
  }

  notificationDocumentId(periodId) {
    return this.#documentId(`notification:${periodId}`)
  }

  yearDocumentId(year) {
    if (typeof year !== "string" || !/^\d{4}$/.test(year)) {
      throw new Error("year must use YYYY format")
    }
    return this.#documentId(`view:year:${year}`)
  }

  monthDocumentId(periodId) {
    if (!isMonthlyPeriodId(periodId)) throw new Error("periodId must use YYYY-MM format")
    return this.#documentId(`view:month:${periodId}`)
  }

  async bootstrap() {
    return this.#enqueue(async () => {
      const manifests = await this.#bootstrapSystem()
      const eventState = await this.#readIndexedCollection("events", manifests.events)
      await this.#readIndexedCollection("notifications", manifests.notifications)
      const presentation = await this.#loadStoredPresentation(eventState.records, { checkSnapshot: true })
      await this.#writePresentations(presentation)
      return this.documentIds
    })
  }

  async readHandoff() {
    return this.#enqueue(async () => {
      await this.#bootstrapSystem()
      const data = await this.#readFixed(DOCUMENTS.handoff, this.#ids.handoff)
      if (data !== undefined) assertValidHandoff(data)
      return data ?? null
    })
  }

  async writeHandoff(handoff) {
    const opening = handoffToOpening(handoff)
    const input = cloneJson(handoff)
    return this.#enqueue(async () => {
      const manifests = await this.#bootstrapSystem()
      const existingHandoff = await this.#readFixed(DOCUMENTS.handoff, this.#ids.handoff)
      assertStableHandoffProjection(existingHandoff, input)
      const eventState = await this.#readIndexedCollection("events", manifests.events)
      const presentation = {
        events: eventState.records,
        handoff: input,
        state: this.#projectCurrentState(input, eventState.records, opening),
      }
      const stored = await this.#writeFixed(DOCUMENTS.handoff, this.#ids.handoff, input)
      await this.#writePresentations(presentation)
      return stored
    })
  }

  async readSnapshot() {
    return this.#enqueue(async () => {
      await this.#bootstrapSystem()
      const snapshot = await this.#readFixed(DOCUMENTS.snapshot, this.#ids.snapshot)
      if (snapshot !== undefined) assertSnapshot(snapshot)
      return snapshot ?? null
    })
  }

  async writeSnapshot(snapshot) {
    assertSnapshot(snapshot)
    const input = cloneJson(snapshot)
    return this.#enqueue(async () => {
      await this.#bootstrapSystem()
      return this.#writeFixed(DOCUMENTS.snapshot, this.#ids.snapshot, input)
    })
  }

  async readEvents() {
    return this.#enqueue(async () => {
      const manifests = await this.#bootstrapSystem()
      const state = await this.#readIndexedCollection("events", manifests.events)
      return state.records
    })
  }

  async appendEvent(event) {
    validateEvent(event)
    const input = cloneJson(event)
    return this.#enqueue(() => this.#appendIndexedRecord("events", input))
  }

  async readNotifications() {
    return this.#enqueue(async () => {
      const manifests = await this.#bootstrapSystem()
      const state = await this.#readIndexedCollection("notifications", manifests.notifications)
      return state.records
    })
  }

  async appendNotification(notification) {
    assertNotification(notification)
    const input = cloneJson(notification)
    return this.#enqueue(() => this.#appendIndexedRecord("notifications", input))
  }

  #enqueue(operation) {
    return enqueueOperation(this.#queueKey, operation)
  }

  #registerIndexedRecord(name, records, input) {
    return name === "events"
      ? registerEvent(records, input)
      : registerPeriodNotification(records, input)
  }

  #reconcileIndexedRecord(name, document, input) {
    return name === "events"
      ? this.#reconcileEvent(document, input)
      : this.#reconcileNotification(document, input)
  }

  async #appendIndexedRecord(name, input) {
    const definition = this.#indexDefinition(name)
    const key = input[definition.recordKeyField]
    const spec = this.#recordSpec(name, key, input)
    const manifests = await this.#bootstrapSystem()
    const manifest = manifests[name]
    const state = await this.#readIndexedCollection(name, manifest, {
      allowedOrphan: manifest.created ? null : { id: spec.id, key },
    })
    const indexed = state.recordsById.get(spec.id)
    if (indexed) {
      const result = this.#reconcileIndexedRecord(name, indexed, input)
      const presentation = await this.#prepareIndexedPresentation(name, state.records)
      if (presentation) await this.#writePresentations(presentation)
      return result
    }

    const existing = state.orphanDocument ?? await this.#getDocument(spec.id)
    if (existing) {
      const result = this.#reconcileIndexedRecord(name, existing, input)
      const registration = this.#registerIndexedRecord(name, state.records, input)
      if (registration.status !== definition.acceptedStatus) {
        throw new Error(`Outline unindexed ${definition.resultField} cannot be reconciled: ${key}`)
      }
      const presentation = await this.#prepareIndexedPresentation(name, registration.events)
      await this.#appendIndexEntry(name, state.manifest, key, spec.id)
      if (presentation) await this.#writePresentations(presentation)
      return result
    }

    const registration = this.#registerIndexedRecord(name, state.records, input)
    if (registration.status !== definition.acceptedStatus) return registration
    const presentation = await this.#prepareIndexedPresentation(name, registration.events)
    try {
      const created = await this.#createDocument(spec)
      this.#validateStoredDocument(created, spec)
    } catch (error) {
      const reconciled = await this.#getDocument(spec.id)
      if (!reconciled) throw error
      this.#reconcileIndexedRecord(name, reconciled, input)
    }
    await this.#appendIndexEntry(name, state.manifest, key, spec.id)
    if (presentation) await this.#writePresentations(presentation)
    return { [definition.resultField]: input, status: definition.acceptedStatus }
  }

  async #prepareIndexedPresentation(name, events) {
    if (name !== "events") return null
    const presentation = await this.#loadStoredPresentation(events)
    if (presentation.handoff === null) {
      throw new Error("Outline handoff must be stored before appending events")
    }
    return presentation
  }

  #documentId(key) {
    return deterministicOutlineDocumentId(this.#collectionId, key)
  }

  async #request(endpoint, payload, { missingOk = false } = {}) {
    let response
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/${endpoint}`, {
        body: JSON.stringify(payload),
        headers: {
          Authorization: `Bearer ${this.#apiToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        redirect: "error",
      })
    } catch (error) {
      throw new Error(`Outline ${endpoint} request failed: ${error.message}`)
    }
    if (response.status === 404 && missingOk) return null
    let body
    try {
      body = await response.json()
    } catch (error) {
      if (!response.ok) throw this.#httpError(endpoint, response)
      const invalidJsonError = new Error(`Outline ${endpoint} returned invalid JSON (HTTP ${response.status})`)
      invalidJsonError.status = response.status
      throw invalidJsonError
    }
    if (!response.ok || body?.ok !== true) throw this.#httpError(endpoint, response, body)
    return body
  }

  #httpError(endpoint, response, body = undefined) {
    const detail = body?.message ?? body?.error ?? response.statusText ?? "unknown error"
    const retryAfter = response.headers?.get?.("Retry-After") ?? null
    const error = new Error(
      `Outline ${endpoint} failed (HTTP ${response.status}): ${detail}`
        + (retryAfter === null ? "" : `; Retry-After=${retryAfter}`),
    )
    error.status = response.status
    error.responseBody = body
    if (retryAfter !== null) error.retryAfter = retryAfter
    return error
  }

  async #getDocument(id) {
    const response = await this.#request("documents.info", { id }, { missingOk: true })
    if (response === null) return null
    return this.#responseDocument(response, "documents.info")
  }

  async #createDocument(spec) {
    const payload = {
      collectionId: this.#collectionId,
      id: spec.id,
      publish: true,
      text: this.#renderDocumentText(spec),
      title: spec.title,
    }
    if (spec.parentDocumentId) payload.parentDocumentId = spec.parentDocumentId
    const response = await this.#request("documents.create", payload)
    return this.#responseDocument(response, "documents.create")
  }

  async #updateDocument(spec) {
    const response = await this.#request("documents.update", {
      editMode: "replace",
      id: spec.id,
      publish: true,
      text: this.#renderDocumentText(spec),
      title: spec.title,
    })
    return this.#responseDocument(response, "documents.update")
  }

  #responseDocument(response, endpoint) {
    if (!response?.data || typeof response.data !== "object" || Array.isArray(response.data)) {
      throw new Error(`Outline ${endpoint} response does not contain document data`)
    }
    return response.data
  }

  #validateLocation(document, { id, parentDocumentId }) {
    if (document.id !== id) throw new Error(`Outline document has unexpected ID: ${document.id}`)
    if (document.collectionId !== this.#collectionId) {
      throw new Error(`Outline document ${id} belongs to another collection`)
    }
    if ((document.parentDocumentId ?? null) !== (parentDocumentId ?? null)) {
      throw new Error(`Outline document ${id} has an unexpected parent`)
    }
    if (document.publishedAt == null || document.archivedAt != null) {
      throw new Error(`Outline document ${id} must be published and not archived`)
    }
  }

  #readStoredDocument(document, spec) {
    this.#validateLocation(document, spec)
    return parseEnvelope(document.text, spec.kind, spec.key).data
  }

  #renderDocumentText(spec) {
    return spec.text ?? renderEnvelope(spec.kind, spec.key, spec.data)
  }

  #validateStoredDocument(document, spec) {
    const data = this.#readStoredDocument(document, spec)
    if (!sameData(data, spec.data)) {
      throw new Error(`Outline document conflict: ${spec.key}`)
    }
    return data
  }

  #indexDefinition(name) {
    const definition = INDEXED_COLLECTIONS[name]
    if (!definition) throw new Error(`Unsupported Outline index: ${name}`)
    return definition
  }

  #manifestSpec(name, data = undefined) {
    const definition = this.#indexDefinition(name)
    const documentSpec = DOCUMENTS[definition.index]
    const spec = {
      ...documentSpec,
      id: this.#ids[definition.index],
      parentDocumentId: this.#ids[definition.container],
    }
    if (data !== undefined) spec.data = data
    return spec
  }

  #recordSpec(name, key, data) {
    const definition = this.#indexDefinition(name)
    return {
      data,
      id: this.#documentId(`${definition.recordIdPrefix}:${key}`),
      key,
      kind: definition.recordKind,
      parentDocumentId: this.#ids[definition.container],
      title: `${definition.recordTitlePrefix} ${key}`,
    }
  }

  #emptyIndex() {
    return { entries: [], index_version: INDEX_VERSION }
  }

  #validateIndex(name, data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`Outline ${name} index must be an object`)
    }
    if (Object.keys(data).sort().join(",") !== "entries,index_version") {
      throw new Error(`Outline ${name} index has unexpected fields`)
    }
    if (data.index_version !== INDEX_VERSION) {
      throw new Error(`Outline ${name} index has unsupported version: ${data.index_version}`)
    }
    if (!Array.isArray(data.entries)) throw new Error(`Outline ${name} index entries must be an array`)
    const definition = this.#indexDefinition(name)
    const ids = new Set()
    const keys = new Set()
    for (let index = 0; index < data.entries.length; index += 1) {
      const entry = data.entries[index]
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Outline ${name} index entry ${index + 1} must be an object`)
      }
      if (Object.keys(entry).sort().join(",") !== "document_id,key,sequence") {
        throw new Error(`Outline ${name} index entry ${index + 1} has unexpected fields`)
      }
      if (entry.sequence !== index + 1) {
        throw new Error(`Outline ${name} index sequence must be contiguous`)
      }
      if (typeof entry.key !== "string" || entry.key.length === 0) {
        throw new Error(`Outline ${name} index entry ${index + 1} has an invalid key`)
      }
      const expectedId = this.#documentId(`${definition.recordIdPrefix}:${entry.key}`)
      if (entry.document_id !== expectedId) {
        throw new Error(`Outline ${name} index entry ${index + 1} has an unexpected document ID`)
      }
      if (ids.has(entry.document_id) || keys.has(entry.key)) {
        throw new Error(`Outline ${name} index contains a duplicate entry`)
      }
      ids.add(entry.document_id)
      keys.add(entry.key)
    }
    return data
  }

  #readManifestDocument(name, document) {
    const data = this.#readStoredDocument(document, this.#manifestSpec(name))
    return this.#validateIndex(name, data)
  }

  async #ensureManifest(name) {
    const spec = this.#manifestSpec(name, this.#emptyIndex())
    const existing = await this.#getDocument(spec.id)
    if (existing) {
      return {
        created: false,
        data: this.#readManifestDocument(name, existing),
        document: existing,
      }
    }
    let document
    try {
      document = await this.#createDocument(spec)
      this.#validateStoredDocument(document, spec)
    } catch (error) {
      document = await this.#getDocument(spec.id)
      if (!document) throw error
      this.#readManifestDocument(name, document)
    }
    return {
      created: true,
      data: this.#readManifestDocument(name, document),
      document,
    }
  }

  async #bootstrapSystem() {
    await this.#ensurePresentationDocument(this.#presentationSpec("rawRoot", RAW_ROOT_MARKDOWN, null))
    await this.#ensureSystemDocument({
      ...DOCUMENTS.root,
      data: { role: "root" },
      id: this.#ids.root,
      parentDocumentId: this.#ids.rawRoot,
    })
    await this.#ensureSystemDocument({
      ...DOCUMENTS.events,
      data: { role: "events" },
      id: this.#ids.events,
      parentDocumentId: this.#ids.root,
    })
    await this.#ensureSystemDocument({
      ...DOCUMENTS.notifications,
      data: { role: "notifications" },
      id: this.#ids.notifications,
      parentDocumentId: this.#ids.root,
    })
    return {
      events: await this.#ensureManifest("events"),
      notifications: await this.#ensureManifest("notifications"),
    }
  }

  async #ensureSystemDocument(spec) {
    const existing = await this.#getDocument(spec.id)
    if (existing) {
      this.#validateStoredDocument(existing, spec)
      return spec.id
    }
    try {
      const created = await this.#createDocument(spec)
      this.#validateStoredDocument(created, spec)
    } catch (error) {
      const reconciled = await this.#getDocument(spec.id)
      if (!reconciled) throw error
      this.#validateStoredDocument(reconciled, spec)
    }
    return spec.id
  }

  async #ensurePresentationDocument(spec) {
    let existing = await this.#getDocument(spec.id)
    if (!existing) {
      try {
        const created = await this.#createDocument(spec)
        this.#validatePresentationDocument(created, spec)
        return spec.id
      } catch (error) {
        existing = await this.#getDocument(spec.id)
        if (!existing) throw error
      }
    }
    this.#validateLocation(existing, spec)
    if (existing.title === spec.title && samePresentationMarkdown(existing.text, spec.text)) return spec.id
    try {
      const updated = await this.#updateDocument(spec)
      this.#validatePresentationDocument(updated, spec)
    } catch (error) {
      const reconciled = await this.#getDocument(spec.id)
      if (!reconciled) throw error
      try {
        this.#validatePresentationDocument(reconciled, spec)
      } catch {
        throw error
      }
    }
    return spec.id
  }

  #validatePresentationDocument(document, spec) {
    this.#validateLocation(document, spec)
    if (document.title !== spec.title || !samePresentationMarkdown(document.text, spec.text)) {
      throw new Error(`Outline presentation document conflict: ${spec.title}`)
    }
  }

  #presentationSpec(name, text, parentDocumentId = this.#ids.overview) {
    return {
      ...DOCUMENTS[name],
      id: this.#ids[name],
      parentDocumentId,
      text,
    }
  }

  #projectCurrentState(handoff, events, opening = handoffToOpening(handoff)) {
    const state = projectLedger(opening, events, {
      refund_period_policy: handoff.budget_policy.refund_period_policy,
    })
    let asOf = handoff.snapshot.as_of
    const activeIds = new Set(state.active_event_ids)
    for (const event of events) {
      if (!activeIds.has(event.event_id)) continue
      if (Date.parse(event.occurred_at) > Date.parse(asOf)) asOf = event.occurred_at
    }
    return {
      ...state,
      as_of: asOf,
      currency: handoff.profile.currency,
      last_closed_period_id: handoff.operations.last_closed_period_id,
    }
  }

  async #writePresentations({ events, handoff, state }) {
    const presentation = buildPresentation(handoff, state, events)
    await this.#ensurePresentationDocument(
      this.#presentationSpec("overview", renderOverview(presentation), null),
    )
    await this.#ensurePresentationDocument(
      this.#presentationSpec("principles", renderPrinciples(presentation)),
    )
    await this.#ensurePresentationDocument(
      this.#presentationSpec("assets", renderAssets(presentation)),
    )
    await this.#ensurePresentationDocument(
      this.#presentationSpec("recurringFlows", renderRecurringFlows(presentation)),
    )
    await this.#ensurePresentationDocument(
      this.#presentationSpec("monthly", renderMonthlyRoot(presentation)),
    )
    if (presentation === null) return
    const years = [...new Set(presentation.monthly.months.map((month) => month.periodId.slice(0, 4)))]
    for (const year of years) {
      const yearSpec = this.#dynamicPresentationSpec(
        `view:year:${year}`,
        `${year}년`,
        renderYear(presentation, year),
        this.#ids.monthly,
      )
      await this.#ensurePresentationDocument(yearSpec)
      for (const month of presentation.monthly.months.filter((entry) => entry.periodId.startsWith(`${year}-`))) {
        await this.#ensurePresentationDocument(this.#dynamicPresentationSpec(
          `view:month:${month.periodId}`,
          periodTitle(month.periodId),
          renderMonth(presentation, month),
          yearSpec.id,
        ))
      }
    }
  }

  #dynamicPresentationSpec(idKey, title, text, parentDocumentId) {
    return {
      id: this.#documentId(idKey),
      parentDocumentId,
      text,
      title,
    }
  }

  async #loadStoredPresentation(events, { checkSnapshot = false } = {}) {
    const handoff = await this.#readFixed(DOCUMENTS.handoff, this.#ids.handoff)
    if (checkSnapshot) {
      const snapshot = await this.#readFixed(DOCUMENTS.snapshot, this.#ids.snapshot)
      if (snapshot !== undefined) assertSnapshot(snapshot)
    }
    return {
      events,
      handoff: handoff ?? null,
      state: handoff === undefined ? null : this.#projectCurrentState(handoff, events),
    }
  }

  async #readFixed(documentSpec, id) {
    const existing = await this.#getDocument(id)
    if (!existing) return undefined
    return this.#readStoredDocument(existing, {
      ...documentSpec,
      id,
      parentDocumentId: this.#ids.root,
    })
  }

  async #writeFixed(documentSpec, id, input) {
    const data = input
    const spec = {
      ...documentSpec,
      data,
      id,
      parentDocumentId: this.#ids.root,
    }
    let existing = await this.#getDocument(id)
    if (!existing) {
      try {
        const created = await this.#createDocument(spec)
        this.#validateStoredDocument(created, spec)
        return data
      } catch (error) {
        existing = await this.#getDocument(id)
        if (!existing) throw error
      }
    }
    const stored = this.#readStoredDocument(existing, spec)
    if (sameData(stored, data)) return data
    try {
      const updated = await this.#updateDocument(spec)
      this.#validateStoredDocument(updated, spec)
    } catch (error) {
      const reconciled = await this.#getDocument(id)
      if (!reconciled) throw error
      try {
        this.#validateStoredDocument(reconciled, spec)
      } catch {
        throw error
      }
    }
    return data
  }

  async #listChildDocuments(parentDocumentId) {
    const documents = []
    const seenIds = new Set()
    let offset = 0
    let expectedTotal
    while (true) {
      const response = await this.#request("documents.list", {
        collectionId: this.#collectionId,
        direction: "ASC",
        limit: PAGE_LIMIT,
        offset,
        parentDocumentId,
        sort: "createdAt",
        statusFilter: ["published", "draft", "archived"],
      })
      if (!Array.isArray(response.data)) {
        throw new Error("Outline documents.list response does not contain a document array")
      }
      if (response.data.length > PAGE_LIMIT) {
        throw new Error("Outline documents.list exceeded the requested page limit")
      }
      for (const document of response.data) {
        if (!document || typeof document !== "object" || Array.isArray(document)) {
          throw new Error("Outline documents.list returned an invalid document")
        }
        if (!isIsoDateTime(document.createdAt)) {
          throw new Error(`Outline document ${document.id ?? "unknown"} has invalid createdAt`)
        }
        this.#validateLocation(document, { id: document.id, parentDocumentId })
        if (seenIds.has(document.id)) {
          throw new Error(`Outline documents.list repeated document ID: ${document.id}`)
        }
        seenIds.add(document.id)
        documents.push(document)
      }
      offset += response.data.length
      const total = response.pagination?.total
      if (Number.isInteger(total)) {
        if (expectedTotal === undefined) expectedTotal = total
        else if (total !== expectedTotal) throw new Error("Outline documents.list total changed during pagination")
        if (offset >= total) break
      }
      if (response.data.length === 0) break
      if (!response.pagination?.nextPath && response.data.length < PAGE_LIMIT) break
    }
    if (expectedTotal !== undefined && documents.length !== expectedTotal) {
      throw new Error("Outline documents.list returned an incomplete result set")
    }
    return documents
  }

  #readRecordDocument(name, document, entry) {
    const definition = this.#indexDefinition(name)
    const data = this.#readStoredDocument(document, {
      id: entry.document_id,
      key: entry.key,
      kind: definition.recordKind,
      parentDocumentId: this.#ids[definition.container],
    })
    if (data[definition.recordKeyField] !== entry.key) {
      throw new Error(`Outline ${name} record key mismatch: ${entry.key}`)
    }
    if (name === "events") validateEvent(data)
    else assertNotification(data)
    return data
  }

  async #readIndexedCollection(name, manifest, { allowedOrphan = null } = {}) {
    const definition = this.#indexDefinition(name)
    const manifestSpec = this.#manifestSpec(name)
    const entries = manifest.data.entries
    const storedRecords = await mapWithConcurrency(entries, async (entry) => {
      const document = await this.#getDocument(entry.document_id)
      if (document === null) {
        throw new Error(`Outline indexed ${name} document is missing or deleted: ${entry.document_id}`)
      }
      return { data: this.#readRecordDocument(name, document, entry), document }
    })
    const records = storedRecords.map(({ data }) => data)
    const recordsById = new Map(storedRecords.map(({ document }) => [document.id, document]))

    let orphanDocument = null
    if (allowedOrphan && !recordsById.has(allowedOrphan.id)) {
      orphanDocument = await this.#getDocument(allowedOrphan.id)
      if (orphanDocument) {
        this.#readRecordDocument(name, orphanDocument, {
          document_id: allowedOrphan.id,
          key: allowedOrphan.key,
        })
      }
    }

    const listedDocuments = await this.#listChildDocuments(this.#ids[definition.container])
    const listedIds = new Set()
    for (const document of listedDocuments) {
      if (listedIds.has(document.id)) {
        throw new Error(`Outline ${name} container listing contains a duplicate document ID`)
      }
      listedIds.add(document.id)
    }
    const expectedIds = new Set([manifestSpec.id, ...entries.map((entry) => entry.document_id)])
    for (const id of expectedIds) {
      if (!listedIds.has(id)) throw new Error(`Outline ${name} index mismatch: missing direct child ${id}`)
    }
    for (const id of listedIds) {
      if (!expectedIds.has(id) && id !== allowedOrphan?.id) {
        throw new Error(`Outline ${name} index mismatch: unindexed orphan ${id}`)
      }
    }
    if (allowedOrphan
      && listedIds.has(allowedOrphan.id)
      && !recordsById.has(allowedOrphan.id)
      && !orphanDocument) {
      throw new Error(`Outline ${name} orphan disappeared during verification: ${allowedOrphan.id}`)
    }
    return { manifest, orphanDocument, records, recordsById }
  }

  async #writeManifest(name, manifest, data) {
    this.#validateIndex(name, data)
    const spec = this.#manifestSpec(name, data)
    let document
    try {
      document = await this.#updateDocument(spec)
      this.#validateStoredDocument(document, spec)
    } catch (error) {
      document = await this.#getDocument(spec.id)
      if (!document) throw error
      const stored = this.#readManifestDocument(name, document)
      if (!sameData(stored, data)) {
        if (sameData(stored, manifest.data)) throw error
        throw new Error(`Outline ${name} index changed during update`)
      }
    }
    return { created: false, data, document }
  }

  async #appendIndexEntry(name, manifest, key, documentId) {
    if (manifest.data.entries.some((entry) => entry.document_id === documentId || entry.key === key)) {
      throw new Error(`Outline ${name} index already contains ${key}`)
    }
    const data = {
      entries: [
        ...manifest.data.entries,
        {
          document_id: documentId,
          key,
          sequence: manifest.data.entries.length + 1,
        },
      ],
      index_version: INDEX_VERSION,
    }
    return this.#writeManifest(name, manifest, data)
  }

  #reconcileEvent(document, input) {
    const spec = {
      data: input,
      id: this.eventDocumentId(input.event_id),
      key: input.event_id,
      kind: "asset-management-event",
      parentDocumentId: this.#ids.events,
    }
    const stored = this.#readStoredDocument(document, spec)
    validateEvent(stored)
    if (!sameData(stored, input)) throw new Error(`Outline event conflict: ${input.event_id}`)
    return { event: stored, existing_event_id: input.event_id, status: "duplicate" }
  }

  #reconcileNotification(document, input) {
    const spec = {
      id: this.notificationDocumentId(input.period_id),
      key: input.period_id,
      kind: "asset-management-notification",
      parentDocumentId: this.#ids.notifications,
    }
    const stored = this.#readStoredDocument(document, spec)
    assertNotification(stored)
    if (stored.period_id !== input.period_id) {
      throw new Error(`Outline notification conflict: ${input.period_id}`)
    }
    return { notification: stored, status: "already_notified" }
  }
}
