# 마켓플레이스 기여 가이드

이 저장소는 Agent Skills 원본과 에이전트 공통 카탈로그를 함께 관리합니다. 스킬이나 MCP 서버를
추가할 때는 `registry.json`을 갱신하고 `npm run check`로 파일과 카탈로그의 일치 여부를 확인합니다.

## 스킬 팩 추가

1. `plugins/<package-name>/skills/<skill-name>/SKILL.md`를 만듭니다.
2. `SKILL.md`의 `name`과 `description`을 한 줄 YAML 값으로 작성합니다.
3. 같은 기능을 구성하는 스킬과 공유 리소스를 `registry.json`의 패키지 하나에 등록합니다.
4. Claude 플러그인 버전과 `registry.json`의 패키지 버전을 올립니다.
5. `npm run check`를 실행합니다.

스킬 이름은 디렉터리 이름과 같아야 하며 소문자, 숫자, 단일 하이픈만 사용할 수 있습니다. 스킬이
공유 파일을 상대 경로로 읽는다면 해당 디렉터리를 패키지의 `resources`에 포함합니다. 설치기는 모든
스킬과 리소스를 같은 검색 디렉터리 아래에 배치합니다.

패키지 항목은 다음 형식을 사용합니다.

```json
{
  "name": "example-pack",
  "display_name": "예제 스킬 팩",
  "description": "예제 작업을 처리하는 스킬 모음",
  "version": "1.0.0",
  "license": "Apache-2.0",
  "agents": ["claude", "codex", "opencode", "hermes"],
  "skills": [
    {
      "name": "example-skill",
      "path": "plugins/example-pack/skills/example-skill",
      "description": "SKILL.md frontmatter와 같은 설명"
    }
  ],
  "resources": []
}
```

## MCP 서버 추가

`registry.json`의 `mcp_servers`에 서버를 추가합니다. 비밀값이나 실제 인증 토큰은 넣지 않고 필요한
환경 변수 이름만 선언합니다.

STDIO 서버는 실행 명령을 배열로 기록합니다.

```json
{
  "name": "example-mcp",
  "description": "예제 도구를 제공하는 MCP 서버",
  "version": "1.0.0",
  "agents": ["claude", "codex", "opencode", "hermes"],
  "transport": {
    "type": "stdio",
    "command": ["npx", "-y", "@example/mcp"],
    "environment": ["EXAMPLE_TOKEN"]
  }
}
```

Streamable HTTP 서버는 URL과 인증에 사용할 환경 변수 이름을 기록합니다.

```json
{
  "name": "example-remote-mcp",
  "description": "원격 예제 도구를 제공하는 MCP 서버",
  "version": "1.0.0",
  "agents": ["claude", "codex", "opencode", "hermes"],
  "transport": {
    "type": "http",
    "url": "https://mcp.example.com/mcp",
    "bearer_token_env": "EXAMPLE_TOKEN",
    "headers": {
      "X-Tenant": "EXAMPLE_TENANT"
    }
  }
}
```

Claude 플러그인 설치에 MCP 서버를 함께 포함하려면 `plugins/<package-name>/.mcp.json`에도 같은
서버를 등록합니다. `mcp-config` 명령으로 생성한 Claude 설정을 기준으로 사용할 수 있습니다.

## 버전 관리

스킬 팩의 동작이 바뀌면 다음 버전을 함께 갱신합니다.

- `registry.json`의 패키지 `version`
- `plugins/<package-name>/.claude-plugin/plugin.json`의 `version`
- `.claude-plugin/marketplace.json`의 플러그인 `version`

MCP 서버만 바뀌면 해당 `mcp_servers` 항목의 `version`을 갱신합니다.

## 검증

```bash
npm run check
```

`validate` 명령은 카탈로그 구조, 중복 이름, 경로 이탈, 디렉터리 존재 여부, `SKILL.md` frontmatter와
설명의 일치 여부를 확인합니다. 테스트는 에이전트별 설치 경로, 기존 파일 보호와 MCP 설정 변환을
검증합니다.

테스트 fixture에는 실제 사용자의 재무 자료를 사용하지 않습니다. 날짜는 현실과 분리된 고정값을,
금액은 반올림된 예시값을 사용하고 금융사와 생활 일정은 일반적인 테스트 명칭으로 작성합니다.
