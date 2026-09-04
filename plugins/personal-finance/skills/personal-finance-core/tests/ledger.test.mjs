import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  assessSupport,
  projectLedger,
  registerEvent,
  registerPeriodNotification,
} from "../ledger.mjs"
import { handoffToOpening, validateHandoff } from "../handoff.mjs"

const sharedDirectory = fileURLToPath(new URL("..", import.meta.url))

function opening({
  accounts = [{ account_id: "main", label: "생활비", cash_like: true, liquidity: "immediate" }],
  positions = [{ position_id: "main-free", account_id: "main", amount: 100_000, policy: "available" }],
  liabilities = [],
  points = [],
} = {}) {
  return {
    accounts,
    positions,
    liabilities: liabilities.map((liability) => ({
      accrued_interest: 0,
      fees_due: 0,
      ...liability,
    })),
    points,
  }
}

function event(eventId, type, payload, overrides = {}) {
  return {
    event_id: eventId,
    type,
    occurred_at: overrides.occurred_at ?? "2099-01-15T09:00:00+09:00",
    accounting_period_id: overrides.accounting_period_id ?? "2099-01",
    recognition_status: overrides.recognition_status ?? "recognized",
    settlement_status: overrides.settlement_status ?? "not_applicable",
    verification_status: overrides.verification_status ?? "confirmed",
    source: overrides.source ?? { kind: "user", fingerprint: eventId },
    payload,
    ...overrides,
  }
}

test("자유 사용 계좌 간 무배정 자기이체는 합계와 사용 가능액을 바꾸지 않는다", () => {
  const initial = opening({
    accounts: [
      { account_id: "a", label: "주계좌", cash_like: true, liquidity: "immediate" },
      { account_id: "b", label: "보조계좌", cash_like: true, liquidity: "immediate" },
    ],
    positions: [
      { position_id: "a-free", account_id: "a", amount: 100_000, policy: "available" },
      { position_id: "b-free", account_id: "b", amount: 0, policy: "available" },
    ],
  })
  const state = projectLedger(initial, [
    event("transfer", "account_transfer", {
      from_position_id: "a-free",
      to_position_id: "b-free",
      amount: 50_000,
    }),
  ])

  assert.equal(state.positions["a-free"].amount, 50_000)
  assert.equal(state.positions["b-free"].amount, 50_000)
  assert.equal(state.totals.total_assets, 100_000)
  assert.equal(state.totals.net_worth, 100_000)
  assert.equal(state.totals.policy_available, 100_000)
  assert.equal(state.totals.expenses, 0)
})

test("account_transfer는 실제 계좌 leg 사이에서 정책과 배정 identity를 보존한다", () => {
  const sameAccount = opening({
    positions: [
      { position_id: "free", account_id: "main", amount: 10_000, policy: "available" },
      {
        position_id: "allocated",
        account_id: "main",
        amount: 0,
        policy: "allocated",
        allocation_id: "reserve",
      },
    ],
  })
  assert.throws(() => projectLedger(sameAccount, [
    event("same-account", "account_transfer", {
      from_position_id: "free",
      to_position_id: "allocated",
      amount: 1_000,
    }),
  ]), /different accounts/)

  const changedPolicy = opening({
    accounts: [
      { account_id: "a", label: "출금", cash_like: true, liquidity: "immediate" },
      { account_id: "b", label: "입금", cash_like: true, liquidity: "immediate" },
    ],
    positions: [
      { position_id: "a-free", account_id: "a", amount: 10_000, policy: "available" },
      {
        position_id: "b-allocated",
        account_id: "b",
        amount: 0,
        policy: "allocated",
        allocation_id: "reserve",
      },
    ],
  })
  assert.throws(() => projectLedger(changedPolicy, [
    event("changed-policy", "account_transfer", {
      from_position_id: "a-free",
      to_position_id: "b-allocated",
      amount: 1_000,
    }),
  ]), /preserve policy and allocation identity/)
})

test("fund_allocation은 기존 잔액의 배정 identity를 바꾸지 않는다", () => {
  assert.throws(() => projectLedger(opening({
    positions: [
      { position_id: "free", account_id: "main", amount: 10_000, policy: "available" },
      {
        position_id: "allocated",
        account_id: "main",
        amount: 500,
        policy: "allocated",
        allocation_id: "existing-purpose",
      },
    ],
  }), [
    event("relabel", "fund_allocation", {
      from_position_id: "free",
      to_position_id: "allocated",
      allocation_id: "new-purpose",
      amount: 100,
    }),
  ]), /destination allocation identity/)
})

test("자기이체와 목적 자금 배정은 별도 원자 이벤트로 같은 그룹에 연결한다", () => {
  const initial = opening({
    accounts: [
      { account_id: "a", label: "주계좌", cash_like: true, liquidity: "immediate" },
      { account_id: "b", label: "준비금계좌", cash_like: true, liquidity: "immediate" },
    ],
    positions: [
      { position_id: "a-free", account_id: "a", amount: 100_000, policy: "available" },
      { position_id: "b-free", account_id: "b", amount: 0, policy: "available" },
      { position_id: "b-purpose", account_id: "b", amount: 0, policy: "allocated" },
    ],
  })
  const groupId = "group-purpose"
  const events = [
    event("transfer", "account_transfer", {
      from_position_id: "a-free",
      to_position_id: "b-free",
      amount: 50_000,
    }, { event_group_id: groupId }),
    event("allocate", "fund_allocation", {
      from_position_id: "b-free",
      to_position_id: "b-purpose",
      allocation_id: "planned-expense",
      amount: 50_000,
    }, { event_group_id: groupId }),
  ]
  const state = projectLedger(initial, events)

  assert.equal(events[0].event_group_id, events[1].event_group_id)
  assert.deepEqual(state.active_event_ids, ["transfer", "allocate"])
  assert.equal(state.totals.total_assets, 100_000)
  assert.equal(state.totals.net_worth, 100_000)
  assert.equal(state.totals.policy_available, 50_000)
  assert.equal(state.totals.purpose_allocated, 50_000)
})

test("예시 카드 구매와 즉시결제는 지출을 중복하지 않는다", () => {
  const initial = opening({
    liabilities: [
      { liability_id: "card", label: "예시 카드", type: "credit_card", principal: 0 },
    ],
  })
  const purchase = event("purchase", "card_purchase", {
    liability_id: "card",
    amount: 30_000,
  }, { settlement_status: "unsettled" })
  const purchased = projectLedger(initial, [purchase])
  assert.equal(purchased.liabilities.card.principal, 30_000)
  assert.equal(purchased.totals.expenses, 30_000)
  assert.equal(purchased.positions["main-free"].amount, 100_000)

  const paid = projectLedger(initial, [
    purchase,
    event("payment", "card_payment", {
      position_id: "main-free",
      liability_id: "card",
      amount: 30_000,
    }, { settlement_status: "settled" }),
  ])
  assert.equal(paid.positions["main-free"].amount, 70_000)
  assert.equal(paid.liabilities.card.principal, 0)
  assert.equal(paid.totals.expenses, 30_000)
  assert.equal(paid.totals.net_worth, 70_000)
})

test("5,500원을 5,000원으로 정정하면 원본은 보존하고 대체값만 계산한다", () => {
  const original = event("original", "cash_purchase", {
    position_id: "main-free",
    amount: 5_500,
  })
  const correction = event("correction", "cash_purchase", {
    position_id: "main-free",
    amount: 5_000,
  }, { supersedes_event_id: "original" })
  const events = [original, correction]
  const state = projectLedger(opening({
    positions: [{ position_id: "main-free", account_id: "main", amount: 10_000, policy: "available" }],
  }), events)

  assert.equal(events.length, 2)
  assert.deepEqual(state.active_event_ids, ["correction"])
  assert.equal(state.positions["main-free"].amount, 5_000)
  assert.equal(state.totals.expenses, 5_000)
})

test("1월 결제한 2월 교통편은 1월 지출과 2월 일정으로 분리한다", () => {
  const state = projectLedger(opening(), [
    event("ticket", "cash_purchase", {
      position_id: "main-free",
      amount: 70_000,
    }, {
      occurred_at: "2099-01-31T10:00:00+09:00",
      accounting_period_id: "2099-01",
    }),
    event("trip-plan", "plan_created", {
      commitment_id: "sample-trip",
      label: "예시 이동",
    }, {
      occurred_at: "2099-02-15T09:00:00+09:00",
      recognition_status: "planned",
      settlement_status: "not_applicable",
    }),
  ])

  assert.equal(state.expenses_by_period["2099-01"], 70_000)
  assert.equal(state.expenses_by_period["2099-02"] ?? 0, 0)
  assert.equal(state.commitments["sample-trip"].kind, "plan")
})

test("취소 가능한 예약과 취소 수수료 예약을 구분한다", () => {
  const state = projectLedger(opening(), [
    event("service", "reservation_created", {
      commitment_id: "service",
      label: "예시 서비스 예약",
    }, { recognition_status: "planned" }),
    event("restaurant", "conditional_commitment_created", {
      commitment_id: "restaurant",
      label: "예시 장소 예약",
      max_exposure: 20_000,
      condition: "당일 취소",
    }, { recognition_status: "conditional" }),
  ])

  assert.equal(state.commitments.service.kind, "reservation")
  assert.equal(state.commitments.restaurant.kind, "conditional")
  assert.equal(state.commitments.restaurant.max_exposure, 20_000)
  assert.equal(state.totals.expenses, 0)
  assert.equal(state.totals.total_liabilities, 0)
})

test("카드 승인 취소는 원거래 효과를 되돌린다", () => {
  const initial = opening({
    liabilities: [{ liability_id: "card", label: "예시 카드", type: "credit_card", principal: 0 }],
  })
  const state = projectLedger(initial, [
    event("purchase", "card_purchase", { liability_id: "card", amount: 12_000 }, {
      settlement_status: "unsettled",
    }),
    event("cancel", "card_authorization_cancelled", {}, {
      recognition_status: "reversal",
      cancels_event_id: "purchase",
    }),
  ])

  assert.equal(state.liabilities.card.principal, 0)
  assert.equal(state.totals.expenses, 0)
  assert.deepEqual(state.active_event_ids, ["cancel"])
})

test("취소 이벤트를 취소하면 원거래 효과가 복원된다", () => {
  const state = projectLedger(opening({
    positions: [{ position_id: "main-free", account_id: "main", amount: 10_000, policy: "available" }],
  }), [
    event("purchase", "cash_purchase", { position_id: "main-free", amount: 1_000 }),
    event("cancel", "event_cancelled", {}, {
      recognition_status: "reversal",
      cancels_event_id: "purchase",
    }),
    event("cancel-cancel", "event_cancelled", {}, {
      recognition_status: "reversal",
      cancels_event_id: "cancel",
    }),
  ])

  assert.equal(state.positions["main-free"].amount, 9_000)
  assert.equal(state.totals.expenses, 1_000)
  assert.deepEqual(state.active_event_ids, ["purchase", "cancel-cancel"])
})

test("대체된 취소의 기존 target은 복원되고 새 target만 비활성화된다", () => {
  const state = projectLedger(opening({
    positions: [{ position_id: "main-free", account_id: "main", amount: 10_000, policy: "available" }],
  }), [
    event("purchase-a", "cash_purchase", { position_id: "main-free", amount: 1_000 }),
    event("purchase-b", "cash_purchase", { position_id: "main-free", amount: 2_000 }),
    event("old-cancel", "event_cancelled", {}, {
      recognition_status: "reversal",
      cancels_event_id: "purchase-a",
    }),
    event("new-cancel", "event_cancelled", {}, {
      recognition_status: "reversal",
      supersedes_event_id: "old-cancel",
      cancels_event_id: "purchase-b",
    }),
  ])

  assert.equal(state.positions["main-free"].amount, 9_000)
  assert.equal(state.totals.expenses, 1_000)
  assert.deepEqual(state.active_event_ids, ["purchase-a", "new-cancel"])
})

test("취소·대체 관계 cycle은 replay 전에 거부한다", () => {
  assert.throws(() => projectLedger(opening(), [
    event("cancel-a", "event_cancelled", {}, {
      recognition_status: "reversal",
      cancels_event_id: "cancel-b",
    }),
    event("cancel-b", "event_cancelled", {}, {
      recognition_status: "reversal",
      cancels_event_id: "cancel-a",
    }),
  ]), /event relationship cycle/)
})

test("pending·rejected 관계는 파생 상태와 관계 무결성에 영향을 주지 않는다", () => {
  for (const verificationStatus of ["pending", "rejected"]) {
    const state = projectLedger(opening(), [
      event(`${verificationStatus}-relation`, "cash_purchase", {
        position_id: "main-free",
        amount: 1_000,
      }, {
        verification_status: verificationStatus,
        supersedes_event_id: "unknown-event",
      }),
    ])
    assert.equal(state.positions["main-free"].amount, 100_000)
    assert.deepEqual(state.active_event_ids, [])
  }
})

test("한 target의 active supersession fork는 거부한다", () => {
  assert.throws(() => projectLedger(opening(), [
    event("original", "cash_purchase", { position_id: "main-free", amount: 1_000 }),
    event("correction-a", "cash_purchase", { position_id: "main-free", amount: 900 }, {
      supersedes_event_id: "original",
    }),
    event("correction-b", "cash_purchase", { position_id: "main-free", amount: 800 }, {
      supersedes_event_id: "original",
    }),
  ]), /multiple active superseding events/)
})

test("취소 관계는 top-level cancels_event_id만 허용한다", () => {
  const purchase = event("purchase", "cash_purchase", {
    position_id: "main-free",
    amount: 1_000,
  })
  assert.throws(() => projectLedger(opening(), [
    purchase,
    event("payload-cancel", "event_cancelled", { cancels_event_id: "purchase" }, {
      recognition_status: "reversal",
    }),
  ]), /event.payload matches a forbidden schema/)
  assert.throws(() => projectLedger(opening(), [
    purchase,
    event("missing-cancel", "event_cancelled", {}, { recognition_status: "reversal" }),
  ]), /event.cancels_event_id is required/)
})

test("이전 기간 환불은 기타수입이 아니라 원지출 반대 효과다", () => {
  const initial = opening({
    positions: [{ position_id: "main-free", account_id: "main", amount: 20_000, policy: "available" }],
  })
  const state = projectLedger(initial, [
    event("aug-purchase", "cash_purchase", { position_id: "main-free", amount: 10_000 }, {
      accounting_period_id: "2099-01",
    }),
    event("sep-refund", "refund", {
      source_event_id: "aug-purchase",
      position_id: "main-free",
      amount: 10_000,
    }, {
      accounting_period_id: "2099-02",
      recognition_status: "reversal",
    }),
  ])

  assert.equal(state.positions["main-free"].amount, 20_000)
  assert.equal(state.totals.expenses, 0)
  assert.equal(state.totals.other_income, 0)
  assert.equal(state.expenses_by_period["2099-01"], 10_000)
  assert.equal(state.expenses_by_period["2099-02"], -10_000)
})

test("누적 환불은 원거래 금액을 넘을 수 없다", () => {
  assert.throws(() => projectLedger(opening(), [
    event("purchase", "cash_purchase", { position_id: "main-free", amount: 10_000 }),
    event("refund-1", "refund", {
      source_event_id: "purchase",
      position_id: "main-free",
      amount: 7_000,
    }, { recognition_status: "reversal" }),
    event("refund-2", "refund", {
      source_event_id: "purchase",
      position_id: "main-free",
      amount: 4_000,
    }, { recognition_status: "reversal" }),
  ]), /refund exceeds source amount/)
})

for (const sourceEventId of ["__proto__", "constructor"]) {
  test(`${sourceEventId} event_id도 누적 환불 상한을 우회할 수 없다`, () => {
    const initial = opening({
      positions: [{ position_id: "main-free", account_id: "main", amount: 10_000, policy: "available" }],
    })
    const purchase = event(sourceEventId, "cash_purchase", { position_id: "main-free", amount: 1_000 })
    const firstRefund = event("refund-1", "refund", {
      source_event_id: sourceEventId,
      position_id: "main-free",
      amount: 700,
    }, { recognition_status: "reversal" })
    const state = projectLedger(initial, [purchase, firstRefund])
    const roundTripped = JSON.parse(JSON.stringify(state))
    assert.equal(Object.hasOwn(roundTripped.refunded_by_source, sourceEventId), true)
    assert.equal(roundTripped.refunded_by_source[sourceEventId], 700)

    assert.throws(() => projectLedger(initial, [
      purchase,
      firstRefund,
      event("refund-2", "refund", {
        source_event_id: sourceEventId,
        position_id: "main-free",
        amount: 700,
      }, { recognition_status: "reversal" }),
    ]), /refund exceeds source amount/)
  })
}

test("reserved ID lookup과 동적 state record 쓰기는 prototype을 건드리지 않는다", () => {
  const amountDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "amount")
  const principalDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "principal")
  const constructorBefore = Object.prototype.constructor
  const toStringBefore = Object.prototype.toString
  try {
    for (const reservedId of ["__proto__", "constructor", "toString"]) {
      assert.throws(() => projectLedger(opening({
        positions: [{ position_id: "main-free", account_id: "main", amount: 10_000, policy: "available" }],
      }), [
        event(`unknown-position-${reservedId}`, "cash_purchase", {
          position_id: reservedId,
          amount: 1_000,
        }),
      ]), new RegExp(`unknown position: ${reservedId}`))
      assert.throws(() => projectLedger(opening(), [
        event(`unknown-liability-${reservedId}`, "card_purchase", {
          liability_id: reservedId,
          amount: 1_000,
        }, { settlement_status: "unsettled" }),
      ]), new RegExp(`unknown liability: ${reservedId}`))
    }

    const events = []
    for (const [index, reservedId] of ["__proto__", "constructor", "toString"].entries()) {
      events.push(
        event(`points-${index}`, "points_earned", { program_id: reservedId, amount: 1 }, {
          recognition_status: "not_applicable",
        }),
        event(`commitment-${index}`, "plan_created", {
          commitment_id: reservedId,
          label: `계획 ${index}`,
        }, { recognition_status: "planned" }),
        event(`expense-${index}`, "cash_purchase", { position_id: "main-free", amount: 1 }, {
          accounting_period_id: reservedId,
        }),
      )
    }
    const state = projectLedger(opening(), events)
    for (const reservedId of ["__proto__", "constructor", "toString"]) {
      assert.equal(Object.hasOwn(state.points, reservedId), true)
      assert.equal(state.points[reservedId], 1)
      assert.equal(Object.hasOwn(state.commitments, reservedId), true)
      assert.equal(state.commitments[reservedId].kind, "plan")
      assert.equal(Object.hasOwn(state.expenses_by_period, reservedId), true)
      assert.equal(state.expenses_by_period[reservedId], 1)
    }
    assert.equal(Object.hasOwn(Object.prototype, "amount"), Boolean(amountDescriptor))
    assert.equal(Object.hasOwn(Object.prototype, "principal"), Boolean(principalDescriptor))
    assert.equal(Object.prototype.constructor, constructorBefore)
    assert.equal(Object.prototype.toString, toStringBefore)
  } finally {
    if (amountDescriptor) Object.defineProperty(Object.prototype, "amount", amountDescriptor)
    else delete Object.prototype.amount
    if (principalDescriptor) Object.defineProperty(Object.prototype, "principal", principalDescriptor)
    else delete Object.prototype.principal
  }
})

for (const sourceStatus of ["pending", "rejected"]) {
  test(`${sourceStatus} 원거래는 confirmed 환불의 원본이 될 수 없다`, () => {
    assert.throws(() => projectLedger(opening(), [
      event("purchase", "cash_purchase", { position_id: "main-free", amount: 1_000 }, {
        verification_status: sourceStatus,
      }),
      event("refund", "refund", {
        source_event_id: "purchase",
        position_id: "main-free",
        amount: 1_000,
      }, { recognition_status: "reversal" }),
    ]), /refund source must be an active confirmed purchase/)
  })
}

test("취소되거나 대체된 원거래는 환불 원본이 될 수 없다", () => {
  assert.throws(() => projectLedger(opening(), [
    event("cancelled-purchase", "cash_purchase", { position_id: "main-free", amount: 1_000 }),
    event("cancel", "event_cancelled", {}, {
      recognition_status: "reversal",
      cancels_event_id: "cancelled-purchase",
    }),
    event("refund", "refund", {
      source_event_id: "cancelled-purchase",
      position_id: "main-free",
      amount: 1_000,
    }, { recognition_status: "reversal" }),
  ]), /refund source must be an active confirmed purchase/)

  assert.throws(() => projectLedger(opening(), [
    event("old-purchase", "cash_purchase", { position_id: "main-free", amount: 1_000 }),
    event("corrected-purchase", "cash_purchase", { position_id: "main-free", amount: 900 }, {
      supersedes_event_id: "old-purchase",
    }),
    event("refund", "refund", {
      source_event_id: "old-purchase",
      position_id: "main-free",
      amount: 900,
    }, { recognition_status: "reversal" }),
  ]), /refund source must be an active confirmed purchase/)
})

test("확정됐지만 구매가 아닌 이벤트는 환불 원본이 될 수 없다", () => {
  assert.throws(() => projectLedger(opening(), [
    event("income", "income_received", {
      position_id: "main-free",
      amount: 1_000,
      income_kind: "other",
    }),
    event("refund", "refund", {
      source_event_id: "income",
      position_id: "main-free",
      amount: 1_000,
    }, { recognition_status: "reversal" }),
  ]), /refund source must be an active confirmed purchase/)
})

test("이체 수수료는 자기이체와 분리된 지출이다", () => {
  const initial = opening({
    accounts: [
      { account_id: "a", label: "주계좌", cash_like: true, liquidity: "immediate" },
      { account_id: "b", label: "보조계좌", cash_like: true, liquidity: "immediate" },
    ],
    positions: [
      { position_id: "a-free", account_id: "a", amount: 10_000, policy: "available" },
      { position_id: "b-free", account_id: "b", amount: 0, policy: "available" },
    ],
  })
  const state = projectLedger(initial, [
    event("transfer", "account_transfer", {
      from_position_id: "a-free",
      to_position_id: "b-free",
      amount: 5_000,
    }, { event_group_id: "transfer-group" }),
    event("fee", "transfer_fee", {
      position_id: "a-free",
      amount: 500,
    }, { event_group_id: "transfer-group" }),
  ])

  assert.equal(state.totals.total_assets, 9_500)
  assert.equal(state.totals.expenses, 500)
  assert.equal(state.totals.net_worth, 9_500)
})

test("포인트와 캐시백은 현금 중심 기본 정책을 따른다", () => {
  const initial = opening({
    positions: [{ position_id: "main-free", account_id: "main", amount: 1_000, policy: "available" }],
    liabilities: [{ liability_id: "card", label: "예시 카드", type: "credit_card", principal: 0 }],
    points: [{ program_id: "card-points", balance: 0 }],
  })
  const state = projectLedger(initial, [
    event("earn", "points_earned", { program_id: "card-points", amount: 5_000 }, {
      recognition_status: "not_applicable",
    }),
    event("use", "points_used", { program_id: "card-points", amount: 1_000 }, {
      recognition_status: "not_applicable",
    }),
    event("net-purchase", "card_purchase", { liability_id: "card", amount: 500 }, {
      settlement_status: "unsettled",
    }),
    event("expire", "points_expired", { program_id: "card-points", amount: 400 }, {
      recognition_status: "not_applicable",
    }),
    event("cash-out", "points_cash_out", {
      program_id: "card-points",
      position_id: "main-free",
      amount: 2_000,
    }),
    event("cashback", "cashback_deposit", { position_id: "main-free", amount: 300 }),
  ])

  assert.equal(state.points["card-points"], 1_600)
  assert.equal(state.positions["main-free"].amount, 3_300)
  assert.equal(state.liabilities.card.principal, 500)
  assert.equal(state.totals.expenses, 500)
  assert.equal(state.totals.other_income, 2_300)
})

test("할부 구매는 원금만 등록하고 분할금 납부마다 원금을 줄인다", () => {
  const state = projectLedger(opening({
    liabilities: [{ liability_id: "installment", label: "할부", type: "installment", principal: 0 }],
  }), [
    event("installment-buy", "installment_purchase", {
      liability_id: "installment",
      amount: 30_000,
    }, { settlement_status: "unsettled" }),
    event("installment-payment", "debt_payment", {
      liability_id: "installment",
      position_id: "main-free",
      principal: 10_000,
    }, { settlement_status: "partially_settled" }),
    event("installment-refund", "refund", {
      amount: 5_000,
      liability_id: "installment",
      source_event_id: "installment-buy",
    }, { recognition_status: "reversal" }),
  ])

  assert.equal(state.liabilities.installment.principal, 15_000)
  assert.equal(state.totals.expenses, 0)
  assert.equal(state.positions["main-free"].amount, 90_000)
  assert.equal(state.expenses_by_period["2099-01"] ?? 0, 0)
})

test("카드와 할부 구매는 같은 유형의 부채만 늘린다", () => {
  const initial = opening({
    liabilities: [
      { liability_id: "card", label: "카드", type: "credit_card", principal: 0 },
      { liability_id: "installment", label: "할부", type: "installment", principal: 0 },
    ],
  })
  assert.throws(() => projectLedger(initial, [
    event("wrong-card", "card_purchase", {
      amount: 10_000,
      liability_id: "installment",
    }, { settlement_status: "unsettled" }),
  ]), /card purchase requires a credit card liability/)
  assert.throws(() => projectLedger(initial, [
    event("wrong-installment", "installment_purchase", {
      amount: 10_000,
      liability_id: "card",
    }, { settlement_status: "unsettled" }),
  ]), /installment purchase requires an installment liability/)
})

for (const liabilityType of ["installment", "revolving", "cash_advance", "card_loan"]) {
  test(`${liabilityType} 원금과 이자·수수료 상환 효과를 분리한다`, () => {
    const initial = opening({
      liabilities: [{
        liability_id: "debt",
        label: liabilityType,
        type: liabilityType,
        principal: 10_000,
      }],
    })
    const state = projectLedger(initial, [
      event("charge", "finance_charge", {
        liability_id: "debt",
        interest: 1_000,
        fees: 100,
      }, { event_group_id: "statement", settlement_status: "unsettled" }),
      event("repay", "debt_payment", {
        position_id: "main-free",
        liability_id: "debt",
        principal: 2_000,
        interest: 1_000,
        fees: 100,
      }, { event_group_id: "statement", settlement_status: "partially_settled" }),
    ])

    assert.equal(state.positions["main-free"].amount, 96_900)
    assert.equal(state.liabilities.debt.principal, 8_000)
    assert.equal(state.liabilities.debt.accrued_interest, 0)
    assert.equal(state.liabilities.debt.fees_due, 0)
    assert.equal(state.totals.expenses, 1_100)
    assert.equal(state.totals.total_liabilities, 8_000)
  })
}

test("현금서비스와 카드론 실행은 현금과 원금을 늘리지만 수입은 만들지 않는다", () => {
  const state = projectLedger(opening({
    liabilities: [{ liability_id: "loan", label: "카드론", type: "card_loan", principal: 0 }],
  }), [
    event("draw", "debt_draw", {
      position_id: "main-free",
      liability_id: "loan",
      principal: 20_000,
    }, { settlement_status: "unsettled" }),
  ])

  assert.equal(state.positions["main-free"].amount, 120_000)
  assert.equal(state.liabilities.loan.principal, 20_000)
  assert.equal(state.totals.net_worth, 100_000)
  assert.equal(state.totals.earned_income + state.totals.other_income, 0)
})

test("리볼빙 전환은 부채 원금 위치만 바꾸고 총부채와 지출을 늘리지 않는다", () => {
  const state = projectLedger(opening({
    liabilities: [
      { liability_id: "card", label: "카드", type: "credit_card", principal: 20_000 },
      { liability_id: "revolving", label: "리볼빙", type: "revolving", principal: 0 },
    ],
  }), [
    event("revolve", "liability_transfer", {
      from_liability_id: "card",
      to_liability_id: "revolving",
      principal: 15_000,
    }),
  ])

  assert.equal(state.liabilities.card.principal, 5_000)
  assert.equal(state.liabilities.revolving.principal, 15_000)
  assert.equal(state.totals.total_liabilities, 20_000)
  assert.equal(state.totals.expenses, 0)
})

test("OCR 재가져오기는 멱등 처리하고 수동 동일금액 거래는 후보 확인 후 별도로 받는다", () => {
  const imported = event("ocr-1", "cash_purchase", {
    position_id: "main-free",
    amount: 10_000,
  }, {
    verification_status: "pending",
    source: {
      kind: "ocr",
      system: "receipt-reader",
      external_id: "sample-receipt-line",
      fingerprint: "2099-01-15|10000|sample",
    },
  })
  const first = registerEvent([], imported)
  assert.equal(first.status, "accepted")

  const duplicateImport = registerEvent(first.events, {
    ...imported,
    event_id: "ocr-2",
  })
  assert.equal(duplicateImport.status, "duplicate")
  assert.equal(duplicateImport.existing_event_id, "ocr-1")

  const confirmed = event("ocr-confirmed", "cash_purchase", {
    position_id: "main-free",
    amount: 10_000,
  }, {
    supersedes_event_id: "ocr-1",
    source: imported.source,
  })
  const confirmation = registerEvent(first.events, confirmed)
  assert.equal(confirmation.status, "accepted")
  assert.equal(confirmation.events.length, 2)
  assert.equal(confirmation.events[0].verification_status, "pending")
  assert.equal(projectLedger(opening(), confirmation.events).positions["main-free"].amount, 90_000)

  const confirmationRetry = registerEvent(confirmation.events, {
    ...confirmed,
    event_id: "ocr-confirmed-retry",
  })
  assert.equal(confirmationRetry.status, "duplicate")
  assert.equal(confirmationRetry.existing_event_id, "ocr-confirmed")

  const manual = event("manual-separate", "cash_purchase", {
    position_id: "main-free",
    amount: 10_000,
  }, {
    source: { kind: "user", fingerprint: "2099-01-15|10000|sample" },
  })
  const candidate = registerEvent(first.events, manual)
  assert.equal(candidate.status, "needs_duplicate_confirmation")
  assert.deepEqual(candidate.candidate_event_ids, ["ocr-1"])

  const confirmedSeparate = registerEvent(first.events, { ...manual, duplicate_reviewed: true })
  assert.equal(confirmedSeparate.status, "accepted")
  assert.equal(confirmedSeparate.events.length, 2)
  assert.throws(() => registerEvent(first.events, { ...manual, event_id: "ocr-1" }), /duplicate event_id/)
})

test("source.external_id는 non-empty system과 함께 provider identity를 구성한다", () => {
  const payload = { position_id: "main-free", amount: 1_000 }
  assert.throws(() => registerEvent([], event("missing-system", "cash_purchase", payload, {
    source: { kind: "api", external_id: "transaction-1" },
  })), /event.source.system is required/)
  assert.throws(() => registerEvent([], event("empty-system", "cash_purchase", payload, {
    source: { kind: "api", system: "", external_id: "transaction-1" },
  })), /event.source.system must have at least 1 characters/)

  const providerA = event("provider-a", "cash_purchase", payload, {
    source: { kind: "api", system: "provider-a", external_id: "transaction-1" },
  })
  const first = registerEvent([], providerA)
  const second = registerEvent(first.events, event("provider-b", "cash_purchase", payload, {
    source: { kind: "api", system: "provider-b", external_id: "transaction-1" },
  }))
  assert.equal(second.status, "accepted")
  assert.equal(second.events.length, 2)

  const duplicate = registerEvent(second.events, { ...providerA, event_id: "provider-a-retry" })
  assert.equal(duplicate.status, "duplicate")
  assert.equal(duplicate.existing_event_id, "provider-a")
})

test("registerEvent는 상태 비의존 payload 오류를 append 전에 거부한다", () => {
  const stored = []
  const invalidEvents = [
    event("string-money", "cash_purchase", { position_id: "main-free", amount: "1000" }, {
      verification_status: "pending",
      source: { kind: "ocr", fingerprint: "string-money" },
    }),
    event("invalid-id", "cash_purchase", { position_id: 123, amount: 1_000 }),
    event("invalid-enum", "income_received", {
      position_id: "main-free",
      amount: 1_000,
      income_kind: "salary",
    }),
    event("invalid-time", "firm_commitment_created", {
      commitment_id: "firm",
      label: "확정 약정",
      amount: 1_000,
      due_at: "not-a-date",
    }, { recognition_status: "planned" }),
    event("invalid-component", "debt_payment", {
      position_id: "main-free",
      liability_id: "debt",
      principal: "1000",
    }, { settlement_status: "settled" }),
  ]

  for (const invalidEvent of invalidEvents) assert.throws(() => registerEvent(stored, invalidEvent))
  assert.deepEqual(stored, [])
})

test("registerEvent는 confirmed 관계와 pending 확인 identity를 append 전에 검증한다", () => {
  const pending = event("pending", "cash_purchase", {
    position_id: "main-free",
    amount: 1_000,
  }, {
    verification_status: "pending",
    source: { kind: "ocr", system: "reader", external_id: "receipt-1" },
  })
  const stored = registerEvent([], pending).events

  assert.throws(() => registerEvent(stored, event("wrong-source", "cash_purchase", {
    position_id: "main-free",
    amount: 1_000,
  }, {
    supersedes_event_id: "pending",
    source: { kind: "user", fingerprint: "manual" },
  })), /same source identity/)
  assert.throws(() => registerEvent(stored, event("unknown-target", "cash_purchase", {
    position_id: "main-free",
    amount: 1_000,
  }, {
    supersedes_event_id: "missing",
    source: { kind: "user", fingerprint: "correction" },
  })), /unknown superseded event/)
  assert.equal(stored.length, 1)
})

test("포인트 이벤트는 양의 정수만 허용한다", () => {
  assert.throws(() => projectLedger(opening(), [
    event("invalid-points", "points_earned", { program_id: "points", amount: -1 }, {
      recognition_status: "not_applicable",
    }),
  ]), /payload.amount/)
})

test("이벤트는 금지 키와 잘못된 ISO date-time을 거부한다", () => {
  assert.throws(() => projectLedger(opening(), [
    event("secret", "cash_purchase", {
      position_id: "main-free",
      amount: 1_000,
      account_number: "synthetic-account-number",
    }),
  ]), /event.payload.account_number is forbidden/)
  assert.throws(() => projectLedger(opening(), [
    event("camel-secret", "cash_purchase", {
      position_id: "main-free",
      amount: 1_000,
      accountNumber: "synthetic-account-number",
    }),
  ]), /event.payload.accountNumber is forbidden/)
  assert.throws(() => projectLedger(opening(), [
    event("hyphen-secret", "cash_purchase", {
      position_id: "main-free",
      amount: 1_000,
      "account-number": "synthetic-account-number",
    }),
  ]), /event.payload.account-number is forbidden/)
  assert.throws(() => projectLedger(opening(), [
    event("bad-date", "cash_purchase", { position_id: "main-free", amount: 1_000 }, {
      occurred_at: "2099-02-30T09:00:00+09:00",
    }),
  ]), /event.occurred_at must be an ISO date-time/)
})

test("깊게 중첩된 open payload metadata도 call stack을 소진하지 않고 검사한다", () => {
  const metadata = {}
  let cursor = metadata
  for (let depth = 0; depth < 10_001; depth += 1) {
    cursor.child = {}
    cursor = cursor.child
  }
  assert.doesNotThrow(() => projectLedger(opening(), [
    event("deep-metadata", "cash_purchase", {
      position_id: "main-free",
      amount: 1_000,
      metadata,
    }),
  ]))
})

test("이벤트 스키마는 unknown top-level과 source 필드를 거부하고 payload 확장은 허용한다", () => {
  assert.throws(() => projectLedger(opening(), [
    event("unknown-top", "cash_purchase", { position_id: "main-free", amount: 1_000 }, {
      unexpected: true,
    }),
  ]), /event.unexpected is not allowed/)
  assert.throws(() => projectLedger(opening(), [
    event("unknown-source", "cash_purchase", { position_id: "main-free", amount: 1_000 }, {
      source: { kind: "user", unexpected: true },
    }),
  ]), /event.source.unexpected is not allowed/)
  assert.doesNotThrow(() => projectLedger(opening(), [
    event("open-payload", "cash_purchase", {
      position_id: "main-free",
      amount: 1_000,
      merchant_label: "테스트 상점",
    }),
  ]))
})

test("이벤트 유형과 모순되는 인식·결제 상태는 replay 전에 거부한다", () => {
  const initial = opening({
    positions: [{ position_id: "main-free", account_id: "main", amount: 10_000, policy: "available" }],
  })
  const invalidEvents = [
    event("planned-cash", "cash_purchase", { position_id: "main-free", amount: 1_000 }, {
      recognition_status: "planned",
    }),
    event("recognized-refund", "refund", { source_event_id: "purchase", amount: 1_000 }),
    event("recognized-plan", "plan_created", { commitment_id: "plan", label: "계획" }),
    event("planned-condition", "conditional_commitment_created", {
      commitment_id: "conditional",
      label: "조건부",
      max_exposure: 1_000,
    }, { recognition_status: "planned" }),
    event("recognized-points", "points_earned", { program_id: "points", amount: 1 }),
    event("settled-card-purchase", "card_purchase", { liability_id: "card", amount: 1_000 }, {
      settlement_status: "settled",
    }),
    event("unsettled-card-payment", "card_payment", {
      position_id: "main-free",
      liability_id: "card",
      amount: 1_000,
    }, { settlement_status: "unsettled" }),
    event("unsettled-cash", "cash_purchase", { position_id: "main-free", amount: 1_000 }, {
      settlement_status: "unsettled",
    }),
  ]

  for (const invalidEvent of invalidEvents) {
    assert.throws(() => projectLedger(initial, [invalidEvent]), /event\.(recognition|settlement)_status/)
  }
  assert.equal(initial.positions[0].amount, 10_000)
})

test("확인 전 자동 추출 이벤트는 합계에 반영하지 않는다", () => {
  const state = projectLedger(opening(), [
    event("pending", "cash_purchase", { position_id: "main-free", amount: 50_000 }, {
      verification_status: "pending",
      source: { kind: "ocr", fingerprint: "pending" },
    }),
  ])
  assert.equal(state.totals.total_assets, 100_000)
  assert.equal(state.totals.expenses, 0)
  assert.deepEqual(state.active_event_ids, [])
})

test("period_id마다 능동 알림을 한 번만 기록한다", () => {
  const first = registerPeriodNotification([], {
    period_id: "2099-W01",
    created_at: "2099-01-04T20:00:00+09:00",
  })
  assert.equal(first.status, "created")

  const retry = registerPeriodNotification(first.notifications, {
    period_id: "2099-W01",
    created_at: "2099-01-05T20:00:00+09:00",
  })
  assert.equal(retry.status, "already_notified")

  const next = registerPeriodNotification(first.notifications, {
    period_id: "2099-W02",
    created_at: "2099-01-11T20:00:00+09:00",
    backlog_period_ids: ["2099-W01"],
  })
  assert.equal(next.status, "created")
  assert.equal(next.notifications.length, 2)
})

test("제한 지원과 전문 지원 전환 조건을 판정한다", () => {
  const limited = assessSupport({
    as_of: "2099-01-15T10:00:00+09:00",
    next_income_at: "2099-01-25T09:00:00+09:00",
    policy_available: 40_000,
    required_before_next_income: 50_000,
    obligations: [{ due_at: "2099-01-20T09:00:00+09:00", amount: 50_000, unpaid: true }],
    consecutive_deficit_periods: 2,
    deficit_period_threshold: 2,
    requested_scopes: [],
  })
  assert.equal(limited.level, "limited")
  assert.ok(limited.reasons.includes("essential_cash_shortfall"))
  assert.ok(limited.reasons.includes("repeated_cashflow_deficit"))

  const specialist = assessSupport({
    as_of: "2099-01-15T10:00:00+09:00",
    next_income_at: "2099-01-25T09:00:00+09:00",
    policy_available: 100_000,
    required_before_next_income: 50_000,
    obligations: [],
    consecutive_deficit_periods: 0,
    deficit_period_threshold: 2,
    requested_scopes: ["debt_restructuring"],
  })
  assert.equal(specialist.level, "specialist")
  assert.deepEqual(specialist.specialist_reasons, ["debt_restructuring"])
})

test("합성된 버전 인계 데이터는 기준시점, 값 성격, 완료 등급을 검증한다", () => {
  const handoff = {
    schema_version: "1.0.0",
    created_at: "2099-01-15T10:00:00+09:00",
    profile: {
      lifecycle_stage: "early_career",
      currency: "KRW",
      timezone: "Asia/Seoul",
      income_pattern: "regular",
    },
    snapshot: { as_of: "2099-01-15T09:00:00+09:00" },
    accounts: [
      { account_id: "main", label: "예시 계좌", cash_like: true, liquidity: "immediate" },
    ],
    opening_positions: [{
      position_id: "main-free",
      account_id: "main",
      policy: "available",
      allocation_id: null,
      value: {
        amount: 1_000_000,
        value_kind: "exact",
        observed_at: "2099-01-15T09:00:00+09:00",
        next_review_at: null,
      },
    }],
    liabilities: [{
      liability_id: "sample-card",
      label: "예시 카드",
      type: "credit_card",
      principal: {
        amount: 100_000,
        value_kind: "exact",
        observed_at: "2099-01-15T09:00:00+09:00",
        next_review_at: null,
      },
      accrued_interest: {
        amount: 0,
        value_kind: "exact",
        observed_at: "2099-01-15T09:00:00+09:00",
        next_review_at: null,
      },
      fees_due: {
        amount: 0,
        value_kind: "exact",
        observed_at: "2099-01-15T09:00:00+09:00",
        next_review_at: null,
      },
      payment_account_id: "main",
      next_payment: {
        amount: {
          amount: 100_000,
          value_kind: "exact",
          observed_at: "2099-01-15T09:00:00+09:00",
          next_review_at: null,
        },
        due_at: "2099-01-20T09:00:00+09:00",
      },
      overdue: false,
    }],
    recurring_flows: [],
    cashflow_horizon: {
      next_income: {
        source_label: "예시 급여",
        amount: {
          amount: 3_000_000,
          value_kind: "exact",
          observed_at: "2099-01-15T09:00:00+09:00",
          next_review_at: null,
        },
        expected_at: "2099-01-25T09:00:00+09:00",
      },
      essential_obligations: [{
        obligation_id: "sample-card-payment",
        label: "예시 카드대금",
        amount: {
          amount: 100_000,
          value_kind: "exact",
          observed_at: "2099-01-15T09:00:00+09:00",
          next_review_at: null,
        },
        due_at: "2099-01-20T09:00:00+09:00",
        payment_account_id: "main",
        source_liability_id: "sample-card",
      }],
      payment_capacity: {
        policy_available: {
          amount: 1_000_000,
          value_kind: "exact",
          observed_at: "2099-01-15T09:00:00+09:00",
          next_review_at: null,
        },
        required_before_next_income: {
          amount: 100_000,
          value_kind: "exact",
          observed_at: "2099-01-15T09:00:00+09:00",
          next_review_at: null,
        },
        can_cover: true,
        assessed_at: "2099-01-15T09:00:00+09:00",
      },
    },
    goals: [],
    budget_policy: {
      protected_categories: ["의료"],
      point_policy: "cash_centered",
      refund_period_policy: "receipt",
    },
    operations: {
      execution_mode: "direct",
      settlement_cadence: "weekly",
      notification_time: null,
      notification_weekday: null,
      last_closed_period_id: null,
    },
    risk_rules: { deficit_period_threshold: 2 },
    onboarding_checklist: [
      { item_id: "snapshot", classification: "blocking", status: "complete", note: "확인" },
      {
        item_id: "accounts_and_positions",
        classification: "blocking",
        status: "complete",
        note: "확인",
      },
      { item_id: "liabilities", classification: "blocking", status: "complete", note: "확인" },
      { item_id: "next_income", classification: "blocking", status: "complete", note: "확인" },
      {
        item_id: "essential_obligations",
        classification: "blocking",
        status: "complete",
        note: "확인",
      },
      { item_id: "payment_capacity", classification: "blocking", status: "complete", note: "확인" },
      {
        item_id: "sample-utility",
        classification: "confirmed_unknown",
        status: "documented",
        note: "합성 미정값",
      },
      { item_id: "sample-follow-up", classification: "follow_up", status: "pending", note: "예시" },
    ],
    follow_ups: [],
    storage: { adapter: "unconfigured", location: null },
  }

  assert.deepEqual(validateHandoff(handoff), [])
  const projectedOpening = projectLedger(handoffToOpening(handoff), [])
  assert.equal(projectedOpening.totals.total_assets, 1_000_000)
  assert.equal(projectedOpening.totals.total_liabilities, 100_000)
  assert.equal(projectedOpening.totals.net_worth, 900_000)
  assert.throws(() => projectLedger(handoff, []), /handoffToOpening/)

  for (const field of ["principal", "accrued_interest", "fees_due"]) {
    const rawOpening = opening({
      liabilities: [{
        liability_id: "raw-debt",
        label: "직접 부채",
        type: "general_debt",
        principal: 1_000,
        accrued_interest: 0,
        fees_due: 0,
      }],
    })
    delete rawOpening.liabilities[0][field]
    assert.throws(() => projectLedger(rawOpening, []), new RegExp(`liability\\.${field}`))
  }
  const invalid = structuredClone(handoff)
  invalid.onboarding_checklist[0].status = "pending"
  const errors = validateHandoff(invalid)
  assert.ok(errors.some((error) => error.includes("blocking item snapshot must be complete")))

  const secret = structuredClone(handoff)
  secret.opening_positions[0].value.account_number = "synthetic-account-number"
  assert.ok(validateHandoff(secret).some((error) => error.includes("account_number is forbidden")))

  for (const key of [
    "bank_account_number",
    "client_secret",
    "auth_token",
    "bank_password",
    "provider_api_key",
    "bank_login_id",
    "backup_otp",
    "processor_cvc",
    "processor_cvv",
  ]) {
    const qualifiedSecret = structuredClone(handoff)
    qualifiedSecret.goals = [{ [key]: "leak" }]
    assert.ok(validateHandoff(qualifiedSecret).some((error) => error.includes(`${key} is forbidden`)))
  }
  const safeReference = structuredClone(handoff)
  safeReference.goals = [{ payment_account_id: "main" }]
  assert.deepEqual(validateHandoff(safeReference), [])

  const missing = structuredClone(handoff)
  delete missing.accounts
  assert.ok(validateHandoff(missing).some((error) => error === "handoff.accounts is required"))

  const sparse = structuredClone(handoff)
  delete sparse.profile.currency
  delete sparse.profile.timezone
  sparse.accounts = []
  sparse.opening_positions = []
  sparse.liabilities = []
  sparse.onboarding_checklist = []
  const sparseErrors = validateHandoff(sparse)
  assert.ok(sparseErrors.some((error) => error === "handoff.profile.currency is required"))
  assert.ok(sparseErrors.some((error) => error === "handoff.profile.timezone is required"))
  assert.ok(sparseErrors.some((error) => error.includes("handoff.accounts must contain at least 1 items")))
  assert.ok(sparseErrors.some((error) => {
    return error.includes("handoff.onboarding_checklist must contain at least 6 items")
  }))

  const noPosition = structuredClone(handoff)
  noPosition.accounts.push({
    account_id: "empty-account",
    label: "빈 계좌",
    cash_like: true,
    liquidity: "immediate",
  })
  assert.ok(validateHandoff(noPosition).some((error) => {
    return error === "account empty-account requires at least one opening position"
  }))

  const invalidCard = structuredClone(handoff)
  invalidCard.liabilities[0].payment_account_id = "unknown"
  assert.ok(validateHandoff(invalidCard).some((error) => {
    return error === "liability sample-card references unknown payment account"
  }))

  for (const field of ["accrued_interest", "fees_due", "overdue"]) {
    const incompleteLiability = structuredClone(handoff)
    delete incompleteLiability.liabilities[0][field]
    assert.ok(validateHandoff(incompleteLiability).some((error) => {
      return error === `handoff.liabilities[0].${field} is required`
    }))
  }

  for (const liabilityType of ["installment", "revolving", "cash_advance", "card_loan"]) {
    const explicitLiability = structuredClone(handoff)
    Object.assign(explicitLiability.liabilities[0], {
      type: liabilityType,
      annual_rate: null,
      total_installments: liabilityType === "installment" ? 12 : null,
      remaining_installments: liabilityType === "installment" ? 6 : null,
      minimum_payment: null,
    })
    assert.deepEqual(validateHandoff(explicitLiability), [])

    for (const field of [
      "annual_rate",
      "total_installments",
      "remaining_installments",
      "minimum_payment",
    ]) {
      const missingLiabilityDetail = structuredClone(explicitLiability)
      delete missingLiabilityDetail.liabilities[0][field]
      assert.ok(validateHandoff(missingLiabilityDetail).some((error) => {
        return error === `handoff.liabilities[0].${field} is required`
      }))
    }
  }

  const legacyDueDate = structuredClone(handoff)
  legacyDueDate.liabilities[0].next_due_at = "2099-01-21T09:00:00+09:00"
  assert.ok(validateHandoff(legacyDueDate).some((error) => {
    return error === "handoff.liabilities[0].next_due_at is not allowed"
  }))

  const invalidCapacity = structuredClone(handoff)
  invalidCapacity.cashflow_horizon.payment_capacity.required_before_next_income.amount = 1
  assert.ok(validateHandoff(invalidCapacity).some((error) => {
    return error === "payment_capacity.required_before_next_income does not match essential obligations"
  }))

  const mismatchedCard = structuredClone(handoff)
  mismatchedCard.cashflow_horizon.essential_obligations[0].due_at = "2099-01-21T09:00:00+09:00"
  assert.ok(validateHandoff(mismatchedCard).some((error) => {
    return error === "liability sample-card next payment must be included in essential obligations"
  }))

  const equivalentCardDueAt = structuredClone(handoff)
  equivalentCardDueAt.cashflow_horizon.essential_obligations[0].due_at = "2099-01-20T00:00:00Z"
  assert.deepEqual(validateHandoff(equivalentCardDueAt), [])

  const invalidArrayItem = structuredClone(handoff)
  invalidArrayItem.accounts = [null]
  const invalidArrayErrors = validateHandoff(invalidArrayItem)
  assert.ok(invalidArrayErrors.some((error) => error === "handoff.accounts[0] must be object"))
})

test("validate-handoff CLI는 빈 핵심 구조와 스키마 위반을 실패로 종료한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asset-handoff-"))
  const filePath = join(directory, "invalid.json")
  try {
    await writeFile(filePath, JSON.stringify({
      schema_version: "1.0.0",
      created_at: "not-a-date",
      profile: { lifecycle_stage: "early_career" },
      snapshot: { as_of: "not-a-date" },
      accounts: [],
      opening_positions: [],
      liabilities: [],
      recurring_flows: [],
      cashflow_horizon: {},
      goals: [],
      budget_policy: {},
      operations: {},
      risk_rules: {},
      onboarding_checklist: [],
      follow_ups: [],
      storage: { adapter: "invalid" },
      unexpected: true,
    }))
    const result = spawnSync(process.execPath, [
      join(sharedDirectory, "validate-handoff.mjs"),
      filePath,
    ], { encoding: "utf8" })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /handoff\.profile\.currency is required/)
    assert.match(result.stderr, /handoff\.unexpected is not allowed/)
    assert.match(result.stderr, /handoff\.created_at must be an ISO date-time/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("스키마 파일과 두 Agent Skills frontmatter가 유효한 기본 구조를 가진다", async () => {
  for (const schemaName of ["event.schema.json", "handoff.schema.json"]) {
    const schema = JSON.parse(await readFile(`${sharedDirectory}/${schemaName}`, "utf8"))
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema")
  }

  const skillDocuments = [
    {
      name: "personal-finance-onboarding",
      path: "../../personal-finance-onboarding/SKILL.md",
      references: [
        "../personal-finance-core/SPEC.md",
        "../personal-finance-core/handoff.schema.json",
        "node ../personal-finance-core/validate-handoff.mjs <handoff.json>",
      ],
    },
    {
      name: "personal-finance-management",
      path: "../../personal-finance-management/SKILL.md",
      references: [
        "../personal-finance-core/SPEC.md",
        "../personal-finance-core/event.schema.json",
        "../personal-finance-core/handoff.schema.json",
        "../personal-finance-core/validate-handoff.mjs",
        "../personal-finance-core/handoff.mjs",
        "../personal-finance-core/ledger.mjs",
        "../personal-finance-core/outline-adapter.mjs",
      ],
    },
  ]
  for (const { name, path, references } of skillDocuments) {
    const content = await readFile(new URL(path, import.meta.url), "utf8")
    assert.match(content, /^---\n/)
    assert.match(content, new RegExp(`\\nname: ${name}\\n`))
    assert.match(content, /\ndescription: .+\n---\n/)
    for (const reference of references) assert.ok(content.includes(reference), `${name} must reference ${reference}`)
  }
})
