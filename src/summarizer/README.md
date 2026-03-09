# Summarizer Module

한국어 텍스트를 한 줄~몇 문장으로 요약하는 경량 로컬 AI 모듈.
멀티 에이전트 간 메시지를 **말풍선** 형태로 표시할 때 사용합니다.

## Architecture

```
┌──────────────────────┐       HTTP (localhost:19540)       ┌────────────────────────┐
│   TypeScript Client  │ ─────────────────────────────────▶ │   Python Microservice  │
│   (Bun / mars)       │ ◀───────────────────────────────── │   (KoBART, 124M)       │
└──────────────────────┘                                    └────────────────────────┘
```

- **Python 서버**: `EbanLee/kobart-summary-v3` (124M 파라미터) 모델을 로드하여 HTTP로 서빙
- **TypeScript 클라이언트**: `SummarizerClient`가 HTTP 호출, `SummarizerService`가 말풍선 요약 + fallback 처리
- 서버 불가 시 단순 truncate로 fallback

## Model

| 항목 | 값 |
|------|-----|
| 모델 | `EbanLee/kobart-summary-v3` |
| 파라미터 | 124M |
| 아키텍처 | KoBART (encoder-decoder) |
| 언어 | 한국어 전용 |
| 짧은 텍스트 (150자) | 0.6~1.3s |
| 긴 텍스트 (3000자) | 3~5s |

## Quick Start

### 1. Setup (최초 1회)

```bash
bash src/summarizer/python/setup.sh
```

venv 생성, 의존성 설치, 모델 프리다운로드를 수행합니다.

### 2. Start Server

```bash
bash src/summarizer/python/start.sh
```

`http://127.0.0.1:19540` 에서 서빙됩니다.

### 3. API

**POST /summarize**
```json
{
  "text": "요약할 한국어 텍스트...",
  "max_length": 128,
  "min_length": 12
}
```

Response:
```json
{
  "summary": "요약 결과",
  "input_chars": 320,
  "input_tokens": 131,
  "output_chars": 94,
  "elapsed_ms": 1167
}
```

**GET /health**
```json
{ "status": "ok", "model": "EbanLee/kobart-summary-v3" }
```

## TypeScript Usage

```typescript
import { SummarizerService } from './summarizer';

const summarizer = new SummarizerService();

// 말풍선 요약 (서버 불가 시 자동 fallback)
const bubble = await summarizer.summarizeForBubble(longMessage);

// 직접 요약
const result = await summarizer.summarize({ text: '...', maxLength: 64 });

// 서버 상태 확인
const ok = await summarizer.isAvailable();
```

## File Structure

```
src/summarizer/
├── index.ts              # Public exports
├── types.ts              # SummarizeRequest, SummarizeResult, ISummarizer
├── client.ts             # HTTP client (localhost:19540)
├── service.ts            # SummarizerService (summarizeForBubble + fallback)
├── README.md             # This file
└── python/
    ├── server.py          # KoBART HTTP server
    ├── requirements.txt   # Python dependencies
    ├── setup.sh           # venv + model setup
    ├── start.sh           # Server launcher
    └── .venv/             # (gitignored) Python virtual environment
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SUMMARIZER_URL` | `http://127.0.0.1:19540` | Python 서버 주소 |

## Notes

- `.venv/` 디렉토리는 `.gitignore`에 포함되어 있습니다
- 모델은 HuggingFace 캐시 (`~/.cache/huggingface/`) 에 저장됩니다
- M4 Mac에서 1~2초대 응답 예상 (현재 테스트 머신: Intel/M 시리즈)
