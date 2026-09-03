# 설치 가이드

Claude Code는 네이티브 플러그인 마켓플레이스와 공통 CLI를 지원합니다. Codex, OpenCode, Hermes는
공통 CLI로 Agent Skills 검색 디렉터리에 설치합니다.

## 설치 준비

공통 CLI에는 Node.js 20 이상이 필요합니다. 저장소를 clone한 뒤 카탈로그를 확인합니다.

```bash
git clone https://github.com/hwangseonu/kinoshita-skills.git
node /path/to/kinoshita-skills/bin/kinoshita.mjs list
```

## Claude Code

Claude Code에서는 네이티브 마켓플레이스 설치를 권장합니다.

```text
/plugin marketplace add hwangseonu/kinoshita-skills
/plugin install personal-finance@kinoshita
```

설치한 스킬은 `personal-finance:personal-finance-onboarding`과
`personal-finance:personal-finance-management` 이름으로 제공됩니다. Claude 네이티브 플러그인과
공통 CLI는 모두 `personal-finance` 패키지에 속한 스킬과 공유 리소스를 함께 설치합니다.

일반 Agent Skills로 프로젝트에 설치하려면 다음 명령을 사용합니다.

```bash
node /path/to/kinoshita-skills/bin/kinoshita.mjs \
  install personal-finance --agent claude --scope project --project /path/to/project
```

## Codex

프로젝트 범위에서는 대상 저장소의 `.agents/skills`에 설치합니다.

```bash
node /path/to/kinoshita-skills/bin/kinoshita.mjs \
  install personal-finance --agent codex --scope project --project /path/to/project
```

모든 프로젝트에서 사용할 개인 스킬로 설치할 수도 있습니다.

```bash
node /path/to/kinoshita-skills/bin/kinoshita.mjs \
  install personal-finance --agent codex --scope user
```

## OpenCode

프로젝트 범위에서는 대상 저장소의 `.opencode/skills`에 설치합니다.

```bash
node /path/to/kinoshita-skills/bin/kinoshita.mjs \
  install personal-finance --agent opencode --scope project --project /path/to/project
```

`--scope user`를 사용하면 `~/.config/opencode/skills`에 설치합니다.

## Hermes

모든 프로젝트에서 사용하려면 `~/.hermes/skills`에 설치합니다.

```bash
node /path/to/kinoshita-skills/bin/kinoshita.mjs \
  install personal-finance --agent hermes --scope user
```

설치 후 Hermes를 다시 시작하면 `/personal-finance-onboarding`과
`/personal-finance-management` 명령을 사용할 수 있습니다.

특정 Git 저장소에서만 사용하려면 저장소의 `.hermes/skills`에 설치한 뒤 해당 저장소를 Hermes에서
신뢰하도록 등록합니다.

```bash
node /path/to/kinoshita-skills/bin/kinoshita.mjs \
  install personal-finance --agent hermes --scope project --project /path/to/project
hermes skills trust /path/to/project
```

두 스킬은 sibling 디렉터리인 `personal-finance-core`를 참조합니다. Hermes Skills Hub에서 스킬 하나만
직접 설치하면 공유 리소스가 빠질 수 있으므로 공통 CLI 설치를 권장합니다.

## 기존 설치 보호

설치기는 기존 스킬과 리소스를 덮어쓰지 않습니다. 이미 설치된 경로가 있으면 내용을 확인하고 해당
디렉터리를 정리한 뒤 다시 실행합니다.

## MCP 설정

등록된 MCP 서버 목록은 `list` 명령으로 확인합니다. 현재 카탈로그에는 MCP 서버가 없으며, 새 서버를
등록하면 다음 명령으로 에이전트별 설정을 생성할 수 있습니다.

```bash
node /path/to/kinoshita-skills/bin/kinoshita.mjs \
  mcp-config <server-name> --agent claude
node /path/to/kinoshita-skills/bin/kinoshita.mjs \
  mcp-config <server-name> --agent codex
node /path/to/kinoshita-skills/bin/kinoshita.mjs \
  mcp-config <server-name> --agent opencode
node /path/to/kinoshita-skills/bin/kinoshita.mjs \
  mcp-config <server-name> --agent hermes
```

출력은 각각 Claude의 `.mcp.json`, Codex의 `config.toml`, OpenCode의 `opencode.json`, Hermes의
`~/.hermes/config.yaml`에 넣을 수 있는 설정 조각입니다. 인증값은 카탈로그에 저장하지 않고 환경
변수 이름만 등록합니다.
