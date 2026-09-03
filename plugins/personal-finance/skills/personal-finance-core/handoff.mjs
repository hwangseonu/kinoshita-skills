import { readFileSync } from "node:fs"
import { findForbiddenPaths, validateJsonSchema } from "./validation.mjs"

const HANDOFF_SCHEMA = JSON.parse(
  readFileSync(new URL("./handoff.schema.json", import.meta.url), "utf8"),
)

const CARD_LIABILITY_TYPES = new Set([
  "credit_card",
  "installment",
  "revolving",
  "cash_advance",
  "card_loan",
])

export const REQUIRED_BLOCKING_ITEM_IDS = [
  "snapshot",
  "accounts_and_positions",
  "liabilities",
  "next_income",
  "essential_obligations",
  "payment_capacity",
]

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function validateUniqueIds(items, key, path, errors) {
  const ids = new Set()
  for (const [index, item] of items.entries()) {
    if (ids.has(item[key])) errors.push(`${path}[${index}].${key} is duplicated`)
    ids.add(item[key])
  }
  return ids
}

function validateSemantics(handoff) {
  const errors = []
  if (!Array.isArray(handoff.accounts)
    || !Array.isArray(handoff.opening_positions)
    || !Array.isArray(handoff.liabilities)
    || !Array.isArray(handoff.onboarding_checklist)) {
    return errors
  }

  const accountIds = validateUniqueIds(handoff.accounts, "account_id", "handoff.accounts", errors)
  validateUniqueIds(
    handoff.opening_positions,
    "position_id",
    "handoff.opening_positions",
    errors,
  )
  const liabilityIds = validateUniqueIds(handoff.liabilities, "liability_id", "handoff.liabilities", errors)
  validateUniqueIds(handoff.onboarding_checklist, "item_id", "handoff.onboarding_checklist", errors)

  for (const position of handoff.opening_positions) {
    if (!accountIds.has(position.account_id)) {
      errors.push(`opening position ${position.position_id} references unknown account ${position.account_id}`)
    }
  }
  for (const accountId of accountIds) {
    if (!handoff.opening_positions.some((position) => position.account_id === accountId)) {
      errors.push(`account ${accountId} requires at least one opening position`)
    }
  }

  for (const liability of handoff.liabilities) {
    if (CARD_LIABILITY_TYPES.has(liability.type) && !accountIds.has(liability.payment_account_id)) {
      errors.push(`liability ${liability.liability_id} references unknown payment account`)
    }
  }

  for (const itemId of REQUIRED_BLOCKING_ITEM_IDS) {
    const item = handoff.onboarding_checklist.find((candidate) => candidate.item_id === itemId)
    if (!item || item.classification !== "blocking" || item.status !== "complete") {
      errors.push(`standard blocking item ${itemId} must be complete`)
    }
  }
  for (const item of handoff.onboarding_checklist) {
    if (item.classification === "blocking" && item.status !== "complete") {
      errors.push(`blocking item ${item.item_id} must be complete`)
    }
    if (item.classification === "confirmed_unknown" && item.status !== "documented") {
      errors.push(`confirmed unknown item ${item.item_id} must be documented`)
    }
  }

  const horizon = handoff.cashflow_horizon
  if (!isObject(horizon)
    || !isObject(horizon.next_income)
    || !Array.isArray(horizon.essential_obligations)
    || !isObject(horizon.payment_capacity)) {
    return errors
  }
  const nextIncomeAt = Date.parse(horizon.next_income.expected_at)
  validateUniqueIds(
    horizon.essential_obligations,
    "obligation_id",
    "handoff.cashflow_horizon.essential_obligations",
    errors,
  )
  for (const obligation of horizon.essential_obligations) {
    if (!accountIds.has(obligation.payment_account_id)) {
      errors.push(`obligation ${obligation.obligation_id} references unknown payment account`)
    }
    if (obligation.source_liability_id && !liabilityIds.has(obligation.source_liability_id)) {
      errors.push(`obligation ${obligation.obligation_id} references unknown liability`)
    }
    if (Number.isFinite(nextIncomeAt) && Date.parse(obligation.due_at) > nextIncomeAt) {
      errors.push(`obligation ${obligation.obligation_id} is due after next income`)
    }
  }

  for (const liability of handoff.liabilities) {
    if (!CARD_LIABILITY_TYPES.has(liability.type) || !liability.next_payment) continue
    if (Date.parse(liability.next_payment.due_at) <= nextIncomeAt) {
      const obligation = horizon.essential_obligations.find((candidate) => {
        return candidate.source_liability_id === liability.liability_id
      })
      if (!obligation
        || obligation.amount?.amount !== liability.next_payment.amount?.amount
        || Date.parse(obligation.due_at) !== Date.parse(liability.next_payment.due_at)
        || obligation.payment_account_id !== liability.payment_account_id) {
        errors.push(`liability ${liability.liability_id} next payment must be included in essential obligations`)
      }
    }
  }

  const immediateAccounts = new Set(
    handoff.accounts
      .filter((account) => account.liquidity === "immediate")
      .map((account) => account.account_id),
  )
  const policyAvailable = handoff.opening_positions.reduce((total, position) => {
    return total + (immediateAccounts.has(position.account_id) && position.policy === "available"
      ? position.value?.amount ?? 0
      : 0)
  }, 0)
  const required = horizon.essential_obligations.reduce((total, obligation) => {
    return total + (obligation.amount?.amount ?? 0)
  }, 0)
  const capacity = horizon.payment_capacity
  if (capacity.policy_available?.amount !== policyAvailable) {
    errors.push("payment_capacity.policy_available does not match opening positions")
  }
  if (capacity.required_before_next_income?.amount !== required) {
    errors.push("payment_capacity.required_before_next_income does not match essential obligations")
  }
  if (capacity.can_cover !== (policyAvailable >= required)) {
    errors.push("payment_capacity.can_cover is inconsistent")
  }

  return errors
}

export function validateHandoff(handoff) {
  if (!isObject(handoff)) return ["handoff must be an object"]
  const schemaErrors = validateJsonSchema(handoff, HANDOFF_SCHEMA, "handoff")
  const securityErrors = findForbiddenPaths(handoff, "handoff").map((path) => `${path} is forbidden`)
  const errors = [
    ...schemaErrors,
    ...securityErrors,
    ...(schemaErrors.length === 0 ? validateSemantics(handoff) : []),
  ]
  return [...new Set(errors)]
}

export function assertValidHandoff(handoff) {
  const errors = validateHandoff(handoff)
  if (errors.length > 0) throw new Error(errors.join("\n"))
  return handoff
}

export function handoffToOpening(handoff) {
  assertValidHandoff(handoff)
  return {
    accounts: structuredClone(handoff.accounts),
    positions: handoff.opening_positions.map(({ value, ...position }) => ({
      ...structuredClone(position),
      amount: value.amount,
    })),
    liabilities: handoff.liabilities.map((liability) => ({
      ...structuredClone(liability),
      principal: liability.principal.amount,
      accrued_interest: liability.accrued_interest.amount,
      fees_due: liability.fees_due.amount,
    })),
    points: [],
  }
}
