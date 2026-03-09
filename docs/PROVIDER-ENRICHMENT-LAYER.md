# Provider Enrichment Layer — 경량 래핑 레이어 설계

> MARS 터미널 서브시스템에서 Agent 설정(시스템 프롬프트, MCP 서버, 도구 권한)을
> Claude CLI 실행에 자동 주입하기 위한 미들웨어 레이어 설계안

## 배경

### 현재 문제점

MARS는 Claude CLI 바이너리를 `Bun.spawn()`으로 직접 실행한다. 이 방식의 한계:

| 문제 | 현재 상태 | 원인 |
|------|-----------|------|
| 시스템 프롬프트 미주입 | Agent의 `systemPrompt` 필드가 일반 메시지에서 무시됨 | `handleLLMMessage()`에서 스킬 호출 시에만 `systemContext` 전달 |
| MCP 서버 미연결 | Agent의 `mcpServerIds`가 CLI에 전달 안 됨 | `ProviderRequest.mcpConfigPath`를 아무도 채우지 않음 |
| 도구 제어 불가 | Agent별 도구 허용/차단이 없음 | `allowedTools`/`disallowedTools` 미사용 |
| 모델 미적용 | Agent의 `modelId`가 CLI에 전달 안 됨 | `ProviderRequest.model`을 아무도 채우지 않음 |
| 예산 미제한 | Agent별/세션별 비용 제한 없음 | `maxBudgetUsd` 미사용 |

### OpenCode가 다르게 하는 것

OpenCode는 CLI를 스폰하지 않고 **Vercel AI SDK로 Anthropic REST API를 직접 호출**한다.
이를 통해 시스템 프롬프트, 도구 목록, MCP 서버, 메시지 히스토리를 완전히 제어한다.

MARS에서 같은 수준의 제어를 얻으려면 궁극적으로 Direct API 프로바이더가 필요하지만,
**CLI 방식을 유지하면서도 Agent 설정 주입은 즉시 해결 가능**하다.

## 전략: Hybrid (옵션 C)

**Phase 1** (이 설계): CLI 기반 ProviderEnricher 미들웨어 → 즉각적 가치
**Phase 2** (향후): Anthropic API 기반 직접 프로바이더 → 완전한 제어

---

## 아키텍처 개요

```
SessionExecutor.handleLLMMessage()
        │
        ▼
ProviderRegistry.getForAgent(agentId)
        │
        ├── Agent DB에서 설정 조회
        │     ├── systemPrompt
        │     ├── mcpServerIds → McpServer DB 조회
        │     ├── modelId
        │     └── reasoningLevel
        │
        ▼
new ProviderEnricher(baseProvider, enrichmentContext)
        │
        ▼
ProviderEnricher.sendMessage(request)
        │
        ├── 1. mergeSystemPrompt()     → request.systemContext 강화
        ├── 2. resolveMcpConfig()      → 임시 mcp-config.json 생성 → request.mcpConfigPath
        ├── 3. applyModel()            → request.model 설정
        ├── 4. applyBudget()           → request.maxBudgetUsd 설정
        ├── 5. applyPermissionMode()   → request.permissionMode 설정
        │
        ▼
baseProvider.sendMessage(enrichedRequest)   ← ClaudeCliProvider
        │
        ▼
Bun.spawn([claude, ...enrichedArgs])
```

---

## 핵심 컴포넌트

### 1. EnrichmentContext — 주입 데이터 컨테이너

Agent DB와 관련 MCP 서버 정보를 한 번에 조회하여 전달하는 데이터 객체.

```typescript
// src/terminal/provider/enrichment.ts

export interface EnrichmentContext {
  agent: {
    id: string;
    systemPrompt: string;
    modelId: string;
    reasoningLevel: ReasoningLevel;
    mcpServerIds: string[];
  };
  mcpServers: McpServer[];       // agent.mcpServerIds로 조회한 실제 서버 목록
  providerConfig: ProviderConfig; // Provider의 config (defaults)
}
```

### 2. ProviderEnricher — LLMProvider 데코레이터

`LLMProvider` 인터페이스를 구현하면서, 내부적으로 base provider를 감싸는 데코레이터.

```typescript
// src/terminal/provider/enricher.ts

export class ProviderEnricher implements LLMProvider {
  readonly id: string;
  readonly name: string;

  constructor(
    private base: LLMProvider,
    private context: EnrichmentContext,
  ) {
    this.id = base.id;
    this.name = base.name;
  }

  async *sendMessage(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const enriched = this.enrich(request);
    yield* this.base.sendMessage(enriched);
  }

  abort(sessionId: string): void {
    this.base.abort(sessionId);
  }

  isAvailable(): Promise<boolean> {
    return this.base.isAvailable();
  }

  private enrich(request: ProviderRequest): ProviderRequest {
    return {
      ...request,
      systemContext: this.mergeSystemPrompt(request.systemContext),
      model: request.model ?? this.context.agent.modelId,
      mcpConfigPath: request.mcpConfigPath ?? this.resolveMcpConfigPath(),
      maxBudgetUsd: request.maxBudgetUsd ?? this.context.providerConfig.maxBudgetUsd,
      permissionMode: request.permissionMode ?? this.context.providerConfig.permissionMode,
    };
  }

  private mergeSystemPrompt(existing?: string): string | undefined {
    const agentPrompt = this.context.agent.systemPrompt;

    // 둘 다 없으면 undefined
    if (!agentPrompt && !existing) return undefined;

    // 스킬 컨텍스트가 있으면 Agent 프롬프트 + 스킬 컨텍스트 합성
    if (agentPrompt && existing) {
      return agentPrompt + '\n\n---\n\n' + existing;
    }

    return agentPrompt || existing;
  }

  private resolveMcpConfigPath(): string | undefined {
    if (this.context.mcpServers.length === 0) return undefined;
    return McpConfigWriter.write(this.context.mcpServers);
  }
}
```

### 3. McpConfigWriter — 임시 MCP 설정 파일 생성

Claude CLI는 `--mcp-config <path>` 플래그로 MCP 서버 설정을 받는다.
MARS DB의 `mcp_servers` 레코드를 CLI 호환 JSON 파일로 변환.

```typescript
// src/terminal/provider/mcp-config-writer.ts

import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpServer } from '../../types/mcp-server';

// Claude CLI가 기대하는 MCP config 포맷
interface CliMcpConfig {
  mcpServers: Record<string, CliMcpServerEntry>;
}

interface CliMcpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
  // SSE/streamable-http 서버용
  url?: string;
  headers?: Record<string, string>;
}

export namespace McpConfigWriter {
  const configDir = mkdtempSync(join(tmpdir(), 'mars-mcp-'));

  export function write(servers: McpServer[]): string {
    const config: CliMcpConfig = { mcpServers: {} };

    for (const server of servers) {
      if (!server.enabled) continue;

      if (server.transportType === 'stdio' && server.command) {
        config.mcpServers[server.name] = {
          command: server.command,
          args: server.args,
          env: Object.keys(server.env).length > 0 ? server.env : undefined,
        };
      } else if (server.url) {
        config.mcpServers[server.name] = {
          command: '',
          args: [],
          url: server.url,
          headers: Object.keys(server.headers).length > 0 ? server.headers : undefined,
        };
      }
    }

    const filePath = join(configDir, `mcp-${Date.now()}.json`);
    writeFileSync(filePath, JSON.stringify(config, null, 2));
    return filePath;
  }
}
```

### 4. ProviderRegistry 변경 — EnrichmentContext 조립

현재 `ProviderRegistry.getForAgent()`는 base provider만 반환한다.
이를 확장하여 EnrichmentContext를 조립하고 ProviderEnricher로 감싸 반환.

```typescript
// src/terminal/provider/registry.ts (변경)

export class ProviderRegistry {
  // 기존: base provider만 캐시
  private providers = new Map<string, LLMProvider>();

  getForAgent(agentId: string): LLMProvider {
    const agent = getAgentById(agentId);
    if (!agent) throw new Error('Agent not found: ' + agentId);

    const baseProvider = this.getBase(agent.providerId);
    const providerRecord = getProviderById(agent.providerId);
    if (!providerRecord) throw new Error('Provider not found: ' + agent.providerId);

    // Agent에 연결된 MCP 서버 조회
    const mcpServers: McpServer[] = [];
    for (const serverId of agent.mcpServerIds) {
      const server = getMcpServerById(serverId);
      if (server && server.enabled) {
        mcpServers.push(server);
      }
    }

    const context: EnrichmentContext = {
      agent: {
        id: agent.id,
        systemPrompt: agent.systemPrompt,
        modelId: agent.modelId,
        reasoningLevel: agent.reasoningLevel,
        mcpServerIds: agent.mcpServerIds,
      },
      mcpServers,
      providerConfig: providerRecord.config,
    };

    return new ProviderEnricher(baseProvider, context);
  }

  // 기존 base provider 생성 로직 (이름 변경)
  private getBase(providerId: string): LLMProvider {
    const cached = this.providers.get(providerId);
    if (cached) return cached;

    const provider = getProviderById(providerId);
    if (!provider) throw new Error('Provider not found: ' + providerId);

    if (provider.providerType === 'anthropic') {
      const instance = new ClaudeCliProvider(providerId);
      this.providers.set(providerId, instance);
      return instance;
    }

    throw new Error('Unsupported provider type: ' + provider.providerType);
  }
}
```

> **주의**: ProviderEnricher는 매 `getForAgent()` 호출마다 새로 생성된다 (base provider만 캐시).
> Agent 설정이 변경되면 다음 호출에 즉시 반영됨.

---

## 데이터 흐름 상세

### 시스템 프롬프트 합성 순서

```
1. Agent.systemPrompt           (DB에서 조회, 항상 적용)
   ↓
2. Skill content                (스킬 호출 시에만, 기존 systemContext)
   ↓
3. 합성 결과 → --system-prompt 플래그
```

합성 규칙:
- Agent 프롬프트만 있음 → 그대로 전달
- 스킬 컨텍스트만 있음 → 그대로 전달 (Agent 프롬프트 비어있음)
- 둘 다 있음 → `"{agent}\n\n---\n\n{skill}"` 구분자로 합성
- 둘 다 없음 → `--system-prompt` 플래그 미전달

### MCP 서버 주입 흐름

```
Agent.mcpServerIds: ["mcp-1", "mcp-3"]
        │
        ▼
DB 조회: getMcpServerById("mcp-1"), getMcpServerById("mcp-3")
        │
        ▼
McpConfigWriter.write([server1, server3])
        │
        ▼
/tmp/mars-mcp-xxxxx/mcp-1709123456.json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_xxx" }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    }
  }
}
        │
        ▼
--mcp-config /tmp/mars-mcp-xxxxx/mcp-1709123456.json
```

### 모델 선택 우선순위

```
1. ProviderRequest.model         (호출자가 명시적으로 지정)
2. Agent.modelId                 (DB에서 조회)
3. ProviderConfig.defaultModel   (프로바이더 기본 설정)
4. (미지정 시 CLI 기본값)
```

---

## 변경 범위

### 새 파일 (3개)

| 파일 | 설명 | LOC (추정) |
|------|------|------------|
| `src/terminal/provider/enrichment.ts` | EnrichmentContext 타입 + 조립 함수 | ~30 |
| `src/terminal/provider/enricher.ts` | ProviderEnricher 데코레이터 | ~70 |
| `src/terminal/provider/mcp-config-writer.ts` | MCP 서버 → 임시 JSON 변환 | ~50 |

### 수정 파일 (1개)

| 파일 | 변경 내용 |
|------|-----------|
| `src/terminal/provider/registry.ts` | `getForAgent()`에서 EnrichmentContext 조립 + ProviderEnricher 반환 |

### 변경하지 않는 파일

| 파일 | 이유 |
|------|------|
| `src/terminal/provider/types.ts` | `ProviderRequest`, `LLMProvider` 인터페이스 변경 불필요 — 이미 필요한 필드 전부 있음 |
| `src/terminal/provider/claude-cli-provider.ts` | `buildArgs()`가 이미 모든 필드를 처리 — enricher가 request를 채우면 자동 반영 |
| `src/terminal/session-executor.ts` | `handleLLMMessage()`의 request 구성 코드 변경 불필요 — enricher가 투명하게 강화 |
| `src/terminal/cli-stream-parser.ts` | 스트림 파싱 로직 변경 없음 |
| `src/types/provider.ts` | 타입 변경 없음 |
| `src/types/agent.ts` | 타입 변경 없음 |
| `src/types/mcp-server.ts` | 타입 변경 없음 |

> **핵심 설계 원칙**: 기존 코드를 최소한으로 변경. ProviderEnricher가 데코레이터 패턴으로
> 투명하게 끼어들기 때문에, SessionExecutor와 ClaudeCliProvider는 enricher의 존재를 모른다.

---

## 테스트 전략

### Unit Tests

1. **ProviderEnricher**
   - Agent systemPrompt + 스킬 context 합성
   - Agent systemPrompt만 있을 때
   - 스킬 context만 있을 때
   - 둘 다 없을 때
   - 모델 우선순위 (request > agent > provider default)
   - MCP 서버가 있을 때 mcpConfigPath 생성
   - MCP 서버가 없을 때 mcpConfigPath undefined
   - maxBudgetUsd / permissionMode 전달

2. **McpConfigWriter**
   - stdio 서버 → JSON 변환
   - disabled 서버 스킵
   - env/headers 포함/미포함
   - 빈 서버 목록 → 파일 미생성

3. **ProviderRegistry**
   - getForAgent()가 ProviderEnricher를 반환
   - Agent에 MCP 서버 연결 시 조회 확인
   - 존재하지 않는 Agent/Provider → 에러

### Integration Tests

4. **End-to-end enrichment**
   - Agent에 systemPrompt 설정 → CLI `--system-prompt` 플래그에 반영 확인
   - Agent에 mcpServerIds 설정 → CLI `--mcp-config` 플래그에 반영 확인
   - Agent에 modelId 설정 → CLI `--model` 플래그에 반영 확인

---

## Phase 2 향후 계획 (Direct API Provider)

Phase 1의 enrichment 레이어는 CLI 플래그의 한계 내에서 동작한다.
궁극적으로 다음이 필요한 시점에 Phase 2로 진행:

| 요구사항 | CLI 한계 | Direct API 해결 |
|----------|---------|-----------------|
| 메시지 히스토리 직접 제어 | CLI가 세션을 내부 관리 | MARS가 SQLite로 직접 관리 |
| 도구 실행 가로채기 | CLI가 도구를 직접 실행 | MARS가 tool_use 이벤트를 받아 실행 |
| MCP 도구 + 빌트인 도구 통합 | CLI의 MCP 도구만 사용 | AI SDK `tools` 파라미터로 통합 |
| 에이전트 간 컨텍스트 공유 | CLI 세션이 격리됨 | 공유 메시지 히스토리 |
| 실시간 HITL 개입 | CLI에 중간 개입 불가 | 스트림 중간에 개입 가능 |

Phase 2 구현 시 `LLMProvider` 인터페이스는 그대로 유지하면서
`AnthropicApiProvider`를 새로 구현하면 된다 — ProviderEnricher도 그대로 사용 가능.

```
Phase 2 구조:
  ProviderEnricher
    └── AnthropicApiProvider (Vercel AI SDK streamText)
          └── Anthropic REST API (HTTP 직접)
```

---

## 구현 순서

1. `McpConfigWriter` — 가장 독립적, 외부 의존성 없음
2. `EnrichmentContext` 타입 정의
3. `ProviderEnricher` — McpConfigWriter 사용
4. `ProviderRegistry` 변경 — ProviderEnricher 통합
5. 테스트 작성 및 검증
