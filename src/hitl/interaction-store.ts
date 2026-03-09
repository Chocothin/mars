import { Database } from 'bun:sqlite';
import { mkdir, writeFile, readFile, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Interaction,
  InteractionStatus,
  QuestionType,
  AutonomyLevel,
  FallbackAction,
  ResponseAction,
  InteractionQuestion,
  InteractionOption,
  AutoDecision,
  InteractionResponse,
  InteractionMetadata,
  PendingInteractionSnapshot,
} from './types';

// ─── Row 인터페이스: DB snake_case 컬럼 매핑 ───

interface InteractionRow {
  id: string;
  run_id: string;
  task_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  type: string;
  level: number;
  status: string;
  question_title: string;
  question_description: string;
  question_payload: string;
  suggested_action: string | null;
  suggested_message: string | null;
  options: string | null;
  auto_decision_action: string | null;
  auto_decision_reason: string | null;
  auto_decision_at: number | null;
  response_action: string | null;
  response_message: string | null;
  response_modified_payload: string | null;
  response_by: string | null;
  timeout_ms: number | null;
  fallback_action: string;
  expires_at: number | null;
  source: string;
  batch_index: number | null;
  attempt: number | null;
  priority: string;
  tags: string;
  created_at: number;
  responded_at: number | null;
}

// ─── Row → Interaction 변환 ───

function rowToInteraction(row: InteractionRow): Interaction {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    type: row.type as QuestionType,
    level: row.level as AutonomyLevel,
    status: row.status as InteractionStatus,
    question: {
      title: row.question_title,
      description: row.question_description,
      payload: JSON.parse(row.question_payload) as Record<string, unknown>,
      suggestedAction: row.suggested_action as ResponseAction,
      suggestedMessage: row.suggested_message,
      options: row.options ? (JSON.parse(row.options) as InteractionOption[]) : null,
    },
    autoDecision: row.auto_decision_action
      ? {
          action: row.auto_decision_action as ResponseAction,
          reason: row.auto_decision_reason!,
          decidedAt: row.auto_decision_at!,
        }
      : null,
    response: row.response_action
      ? {
          action: row.response_action as ResponseAction,
          message: row.response_message,
          modifiedPayload: row.response_modified_payload
            ? (JSON.parse(row.response_modified_payload) as Record<string, unknown>)
            : null,
          respondedBy: row.response_by as 'human' | 'timeout' | 'system',
        }
      : null,
    timeoutMs: row.timeout_ms,
    fallbackAction: row.fallback_action as FallbackAction,
    expiresAt: row.expires_at,
    metadata: {
      source: row.source as InteractionMetadata['source'],
      batchIndex: row.batch_index,
      attempt: row.attempt,
      priority: row.priority as InteractionMetadata['priority'],
      tags: JSON.parse(row.tags) as string[],
    },
    createdAt: row.created_at,
    respondedAt: row.responded_at,
  };
}

// ─── InteractionStore: SQLite CRUD + 파일 영속화 ───

export class InteractionStore {
  private db: Database;
  private pendingDir: string;

  constructor(deps: { db: Database; dataDir: string }) {
    this.db = deps.db;
    this.pendingDir = join(deps.dataDir, 'pending');
  }

  async initialize(): Promise<void> {
    await mkdir(this.pendingDir, { recursive: true });
  }

  // ─── CRUD ───

  async save(interaction: Interaction): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO interactions (
        id, run_id, task_id, agent_id, session_id,
        type, level, status,
        question_title, question_description, question_payload,
        suggested_action, suggested_message, options,
        auto_decision_action, auto_decision_reason, auto_decision_at,
        response_action, response_message, response_modified_payload, response_by,
        timeout_ms, fallback_action, expires_at,
        source, batch_index, attempt, priority, tags,
        created_at, responded_at
      ) VALUES (
        $id, $runId, $taskId, $agentId, $sessionId,
        $type, $level, $status,
        $questionTitle, $questionDescription, $questionPayload,
        $suggestedAction, $suggestedMessage, $options,
        $autoDecisionAction, $autoDecisionReason, $autoDecisionAt,
        $responseAction, $responseMessage, $responseModifiedPayload, $responseBy,
        $timeoutMs, $fallbackAction, $expiresAt,
        $source, $batchIndex, $attempt, $priority, $tags,
        $createdAt, $respondedAt
      )
    `);
    stmt.run({
      $id: interaction.id,
      $runId: interaction.runId,
      $taskId: interaction.taskId,
      $agentId: interaction.agentId,
      $sessionId: interaction.sessionId,
      $type: interaction.type,
      $level: interaction.level,
      $status: interaction.status,
      $questionTitle: interaction.question.title,
      $questionDescription: interaction.question.description,
      $questionPayload: JSON.stringify(interaction.question.payload),
      $suggestedAction: interaction.question.suggestedAction,
      $suggestedMessage: interaction.question.suggestedMessage,
      $options: interaction.question.options ? JSON.stringify(interaction.question.options) : null,
      $autoDecisionAction: interaction.autoDecision?.action ?? null,
      $autoDecisionReason: interaction.autoDecision?.reason ?? null,
      $autoDecisionAt: interaction.autoDecision?.decidedAt ?? null,
      $responseAction: interaction.response?.action ?? null,
      $responseMessage: interaction.response?.message ?? null,
      $responseModifiedPayload: interaction.response?.modifiedPayload
        ? JSON.stringify(interaction.response.modifiedPayload)
        : null,
      $responseBy: interaction.response?.respondedBy ?? null,
      $timeoutMs: interaction.timeoutMs,
      $fallbackAction: interaction.fallbackAction,
      $expiresAt: interaction.expiresAt,
      $source: interaction.metadata.source,
      $batchIndex: interaction.metadata.batchIndex,
      $attempt: interaction.metadata.attempt,
      $priority: interaction.metadata.priority,
      $tags: JSON.stringify(interaction.metadata.tags),
      $createdAt: interaction.createdAt,
      $respondedAt: interaction.respondedAt,
    });
  }

  async update(interaction: Interaction): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE interactions SET
        status = $status,
        auto_decision_action = $autoDecisionAction,
        auto_decision_reason = $autoDecisionReason,
        auto_decision_at = $autoDecisionAt,
        response_action = $responseAction,
        response_message = $responseMessage,
        response_modified_payload = $responseModifiedPayload,
        response_by = $responseBy,
        responded_at = $respondedAt
      WHERE id = $id
    `);
    stmt.run({
      $status: interaction.status,
      $autoDecisionAction: interaction.autoDecision?.action ?? null,
      $autoDecisionReason: interaction.autoDecision?.reason ?? null,
      $autoDecisionAt: interaction.autoDecision?.decidedAt ?? null,
      $responseAction: interaction.response?.action ?? null,
      $responseMessage: interaction.response?.message ?? null,
      $responseModifiedPayload: interaction.response?.modifiedPayload
        ? JSON.stringify(interaction.response.modifiedPayload)
        : null,
      $responseBy: interaction.response?.respondedBy ?? null,
      $respondedAt: interaction.respondedAt,
      $id: interaction.id,
    });
  }

  async getById(id: string): Promise<Interaction | null> {
    const stmt = this.db.prepare('SELECT * FROM interactions WHERE id = $id LIMIT 1');
    const row = stmt.get({ $id: id }) as InteractionRow | undefined;
    return row ? rowToInteraction(row) : null;
  }

  async getByRunId(runId: string): Promise<Interaction[]> {
    const stmt = this.db.prepare(
      'SELECT * FROM interactions WHERE run_id = $runId ORDER BY created_at ASC'
    );
    const rows = stmt.all({ $runId: runId }) as InteractionRow[];
    return rows.map(rowToInteraction);
  }

  async list(status?: InteractionStatus): Promise<Interaction[]> {
    if (status) {
      const stmt = this.db.prepare(
        'SELECT * FROM interactions WHERE status = $status ORDER BY created_at ASC'
      );
      const rows = stmt.all({ $status: status }) as InteractionRow[];
      return rows.map(rowToInteraction);
    }

    const stmt = this.db.prepare('SELECT * FROM interactions ORDER BY created_at ASC');
    const rows = stmt.all() as InteractionRow[];
    return rows.map(rowToInteraction);
  }

  async getPendingByRunId(runId: string): Promise<Interaction[]> {
    const stmt = this.db.prepare(
      "SELECT * FROM interactions WHERE run_id = $runId AND status = 'pending' ORDER BY created_at ASC"
    );
    const rows = stmt.all({ $runId: runId }) as InteractionRow[];
    return rows.map(rowToInteraction);
  }

  async getExpired(now: number): Promise<Interaction[]> {
    const stmt = this.db.prepare(
      "SELECT * FROM interactions WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= $now"
    );
    const rows = stmt.all({ $now: now }) as InteractionRow[];
    return rows.map(rowToInteraction);
  }

  // ─── 파일 영속화 (크래시 복구용) ───

  async savePendingSnapshot(snapshot: PendingInteractionSnapshot): Promise<void> {
    const filePath = join(this.pendingDir, `${snapshot.interaction.id}.json`);
    await writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  }

  async deletePendingSnapshot(interactionId: string): Promise<void> {
    const filePath = join(this.pendingDir, `${interactionId}.json`);
    try {
      await unlink(filePath);
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  async loadAllPendingSnapshots(): Promise<PendingInteractionSnapshot[]> {
    const files = await readdir(this.pendingDir);
    const snapshots: PendingInteractionSnapshot[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await readFile(join(this.pendingDir, file), 'utf-8');
        const snapshot = JSON.parse(content) as PendingInteractionSnapshot;
        snapshots.push(snapshot);
      } catch (err) {
        console.error(`[HITL Recovery] Failed to parse ${file}:`, err);
      }
    }

    return snapshots;
  }
}
