---
name: personal-finance-management
description: Use when a user with a personal-finance handoff reports 수입·지출·카드·이체·예약·정정, requests 결산, or runs ongoing personal finance management directly or through an automated agent.
---

# 개인용 지속 자산관리

버전된 온보딩 인계 데이터를 받아 사용자 확정 입력을 원본 이벤트로 보존하고 현재 자산, 부채, 예산,
의무와 결산 상태를 관리합니다.

## 시작 전

이 `SKILL.md`를 기준으로 다음 공통 파일을 먼저 읽습니다.

- `../personal-finance-core/SPEC.md`
- `../personal-finance-core/event.schema.json`
- `../personal-finance-core/handoff.schema.json`

인계 데이터를 sibling 경로인 `../personal-finance-core/validate-handoff.mjs`로 검증합니다. 인계
데이터가 없거나 차단 필수 정보가 불완전하면 `personal-finance-onboarding`을 먼저 사용합니다.

검증된 인계 데이터는 `../personal-finance-core/handoff.mjs`의 `handoffToOpening(handoff)`으로 한 번
변환한 뒤 반환된 숫자형 opening만 `../personal-finance-core/ledger.mjs`의
`projectLedger(opening, events)`에 전달합니다. measured money를 포함한 handoff를 `projectLedger`에
직접 전달하거나 별도의 암묵적 변환을 만들지 않습니다.

검증된 `cashflow_horizon`의 다음 수입, 필수 의무, 카드 결제 계좌와 다음 결제일을 시작 상태로
사용합니다. 이 정보를 다시 조사해 보완하는 것을 정상 시작 절차로 간주하지 않습니다.

## 권한 경계

- 송금, 납부, 상품 가입, 투자 주문, 계좌·카드 해지를 실행하지 않습니다.
- 전체 계좌번호, 전체 카드번호, 비밀번호, CVC, OTP, 로그인 정보를 묻거나 저장하지 않습니다.
- API 인증정보를 원장이나 인계 데이터에 넣지 않습니다.
- 확인되지 않은 자동 추출 결과를 합계에 반영하지 않습니다.
- 사용자가 실제로 실행했다고 확인한 금융 행위만 확정 이벤트로 기록합니다.

## 저장소 계약

저장소 어댑터는 다음 연산을 제공해야 합니다.

- 버전된 인계 데이터 읽기
- 원본 이벤트 순서대로 읽기
- 새 이벤트 append
- `period_id`별 알림 기록 읽기와 append
- 파생 상태 snapshot 쓰기

원본 이벤트를 덮어쓰지 않습니다. 파생 상태는 언제든 인계 데이터와 이벤트를 재생해 만들 수 있어야
합니다. 저장소 어댑터가 정해지지 않았으면 첫 영속 변경 전에 저장소를 선택받고, 그전에는 이벤트
초안만 보여줍니다.

### Outline 사용

Outline을 저장소로 선택했으면 `../personal-finance-core/outline-adapter.mjs`의
`OutlineAssetAdapter`를 사용합니다. 다음 환경 변수가 모두 있어야 합니다.

```text
OUTLINE_URL=<Outline 서버 URL>
OUTLINE_API_TOKEN=<API token>
OUTLINE_COLLECTION_ID=<collection UUID>
```

API token은 출력하거나 문서 데이터에 복사하지 않습니다. `OUTLINE_URL`에는 원격 환경에서 HTTPS를
사용합니다. HTTP URL은 기본적으로 거부합니다. 운영자가 통제하는 개발망에서만 constructor의
`allowInsecureHttp: true`를 명시할 수 있습니다. 각 연산은 전용 문서 계층과 versioned index를 스스로
확인합니다. 연결과 권한을 미리 확인해야 할 때만 `bootstrap()`을 직접 호출합니다. `bootstrap()`은
필요한 문서를 만들고 현재 배치의 위치와 내용을 검증합니다.

| 목적 | 연산 |
| --- | --- |
| 인계 데이터 읽기와 쓰기 | `readHandoff()`, `writeHandoff(handoff)` |
| 이벤트 읽기와 append | `readEvents()`, `appendEvent(event)` |
| 알림 기록 읽기와 append | `readNotifications()`, `appendNotification(notification)` |
| 파생 상태 읽기와 쓰기 | `readSnapshot()`, `writeSnapshot(snapshot)` |

Outline의 읽기용 `자산관리 시스템` 아래에는 `개인 자산 목록`, `고정 수입·지출`, `월별 수입·지출`
Markdown을 둡니다. 월별 문서는 연도와 월 순서로 중첩합니다. 별도의
`원본 JSON (기계 전용)` 아래에는 handoff, event, notification, index와 snapshot machine envelope를
둡니다.

읽기용 문서를 원본으로 해석하지 않습니다. 모든 읽기용 수치는 저장된 handoff를
`handoffToOpening()`으로 변환하고 event index 순서대로 `projectLedger()`를 실행한 결과입니다. 저장된
snapshot은 읽기용 문서의 입력으로 사용하지 않으며 replay로 다시 만들거나 확인할 수 있는 파생 기록으로
취급합니다. 사람용 문서에는 사용자가 정한 계좌·부채 별칭을 표시할 수 있지만 household note, event ID와
의미가 정의되지 않은 payload 필드는 복사하지 않습니다.

월별 문서에서는 발생 수입·지출과 실제 현금흐름을 분리합니다. 카드 구매는 구매월 지출에 반영하고 할부
구매는 상환할 원금만 늘립니다. 카드 결제와 부채 원금 상환은 추가 지출 없이 현금 유출로만 반영합니다.
할부의 다음 분할금은 고정 지출 문서에 표시하지만 남은 원금과 납부 원금은 월 소비 합계에 포함하지 않습니다.
합계에는 최종 active 확정 이벤트만 포함하고, 확인 전 거래는 별도로 표시합니다.

사람용 문서에는 관리 원칙, 계산 방법, schema와 replay 설명을 쓰지 않습니다. 사용자가 확인할 금액,
일정, 상태와 거래 결과만 표시합니다.

현재 handoff schema에 없는 실제 잔액 관측, 미사용 자산 상태, 분류별 예산, 반복 항목과 실제 거래의
연결, 원칙 변경 이력, 월 마감 감사 이력은 추정하지 않습니다. 인계 시 관측값을 현재 실제 잔액으로
표현하거나 자유 형식 반복 일정을 임의로 계산하지 않습니다.

`appendEvent()`가 `needs_duplicate_confirmation`을 반환하면 사용자 확인 없이 재등록하지 않습니다.
`duplicate`은 기존 원본을 유지한 멱등 결과입니다. `appendNotification()`의 `already_notified`도 최초
알림 기록을 유지합니다. conflict가 발생하면 기존 문서를 덮어쓰지 말고 저장된 내용과 입력을 확인합니다.
index mismatch, missing, moved, deleted, unindexed orphan 오류도 자동 복구하지 않습니다. append 도중
불변 문서 생성 후 index 갱신 전에 실패한 동일 입력만 `appendEvent()`나 `appendNotification()`으로
다시 호출해 복구합니다.

같은 JavaScript isolate에서 같은 module instance를 공유하는 adapter만 queue를 공유합니다. 다른
process나 worker isolate는 직렬화되지 않으므로 collection마다 writer process를 하나만 사용합니다.
이벤트를 append하기 전에는 기존 이벤트와 새 이벤트를 함께 `projectLedger`로 임시 재생하고, append가
끝난 뒤 index 순서로 다시 읽어 snapshot을 저장합니다. 이 여러 단계는 하나의 원자적 transaction이
아니므로 중간 실패 시 성공한 public 메서드의 결과부터 다시 읽고 다음 단계를 재시도합니다.
handoff와 event는 전체 replay가 성공한 뒤 원본을 먼저 저장하고 읽기용 Markdown을 갱신합니다.
Markdown 갱신이 실패했다면 온보딩을 다시 실행하거나 handoff와 opening position을 기본값으로 만들지
않습니다. 저장된 원본과 index를 다시 읽고 같은 연산을 재시도합니다. snapshot 읽기와 쓰기는 읽기용
현재 상태를 갱신하지 않습니다.

HTTP 429 오류는 자동 재시도하지 않습니다. 오류의 `retryAfter` 또는 메시지의 `Retry-After`를 확인하고
해당 시간이 지난 뒤 실패한 public 메서드 전체를 다시 호출합니다.

## 호출 시작

### 직접 호출

마지막 결산 기간과 현재 기준일시를 확인합니다. 밀린 결산이 있으면 최신 상태 판단보다 먼저 누락된
기간의 입력을 받습니다.

### 자동화 호출

현재 `period_id`의 알림 기록을 확인합니다. 이미 기록이 있으면 다시 알리지 않습니다. 새 기간이면
능동 알림을 한 번 기록한 뒤 필요한 입력을 요청합니다. 과거 미결산 기간은 상태 요약으로만 표시하고
같은 기간의 알림을 다시 만들지 않습니다.

## 일상어 입력 처리

사용자가 "점심 10,000원 예시 카드로 결제했어"처럼 보고하면 내부 이벤트 이름을 묻지 않고 다음 순서로
처리합니다.

1. 사용자가 명시한 사실을 추출합니다.
2. 금액, 발생일, 결제수단처럼 계산을 바꾸는 정보가 빠졌는지 확인합니다.
3. 충분한 직접 입력은 `verification_status=confirmed`로 바로 등록합니다.
4. OCR, 알림, API 입력은 `pending`으로 등록하고 추출 결과와 중복 후보를 보여줍니다.
5. pending 입력을 확인하면 같은 source identity의 새 `confirmed` 이벤트가 pending 원본을
   `supersedes_event_id`로 대체하게 append합니다. 원본은 수정하지 않습니다.
6. 고유 원본 ID 중복은 멱등 처리하고 fingerprint 중복은 사용자에게 같은 거래인지 묻습니다.
7. 새 이벤트를 기존 이벤트 목록에 임시로 더해 `projectLedger`를 실행하고 관계, 잔액, 참조 무결성을
   확인합니다.
8. 임시 replay가 성공한 이벤트만 append하고 계산된 파생 상태를 저장합니다.
9. 변경된 합계와 기준일시만 간결하게 알려줍니다.

실제 자산·부채 사건은 `recognized`, 환불·취소는 `reversal`, 계획·예약·확정 약정은 `planned`,
조건부 약정은 `conditional`, 포인트 적립·사용·소멸은 `not_applicable`로 기록합니다. 카드·할부 구매,
대출 실행과 금융 비용은 `unsettled`, 카드·부채 상환은 `partially_settled` 또는 `settled`로 기록하고,
그 밖의 사건에는 결제·상환 상태를 적용하지 않습니다.

한 입력에서 계좌 이체와 목적성 배정이 함께 발생하면 두 원자 이벤트를 만들고 같은
`event_group_id`로 연결합니다.

## 사건별 처리

| 사용자 표현 | 원장 처리 |
| --- | --- |
| 현금·계좌로 구매 | 현금 position 감소와 지출 인식 |
| 카드로 구매 | 지출과 카드 원금 동시 증가 |
| 카드값 납부·즉시결제 | 현금과 카드 원금 감소, 추가 지출 없음 |
| 내 계좌끼리 이체 | 정책과 배정 identity가 같은 서로 다른 계좌 leg를 함께 변경, 지출 없음 |
| 비상금·목적 자금으로 빼두기 | 별도 목적성 자금 배정 이벤트 |
| 이체 수수료 | 이체와 별도의 지출 이벤트 |
| 할부 구매 | 상환할 할부 원금 증가, 소비 지출 없음 |
| 리볼빙으로 이동 | 부채 사이 원금 이동, 지출과 총부채 추가 없음 |
| 현금서비스·카드론 실행 | 현금과 부채 원금 동시 증가, 수입 아님 |
| 이자·수수료 부과 | 지출과 미지급 이자·수수료 동시 증가 |
| 할부 분할금·부채 상환 | 현금과 원금·이자·수수료 감소, 추가 지출 없음 |
| 승인 취소 | 원승인 이벤트 취소 |
| 환불 | 원거래 반대 효과, 별도 수입 아님 |
| 포인트 적립·소멸 | 참고 잔액만 변경 |
| 포인트 사용 | 참고 잔액 감소, 실제 결제액만 지출 |
| 포인트 현금화·계좌 캐시백 | 현금과 기타수입 증가 |

## 계획과 예약

- 단순 계획은 일정만 기록합니다.
- 취소 가능한 예약은 일정과 취소 가능 여부만 기록합니다.
- 취소 수수료가 있으면 발생 조건과 최대 노출액을 조건부 의무로 기록합니다.
- 금액과 지급 책임이 확정된 약정은 확정 의무로 기록합니다.
- 실제 결제 전에는 계획과 예약을 지출이나 카드 부채로 만들지 않습니다.
- 다른 달에 결제한 일정은 결제월 지출과 사용월 일정을 분리합니다.

## 정정과 취소

정정할 원본 이벤트를 식별하고 변경 전후의 영향을 보여줍니다. 새 이벤트에
`supersedes_event_id`를 넣고 원본은 보존합니다. 승인 취소나 예약 취소는 `cancels_event_id`로 원본을
비활성화합니다. 일부 환불은 원거래를 유지하고 환불 이벤트로 반대 효과를 기록합니다.

관계 이벤트의 active 여부를 먼저 계산하고 active 취소·대체 관계만 적용합니다. 취소 이벤트가 다시
취소되면 원거래를 복원하며, 취소·대체 관계 cycle은 저장하지 않습니다.

정정 후에는 자산, 부채, 지출, 수입, 정책상 사용 가능액, 관련 기간 합계를 모두 다시 계산합니다.

## 결산

선택한 주기에 해당하는 `period_id`를 만들고 다음 내용을 확인합니다.

- 기간 중 수입, 지출, 이체, 배정, 카드 구매와 납부
- 기간 말 계좌 잔액과 카드·부채 잔액
- 계획, 조건부 의무와 확정 의무
- 값 성격이 확정이 아닌 항목의 `next_review_at`
- 중복 후보와 검증 대기 이벤트
- 다음 수입 전 필수지출 지급 가능성

결산이 끝나면 handoff의 마지막 완료 `period_id`와 별도 파생 snapshot의 기준일시를 갱신합니다. handoff의
온보딩 기준시점인 `snapshot.as_of`와 `profile.timezone`은 변경하지 않습니다. 월별 문서에서 마감 상태를
자동 판별하려면 `period_id`를 `YYYY-MM` 형식으로 기록합니다. 현재 schema에는 마감 시각과 당시 합계를
보존하는 필드가 없으므로 마감 후 정정을 별도 감사 이력으로 표현하지 않습니다. 결산 전 상태를 실시간
현황이라고 표현하지 않습니다.

## 제한 지원

정책상 사용 가능액이 다음 수입 전 필수지출보다 적거나 연체가 발생·임박했거나 설정한 횟수 이상
연속 적자가 발생하면 제한 지원 상태로 표시합니다. 일반 예산 조정으로 해결할 수 없는 지급 불능도
같이 표시합니다.

채무조정, 회생·파산, 세무 신고, 개인사업 회계, 법률 판단이 필요하면 일반 흐름을 중단하고 전문
지원을 안내합니다. 스킬이 임의로 금융 행위를 실행하거나 전문 판단을 대신하지 않습니다.

## 응답 형식

일반 입력에는 다음 네 항목만 보여줍니다.

- 반영한 사실
- 달라진 자산·부채·지출·사용 가능액
- 추가 확인이 필요한 최소 정보
- 현재 상태의 기준일시와 결산 상태

원장 내부 필드와 회계 축은 사용자가 요청할 때만 상세히 보여줍니다.
