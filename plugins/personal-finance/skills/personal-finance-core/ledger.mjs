import { readFileSync } from "node:fs"
import { findForbiddenPaths, isIsoDateTime, validateJsonSchema } from "./validation.mjs"

const EVENT_SCHEMA = JSON.parse(readFileSync(new URL("./event.schema.json", import.meta.url), "utf8"))
const LIQUIDITIES = new Set(["immediate", "restricted", "illiquid"])
const POLICIES = new Set(["available", "allocated", "restricted"])
const INCOME_KINDS = new Set(["earned", "other"])
const REFUNDABLE_EVENT_TYPES = new Set(["cash_purchase", "card_purchase", "installment_purchase"])
const EXPENSE_PURCHASE_TYPES = new Set(["cash_purchase", "card_purchase"])

const REQUIRED_PAYLOAD_FIELDS = {
  account_transfer: ["from_position_id", "to_position_id", "amount"],
  fund_allocation: ["from_position_id", "to_position_id", "amount", "allocation_id"],
  cash_purchase: ["position_id", "amount"],
  card_purchase: ["liability_id", "amount"],
  installment_purchase: ["liability_id", "amount"],
  card_payment: ["position_id", "liability_id", "amount"],
  debt_draw: ["position_id", "liability_id", "principal"],
  liability_transfer: ["from_liability_id", "to_liability_id", "principal"],
  finance_charge: ["liability_id"],
  debt_payment: ["position_id", "liability_id"],
  transfer_fee: ["position_id", "amount"],
  refund: ["source_event_id", "amount"],
  card_authorization_cancelled: [],
  event_cancelled: [],
  income_received: ["position_id", "amount", "income_kind"],
  points_earned: ["program_id", "amount"],
  points_used: ["program_id", "amount"],
  points_expired: ["program_id", "amount"],
  points_cash_out: ["program_id", "position_id", "amount"],
  cashback_deposit: ["position_id", "amount"],
  plan_created: ["commitment_id", "label"],
  reservation_created: ["commitment_id", "label"],
  conditional_commitment_created: ["commitment_id", "label", "max_exposure"],
  firm_commitment_created: ["commitment_id", "label", "amount", "due_at"],
}

const PAYLOAD_ID_FIELDS = {
  account_transfer: ["from_position_id", "to_position_id"],
  fund_allocation: ["from_position_id", "to_position_id", "allocation_id"],
  cash_purchase: ["position_id"],
  card_purchase: ["liability_id"],
  installment_purchase: ["liability_id"],
  card_payment: ["position_id", "liability_id"],
  debt_draw: ["position_id", "liability_id"],
  liability_transfer: ["from_liability_id", "to_liability_id"],
  finance_charge: ["liability_id"],
  debt_payment: ["position_id", "liability_id"],
  transfer_fee: ["position_id"],
  refund: ["source_event_id"],
  income_received: ["position_id"],
  points_earned: ["program_id"],
  points_used: ["program_id"],
  points_expired: ["program_id"],
  points_cash_out: ["program_id", "position_id"],
  cashback_deposit: ["position_id"],
  plan_created: ["commitment_id"],
  reservation_created: ["commitment_id"],
  conditional_commitment_created: ["commitment_id"],
  firm_commitment_created: ["commitment_id"],
}

const PAYLOAD_MONEY_FIELDS = {
  account_transfer: ["amount"],
  fund_allocation: ["amount"],
  cash_purchase: ["amount"],
  card_purchase: ["amount"],
  installment_purchase: ["amount"],
  card_payment: ["amount"],
  debt_draw: ["principal"],
  liability_transfer: ["principal"],
  transfer_fee: ["amount"],
  refund: ["amount"],
  income_received: ["amount"],
  points_earned: ["amount"],
  points_used: ["amount"],
  points_expired: ["amount"],
  points_cash_out: ["amount"],
  cashback_deposit: ["amount"],
  conditional_commitment_created: ["max_exposure"],
  firm_commitment_created: ["amount"],
}

function clone(value) {
  return structuredClone(value)
}

function getOwn(record, key) {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function setOwn(record, key, value) {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function assertId(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
}

function assertMoney(value, label, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer greater than or equal to ${minimum}`)
  }
}

function requirePayloadFields(event) {
  const required = REQUIRED_PAYLOAD_FIELDS[event.type]
  for (const field of required) {
    if (event.payload[field] === undefined || event.payload[field] === null) {
      throw new Error(`${event.type} requires payload.${field}`)
    }
  }
}

function validatePayload(event) {
  const payload = event.payload
  for (const field of PAYLOAD_ID_FIELDS[event.type] ?? []) {
    assertId(payload[field], `payload.${field}`)
  }
  for (const field of PAYLOAD_MONEY_FIELDS[event.type] ?? []) {
    assertMoney(payload[field], `payload.${field}`)
  }

  if (event.type === "account_transfer" && payload.from_position_id === payload.to_position_id) {
    throw new Error("account_transfer requires different position legs")
  }
  if (event.type === "liability_transfer" && payload.from_liability_id === payload.to_liability_id) {
    throw new Error("liability_transfer requires different liabilities")
  }
  if (event.type === "finance_charge") {
    const interest = payload.interest ?? 0
    const fees = payload.fees ?? 0
    assertMoney(interest, "payload.interest", { allowZero: true })
    assertMoney(fees, "payload.fees", { allowZero: true })
    if (interest + fees === 0) throw new Error("finance_charge requires interest or fees")
    assertMoney(interest + fees, "finance charge total")
  }
  if (event.type === "debt_payment") {
    const components = [payload.principal ?? 0, payload.interest ?? 0, payload.fees ?? 0]
    components.forEach((amount, index) => {
      assertMoney(amount, `payload.${["principal", "interest", "fees"][index]}`, { allowZero: true })
    })
    assertMoney(components.reduce((total, amount) => total + amount, 0), "debt payment total")
  }
  if (event.type === "refund") {
    const targets = ["position_id", "liability_id"].filter((field) => payload[field] !== undefined)
    if (targets.length !== 1) throw new Error("refund requires exactly one position_id or liability_id")
    assertId(payload[targets[0]], `payload.${targets[0]}`)
  }
  if (event.type === "income_received" && !INCOME_KINDS.has(payload.income_kind)) {
    throw new Error(`unsupported income kind: ${payload.income_kind}`)
  }
  if (["plan_created", "reservation_created", "conditional_commitment_created", "firm_commitment_created"]
    .includes(event.type)) {
    assertId(payload.label, "payload.label")
  }
  if (event.type === "conditional_commitment_created"
    && payload.condition !== undefined
    && typeof payload.condition !== "string") {
    throw new Error("payload.condition must be a string")
  }
  if (event.type === "firm_commitment_created" && !isIsoDateTime(payload.due_at)) {
    throw new Error("payload.due_at must be an ISO date-time")
  }
}

export function validateEvent(event) {
  assertObject(event, "event")
  const forbiddenPaths = findForbiddenPaths(event, "event")
  if (forbiddenPaths.length > 0) throw new Error(`${forbiddenPaths[0]} is forbidden`)
  const schemaErrors = validateJsonSchema(event, EVENT_SCHEMA, "event")
  if (schemaErrors.length > 0) throw new Error(schemaErrors[0])
  assertId(event.event_id, "event.event_id")
  requirePayloadFields(event)
  validatePayload(event)
  if (event.supersedes_event_id === event.event_id || event.cancels_event_id === event.event_id) {
    throw new Error("an event cannot replace or cancel itself")
  }
  return event
}

function assertOpeningState(opening) {
  assertObject(opening, "opening")
  if (Object.hasOwn(opening, "opening_positions")) {
    throw new Error("handoff data must be converted with handoffToOpening before projection")
  }
  const accountIds = new Set()
  for (const account of opening.accounts ?? []) {
    assertId(account.account_id, "account.account_id")
    if (accountIds.has(account.account_id)) throw new Error(`duplicate account: ${account.account_id}`)
    if (!LIQUIDITIES.has(account.liquidity)) throw new Error(`invalid liquidity: ${account.liquidity}`)
    accountIds.add(account.account_id)
  }

  const positionIds = new Set()
  for (const position of opening.positions ?? []) {
    assertId(position.position_id, "position.position_id")
    if (positionIds.has(position.position_id)) throw new Error(`duplicate position: ${position.position_id}`)
    if (!accountIds.has(position.account_id)) throw new Error(`unknown account: ${position.account_id}`)
    if (!POLICIES.has(position.policy)) throw new Error(`invalid policy: ${position.policy}`)
    assertMoney(position.amount, "position.amount", { allowZero: true })
    positionIds.add(position.position_id)
  }

  const liabilityIds = new Set()
  for (const liability of opening.liabilities ?? []) {
    assertId(liability.liability_id, "liability.liability_id")
    if (liabilityIds.has(liability.liability_id)) {
      throw new Error(`duplicate liability: ${liability.liability_id}`)
    }
    assertMoney(liability.principal, "liability.principal", { allowZero: true })
    assertMoney(liability.accrued_interest, "liability.accrued_interest", { allowZero: true })
    assertMoney(liability.fees_due, "liability.fees_due", { allowZero: true })
    liabilityIds.add(liability.liability_id)
  }

  const pointIds = new Set()
  for (const program of opening.points ?? []) {
    assertId(program.program_id, "points.program_id")
    if (pointIds.has(program.program_id)) throw new Error(`duplicate point program: ${program.program_id}`)
    assertMoney(program.balance, "points.balance", { allowZero: true })
    pointIds.add(program.program_id)
  }
}

function calculateTotals(state) {
  const positions = Object.values(state.positions)
  const liabilities = Object.values(state.liabilities)
  const totalAssets = positions.reduce((total, position) => total + position.amount, 0)
  const cashLike = positions.reduce((total, position) => {
    return total + (getAccount(state, position.account_id).cash_like ? position.amount : 0)
  }, 0)
  const immediatelyLiquid = positions.reduce((total, position) => {
    return total + (getAccount(state, position.account_id).liquidity === "immediate" ? position.amount : 0)
  }, 0)
  const policyAvailable = positions.reduce((total, position) => {
    const account = getAccount(state, position.account_id)
    return total + (account.liquidity === "immediate" && position.policy === "available" ? position.amount : 0)
  }, 0)
  const purposeAllocated = positions.reduce((total, position) => {
    return total + (position.policy === "allocated" ? position.amount : 0)
  }, 0)
  const policyRestricted = positions.reduce((total, position) => {
    return total + (position.policy === "restricted" ? position.amount : 0)
  }, 0)
  const liquidityRestricted = positions.reduce((total, position) => {
    return total + (getAccount(state, position.account_id).liquidity !== "immediate" ? position.amount : 0)
  }, 0)
  const totalLiabilities = liabilities.reduce((total, liability) => {
    return total + liability.principal + liability.accrued_interest + liability.fees_due
  }, 0)

  state.totals = {
    total_assets: totalAssets,
    cash_like: cashLike,
    immediately_liquid: immediatelyLiquid,
    policy_available: policyAvailable,
    purpose_allocated: purposeAllocated,
    policy_restricted: policyRestricted,
    liquidity_restricted: liquidityRestricted,
    total_liabilities: totalLiabilities,
    net_worth: totalAssets - totalLiabilities,
    expenses: state.expenses,
    earned_income: state.earned_income,
    other_income: state.other_income,
  }
  return state
}

export function createOpeningState(opening = {}) {
  assertOpeningState(opening)
  const state = {
    accounts: Object.fromEntries((opening.accounts ?? []).map((account) => [account.account_id, clone(account)])),
    positions: Object.fromEntries((opening.positions ?? []).map((position) => [position.position_id, clone(position)])),
    liabilities: Object.fromEntries(
      (opening.liabilities ?? []).map((liability) => [
        liability.liability_id,
        clone(liability),
      ]),
    ),
    points: Object.fromEntries((opening.points ?? []).map((program) => [program.program_id, program.balance])),
    commitments: {},
    expenses: 0,
    earned_income: 0,
    other_income: 0,
    expenses_by_period: {},
    refunded_by_source: {},
    active_event_ids: [],
  }
  return calculateTotals(state)
}

function getAccount(state, accountId) {
  const account = getOwn(state.accounts, accountId)
  if (!account) throw new Error(`unknown account: ${accountId}`)
  return account
}

function getPosition(state, positionId) {
  const position = getOwn(state.positions, positionId)
  if (!position) throw new Error(`unknown position: ${positionId}`)
  return position
}

function getLiability(state, liabilityId) {
  const liability = getOwn(state.liabilities, liabilityId)
  if (!liability) throw new Error(`unknown liability: ${liabilityId}`)
  return liability
}

function decreasePosition(state, positionId, amount) {
  assertMoney(amount, "amount")
  const position = getPosition(state, positionId)
  if (position.amount < amount) throw new Error(`insufficient position balance: ${positionId}`)
  position.amount -= amount
}

function increasePosition(state, positionId, amount) {
  assertMoney(amount, "amount")
  getPosition(state, positionId).amount += amount
}

function decreaseLiabilityComponent(liability, component, amount) {
  assertMoney(amount, component, { allowZero: true })
  if (liability[component] < amount) {
    throw new Error(`${component} payment exceeds liability balance: ${liability.liability_id}`)
  }
  liability[component] -= amount
}

function addExpense(state, amount, periodId) {
  assertMoney(Math.abs(amount), "expense adjustment")
  state.expenses += amount
  if (periodId) setOwn(state.expenses_by_period, periodId, (getOwn(state.expenses_by_period, periodId) ?? 0) + amount)
}

function applyEvent(currentState, event, eventsById, options) {
  const state = clone(currentState)
  const payload = event.payload
  const periodId = event.accounting_period_id

  switch (event.type) {
    case "account_transfer": {
      assertMoney(payload.amount, "payload.amount")
      const from = getPosition(state, payload.from_position_id)
      const to = getPosition(state, payload.to_position_id)
      if (from.account_id === to.account_id) {
        throw new Error("account transfer must move money between different accounts")
      }
      if (from.policy !== to.policy || (from.allocation_id ?? null) !== (to.allocation_id ?? null)) {
        throw new Error("account transfer must preserve policy and allocation identity")
      }
      decreasePosition(state, payload.from_position_id, payload.amount)
      increasePosition(state, payload.to_position_id, payload.amount)
      break
    }
    case "fund_allocation": {
      assertMoney(payload.amount, "payload.amount")
      const from = getPosition(state, payload.from_position_id)
      const to = getPosition(state, payload.to_position_id)
      if (from.account_id !== to.account_id) throw new Error("fund allocation must stay within one account")
      if (from.policy !== "available" || to.policy === "available") {
        throw new Error("fund allocation must move available money to allocated or restricted money")
      }
      if ((to.allocation_id !== undefined && to.allocation_id !== null
        && to.allocation_id !== payload.allocation_id)
        || (to.amount > 0 && (to.allocation_id === undefined || to.allocation_id === null))) {
        throw new Error("fund allocation must preserve the destination allocation identity")
      }
      decreasePosition(state, payload.from_position_id, payload.amount)
      increasePosition(state, payload.to_position_id, payload.amount)
      to.allocation_id = payload.allocation_id
      break
    }
    case "cash_purchase":
      decreasePosition(state, payload.position_id, payload.amount)
      addExpense(state, payload.amount, periodId)
      break
    case "card_purchase": {
      assertMoney(payload.amount, "payload.amount")
      const liability = getLiability(state, payload.liability_id)
      if (liability.type !== "credit_card") throw new Error("card purchase requires a credit card liability")
      liability.principal += payload.amount
      addExpense(state, payload.amount, periodId)
      break
    }
    case "installment_purchase": {
      assertMoney(payload.amount, "payload.amount")
      const liability = getLiability(state, payload.liability_id)
      if (liability.type !== "installment") throw new Error("installment purchase requires an installment liability")
      liability.principal += payload.amount
      break
    }
    case "card_payment":
      decreasePosition(state, payload.position_id, payload.amount)
      decreaseLiabilityComponent(getLiability(state, payload.liability_id), "principal", payload.amount)
      break
    case "debt_draw":
      increasePosition(state, payload.position_id, payload.principal)
      getLiability(state, payload.liability_id).principal += payload.principal
      break
    case "liability_transfer":
      decreaseLiabilityComponent(
        getLiability(state, payload.from_liability_id),
        "principal",
        payload.principal,
      )
      getLiability(state, payload.to_liability_id).principal += payload.principal
      break
    case "finance_charge": {
      const liability = getLiability(state, payload.liability_id)
      const interest = payload.interest ?? 0
      const fees = payload.fees ?? 0
      assertMoney(interest, "payload.interest", { allowZero: true })
      assertMoney(fees, "payload.fees", { allowZero: true })
      if (interest + fees === 0) throw new Error("finance_charge requires interest or fees")
      liability.accrued_interest += interest
      liability.fees_due += fees
      addExpense(state, interest + fees, periodId)
      break
    }
    case "debt_payment": {
      const principal = payload.principal ?? 0
      const interest = payload.interest ?? 0
      const fees = payload.fees ?? 0
      const total = principal + interest + fees
      assertMoney(total, "debt payment total")
      decreasePosition(state, payload.position_id, total)
      const liability = getLiability(state, payload.liability_id)
      decreaseLiabilityComponent(liability, "principal", principal)
      decreaseLiabilityComponent(liability, "accrued_interest", interest)
      decreaseLiabilityComponent(liability, "fees_due", fees)
      break
    }
    case "transfer_fee":
      decreasePosition(state, payload.position_id, payload.amount)
      addExpense(state, payload.amount, periodId)
      break
    case "refund": {
      assertMoney(payload.amount, "payload.amount")
      const sourceEvent = eventsById.get(payload.source_event_id)
      if (!sourceEvent) throw new Error(`unknown refund source: ${payload.source_event_id}`)
      if (sourceEvent.verification_status !== "confirmed"
        || !state.active_event_ids.includes(sourceEvent.event_id)
        || !REFUNDABLE_EVENT_TYPES.has(sourceEvent.type)) {
        throw new Error(`refund source must be an active confirmed purchase: ${payload.source_event_id}`)
      }
      assertMoney(sourceEvent.payload.amount, "refund source amount")
      const refunded = getOwn(state.refunded_by_source, payload.source_event_id) ?? 0
      if (refunded + payload.amount > sourceEvent.payload.amount) {
        throw new Error(`refund exceeds source amount: ${payload.source_event_id}`)
      }
      if (payload.position_id) increasePosition(state, payload.position_id, payload.amount)
      else if (payload.liability_id) {
        decreaseLiabilityComponent(getLiability(state, payload.liability_id), "principal", payload.amount)
      } else throw new Error("refund requires payload.position_id or payload.liability_id")
      const refundPeriod = options.refund_period_policy === "source"
        ? sourceEvent.accounting_period_id
        : periodId
      if (EXPENSE_PURCHASE_TYPES.has(sourceEvent.type)) addExpense(state, -payload.amount, refundPeriod)
      setOwn(state.refunded_by_source, payload.source_event_id, refunded + payload.amount)
      break
    }
    case "income_received":
      increasePosition(state, payload.position_id, payload.amount)
      if (payload.income_kind === "earned") state.earned_income += payload.amount
      else if (payload.income_kind === "other") state.other_income += payload.amount
      else throw new Error(`unsupported income kind: ${payload.income_kind}`)
      break
    case "points_earned":
      assertMoney(payload.amount, "payload.amount")
      setOwn(state.points, payload.program_id, (getOwn(state.points, payload.program_id) ?? 0) + payload.amount)
      break
    case "points_used":
    case "points_expired": {
      assertMoney(payload.amount, "payload.amount")
      const balance = getOwn(state.points, payload.program_id) ?? 0
      if (balance < payload.amount) throw new Error(`insufficient points: ${payload.program_id}`)
      setOwn(state.points, payload.program_id, balance - payload.amount)
      break
    }
    case "points_cash_out": {
      assertMoney(payload.amount, "payload.amount")
      const balance = getOwn(state.points, payload.program_id) ?? 0
      if (balance < payload.amount) throw new Error(`insufficient points: ${payload.program_id}`)
      setOwn(state.points, payload.program_id, balance - payload.amount)
      increasePosition(state, payload.position_id, payload.amount)
      state.other_income += payload.amount
      break
    }
    case "cashback_deposit":
      increasePosition(state, payload.position_id, payload.amount)
      state.other_income += payload.amount
      break
    case "plan_created":
      setOwn(state.commitments, payload.commitment_id, { kind: "plan", label: payload.label })
      break
    case "reservation_created":
      setOwn(state.commitments, payload.commitment_id, { kind: "reservation", label: payload.label })
      break
    case "conditional_commitment_created":
      assertMoney(payload.max_exposure, "payload.max_exposure")
      setOwn(state.commitments, payload.commitment_id, {
        kind: "conditional",
        label: payload.label,
        max_exposure: payload.max_exposure,
        condition: payload.condition ?? null,
      })
      break
    case "firm_commitment_created":
      assertMoney(payload.amount, "payload.amount")
      setOwn(state.commitments, payload.commitment_id, {
        kind: "firm",
        label: payload.label,
        amount: payload.amount,
        due_at: payload.due_at,
      })
      break
    case "card_authorization_cancelled":
    case "event_cancelled":
      break
    default:
      throw new Error(`unhandled event type: ${event.type}`)
  }

  state.active_event_ids.push(event.event_id)
  return calculateTotals(state)
}

function relationshipTargets(event) {
  return [
    [event.supersedes_event_id, "superseded", "supersedes"],
    [event.cancels_event_id, "cancelled", "cancels"],
  ].filter(([eventId]) => eventId !== undefined)
}

function resolveActiveEventIds(events, eventsById) {
  const relationsByTarget = new Map()
  const outgoingBySource = new Map()
  const indegree = new Map(events.map((event) => [event.event_id, 0]))

  for (const event of events) {
    if (event.verification_status !== "confirmed") continue
    for (const [targetId, relation, type] of relationshipTargets(event)) {
      if (!eventsById.has(targetId)) throw new Error(`unknown ${relation} event: ${targetId}`)
      const sources = relationsByTarget.get(targetId) ?? []
      sources.push({ sourceId: event.event_id, type })
      relationsByTarget.set(targetId, sources)
      const targets = outgoingBySource.get(event.event_id) ?? []
      targets.push(targetId)
      outgoingBySource.set(event.event_id, targets)
      indegree.set(targetId, indegree.get(targetId) + 1)
    }
  }

  const queue = events.filter((event) => indegree.get(event.event_id) === 0).map((event) => event.event_id)
  const activeById = new Map()
  for (let index = 0; index < queue.length; index += 1) {
    const eventId = queue[index]
    const event = eventsById.get(eventId)
    const active = event.verification_status === "confirmed"
      && !(relationsByTarget.get(eventId) ?? []).some(({ sourceId }) => activeById.get(sourceId))
    activeById.set(eventId, active)
    for (const targetId of outgoingBySource.get(eventId) ?? []) {
      indegree.set(targetId, indegree.get(targetId) - 1)
      if (indegree.get(targetId) === 0) queue.push(targetId)
    }
  }
  if (activeById.size !== events.length) {
    const cycleId = events.find((event) => !activeById.has(event.event_id)).event_id
    throw new Error(`event relationship cycle: ${cycleId}`)
  }

  const activeIds = new Set(events.filter((event) => activeById.get(event.event_id)).map((event) => event.event_id))
  for (const [targetId, relations] of relationsByTarget) {
    const activeSuperseders = relations.filter(({ sourceId, type }) => {
      return type === "supersedes" && activeIds.has(sourceId)
    })
    if (activeSuperseders.length > 1) {
      throw new Error(`multiple active superseding events: ${targetId}`)
    }
  }
  return activeIds
}

export function projectLedger(opening, events, options = {}) {
  const eventsById = new Map()
  for (const event of events) {
    validateEvent(event)
    if (eventsById.has(event.event_id)) throw new Error(`duplicate event_id: ${event.event_id}`)
    eventsById.set(event.event_id, event)
  }

  const activeIds = resolveActiveEventIds(events, eventsById)

  let state = createOpeningState(opening)
  for (const event of events) {
    if (!activeIds.has(event.event_id)) continue
    state = applyEvent(state, event, eventsById, {
      refund_period_policy: options.refund_period_policy ?? "receipt",
    })
  }
  return state
}

function hasSameSourceIdentity(left, right) {
  if (left.kind !== right.kind || left.system !== right.system) return false
  if (left.external_id !== undefined || right.external_id !== undefined) {
    return left.external_id !== undefined && left.external_id === right.external_id
  }
  return left.fingerprint !== undefined && left.fingerprint === right.fingerprint
}

export function registerEvent(existingEvents, event) {
  validateEvent(event)
  if (existingEvents.some((candidate) => candidate.event_id === event.event_id)) {
    throw new Error(`duplicate event_id: ${event.event_id}`)
  }
  const source = event.source
  const transitionTarget = existingEvents.find((candidate) => {
    return candidate.event_id === event.supersedes_event_id
      && candidate.verification_status === "pending"
      && event.verification_status === "confirmed"
      && hasSameSourceIdentity(candidate.source, source)
  })
  const supersededEvent = existingEvents.find((candidate) => candidate.event_id === event.supersedes_event_id)
  if (event.verification_status === "confirmed"
    && supersededEvent?.verification_status === "pending"
    && !transitionTarget) {
    throw new Error("pending confirmation requires the same source identity")
  }
  const completedTransition = existingEvents.find((candidate) => {
    return event.supersedes_event_id !== undefined
      && candidate.verification_status === "confirmed"
      && candidate.supersedes_event_id === event.supersedes_event_id
      && hasSameSourceIdentity(candidate.source, source)
  })
  if (completedTransition) {
    return { status: "duplicate", existing_event_id: completedTransition.event_id, events: existingEvents }
  }
  if (source.external_id) {
    const matches = existingEvents.filter((candidate) => hasSameSourceIdentity(candidate.source, source))
    const existing = matches.find((candidate) => candidate.verification_status === "confirmed")
      ?? matches.find((candidate) => candidate.event_id !== transitionTarget?.event_id)
    if (existing) {
      return { status: "duplicate", existing_event_id: existing.event_id, events: existingEvents }
    }
  }

  const candidateIds = source.fingerprint
    ? existingEvents
      .filter((candidate) => candidate.source.fingerprint === source.fingerprint)
      .map((candidate) => candidate.event_id)
    : []

  const unrelatedCandidateIds = candidateIds.filter((eventId) => eventId !== transitionTarget?.event_id)
  if (unrelatedCandidateIds.length > 0 && !event.duplicate_reviewed) {
    return { status: "needs_duplicate_confirmation", candidate_event_ids: candidateIds, events: existingEvents }
  }

  const acceptedEvents = [...existingEvents, event]
  const eventsById = new Map(acceptedEvents.map((candidate) => [candidate.event_id, candidate]))
  resolveActiveEventIds(acceptedEvents, eventsById)
  return { status: "accepted", candidate_event_ids: candidateIds, events: acceptedEvents }
}

export function registerPeriodNotification(existingNotifications, notification) {
  assertObject(notification, "notification")
  assertId(notification.period_id, "notification.period_id")
  if (existingNotifications.some((entry) => entry.period_id === notification.period_id)) {
    return { status: "already_notified", notifications: existingNotifications }
  }
  return { status: "created", notifications: [...existingNotifications, clone(notification)] }
}

export function assessSupport(input) {
  assertObject(input, "support assessment")
  const reasons = []
  const asOf = new Date(input.as_of).getTime()
  const nextIncomeAt = new Date(input.next_income_at).getTime()
  if (!Number.isFinite(asOf) || !Number.isFinite(nextIncomeAt)) {
    throw new Error("support assessment requires valid as_of and next_income_at")
  }
  assertMoney(input.policy_available, "policy_available", { allowZero: true })
  assertMoney(input.required_before_next_income, "required_before_next_income", { allowZero: true })
  if (input.policy_available < input.required_before_next_income) reasons.push("essential_cash_shortfall")

  for (const obligation of input.obligations ?? []) {
    const dueAt = new Date(obligation.due_at).getTime()
    if (!Number.isFinite(dueAt)) throw new Error("obligation requires a valid due_at")
    if (obligation.unpaid && dueAt < asOf) reasons.push("overdue_obligation")
    else if (obligation.unpaid && dueAt <= nextIncomeAt && obligation.amount > input.policy_available) {
      reasons.push("obligation_at_risk_before_income")
    }
  }

  const threshold = input.deficit_period_threshold
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    throw new Error("deficit_period_threshold must be a positive integer")
  }
  if ((input.consecutive_deficit_periods ?? 0) >= threshold) reasons.push("repeated_cashflow_deficit")
  if (input.not_solvable_by_budget === true) reasons.push("not_solvable_by_budget")

  const specialistScopes = new Set([
    "debt_restructuring",
    "rehabilitation_or_bankruptcy",
    "tax_filing",
    "business_accounting",
    "legal_judgment",
  ])
  const specialistReasons = (input.requested_scopes ?? []).filter((scope) => specialistScopes.has(scope))
  return {
    level: specialistReasons.length > 0 ? "specialist" : reasons.length > 0 ? "limited" : "standard",
    reasons,
    specialist_reasons: specialistReasons,
  }
}
