# Kinoshita

Claude, Codex, OpenCode, Hermes에서 함께 사용할 수 있는 Agent Skills와 MCP 서버 카탈로그입니다. 스킬은
[Agent Skills](https://agentskills.io) 형식으로 관리하며, 에이전트별 설치 방식만 분리합니다.

## 지원 환경

| 환경 | 스킬 배포 | MCP 배포 |
| --- | --- | --- |
| Claude Code | 네이티브 플러그인 마켓플레이스, 공통 CLI | 플러그인 또는 설정 생성 |
| Codex | `.agents/skills`, 공통 CLI | `config.toml` 설정 생성 |
| OpenCode | `.opencode/skills`, 공통 CLI | `opencode.json` 설정 생성 |
| Hermes | `.hermes/skills`, 공통 CLI | `config.yaml` 설정 생성 |

`registry.json`이 에이전트 공통 카탈로그입니다. `registry.schema.json`은 스킬 팩과 MCP 서버 항목의
형식을 정의합니다. Claude Code는 `.claude-plugin/marketplace.json`을 네이티브 마켓플레이스
매니페스트로 사용합니다.

## 제공 패키지

### `personal-finance`

- `personal-finance-onboarding`: 사회 초년생의 초기 자산과 부채를 정리하고 인계 데이터를 생성합니다.
- `personal-finance-management`: 인계 데이터와 원본 이벤트를 바탕으로 자산관리를 이어갑니다.
- `personal-finance-core`: 두 스킬이 함께 쓰는 인계 스키마, 원장, Outline 어댑터와 공통 명세입니다.

공유 디렉터리는 직접 호출하는 스킬이 아니지만, 런타임 스킬의 상대 경로 참조를 위해 항상 함께
설치됩니다.

## 설치

Claude Code의 네이티브 마켓플레이스 설치, Codex, OpenCode, Hermes의 공통 CLI 설치와 MCP 설정 방법은
[INSTALL.md](INSTALL.md)를 참고합니다.

## 개발과 검증

카탈로그와 전체 테스트를 한 번에 검증합니다.

```bash
npm run check
```

개별 명령은 다음과 같습니다.

```bash
npm run validate
npm test
```

새 스킬 팩이나 MCP 서버를 등록하는 방법은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참고합니다.

## 라이선스

[Apache License 2.0](LICENSE)을 적용합니다.
