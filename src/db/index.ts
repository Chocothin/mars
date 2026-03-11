import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MARS_DIR = join(homedir(), '.mars');

function getDbPath(): string {
  return process.env.MARS_DB_PATH || join(MARS_DIR, 'mars.db');
}

let db: Database;

export function getDb(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function initDatabase(): Database {
  const dbPath = getDbPath();
  if (!dbPath.startsWith(':')) {
    mkdirSync(MARS_DIR, { recursive: true });
  }

  db = new Database(dbPath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');

  createSchema(db);

  return db;
}

function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_files (
      id TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      scope TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      token_count INTEGER NOT NULL DEFAULT 0,
      is_protected INTEGER NOT NULL DEFAULT 0,
      tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      checksum TEXT NOT NULL
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_tier ON memory_files (tier)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_files (scope)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_tier_scope ON memory_files (tier, scope)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_tags ON memory_files (tags)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_updated_at ON memory_files (updated_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_is_protected ON memory_files (is_protected)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      directory_path TEXT NOT NULL,
      provider_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      agent_ids TEXT NOT NULL DEFAULT '[]',
      mcp_server_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_directory ON projects (directory_path)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects (updated_at)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_task_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog',
      priority TEXT NOT NULL DEFAULT 'medium',
      "order" INTEGER NOT NULL DEFAULT 0,
      assigned_agent_type TEXT,
      assigned_agent_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks (project_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (project_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks (parent_task_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_order ON tasks (project_id, status, "order")');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_assigned_agent_id ON tasks (project_id, assigned_agent_id)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      PRIMARY KEY (task_id, depends_on_task_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies (task_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on ON task_dependencies (depends_on_task_id)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      transport_type TEXT NOT NULL DEFAULT 'stdio',
      command TEXT,
      args TEXT NOT NULL DEFAULT '[]',
      url TEXT,
      headers TEXT NOT NULL DEFAULT '{}',
      env TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers (name)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mcp_servers_transport ON mcp_servers (transport_type)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers (enabled)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      provider_type TEXT NOT NULL DEFAULT 'anthropic',
      auth_method TEXT NOT NULL DEFAULT 'oauth',
      api_key TEXT,
      base_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      config TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_providers_name ON providers (name)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_providers_type ON providers (provider_type)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_providers_enabled ON providers (enabled)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_providers_default ON providers (is_default)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      reasoning_level TEXT NOT NULL DEFAULT 'none',
      worker_count INTEGER NOT NULL DEFAULT 1,
      mcp_server_ids TEXT NOT NULL DEFAULT '[]',
      skill_ids TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES providers(id)
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_agents_name ON agents (name)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agents_provider ON agents (provider_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agents_model ON agents (model_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agents_enabled ON agents (enabled)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agents_updated_at ON agents (updated_at)');

  ensureTextColumn(db, 'projects', 'provider_id', "''");
  ensureTextColumn(db, 'projects', 'instructions', "''");
  ensureNullableTextColumn(db, 'tasks', 'assigned_agent_id');
  ensureTextColumn(db, 'agents', 'skill_ids', "'[]'");
  ensureIntegerColumn(db, 'agents', 'worker_count', '1');

  // Quality verification columns for tasks
  ensureTextColumn(db, 'tasks', 'acceptance_criteria', "'[]'");
  ensureTextColumn(db, 'tasks', 'expected_outputs', "'[]'");
  migrateAssignedAgentTypeToJsonArray(db);
  ensureIntegerColumn(db, 'tasks', 'max_retries', '2');
  ensureIntegerColumn(db, 'tasks', 'retry_count', '0');
  ensureNullableTextColumn(db, 'tasks', 'review_feedback');

  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      file_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_skills_name ON skills (name)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_skills_updated_at ON skills (updated_at)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS terminal_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      mcp_server_ids TEXT NOT NULL DEFAULT '[]',
      working_directory TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      cli_session_id TEXT,
      access_token TEXT NOT NULL DEFAULT '',
      runtime_fingerprint TEXT NOT NULL DEFAULT '',
      runtime_version INTEGER NOT NULL DEFAULT 1,
      restart_required INTEGER NOT NULL DEFAULT 0,
      restart_reason TEXT NOT NULL DEFAULT '',
      restart_marked_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);

  ensureTextColumn(db, 'terminal_sessions', 'mcp_server_ids', "'[]'");
  ensureTextColumn(db, 'terminal_sessions', 'access_token', "''");
  ensureTextColumn(db, 'terminal_sessions', 'runtime_fingerprint', "''");
  ensureIntegerColumn(db, 'terminal_sessions', 'runtime_version', '1');
  ensureIntegerColumn(db, 'terminal_sessions', 'restart_required', '0');
  ensureTextColumn(db, 'terminal_sessions', 'restart_reason', "''");
  ensureIntegerColumn(db, 'terminal_sessions', 'restart_marked_at', '0');
  ensureTerminalSessionsIsolation(db);

  db.exec('CREATE INDEX IF NOT EXISTS idx_terminal_sessions_project ON terminal_sessions (project_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_terminal_sessions_agent ON terminal_sessions (agent_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_terminal_sessions_status ON terminal_sessions (status)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS terminal_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      content TEXT NOT NULL DEFAULT '',
      metadata TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES terminal_sessions(id) ON DELETE CASCADE
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_terminal_messages_session ON terminal_messages (session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_terminal_messages_session_created ON terminal_messages (session_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_terminal_messages_role ON terminal_messages (session_id, role)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_terminal_messages_type ON terminal_messages (session_id, type)');

  // ─── Orchestration: Runs ───

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      root_task_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      config TEXT NOT NULL DEFAULT '{}',
      execution_plan TEXT,
      result TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_project ON runs (project_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_created ON runs (created_at)');

  // ─── Orchestration: Task Executions ───

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_executions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt INTEGER NOT NULL DEFAULT 1,
      input TEXT NOT NULL DEFAULT '{}',
      output TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      duration_ms INTEGER,
      error TEXT,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_task_exec_run ON task_executions (run_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_exec_task ON task_executions (task_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_exec_agent ON task_executions (agent_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_exec_status ON task_executions (status)');

  // ─── HITL: Interactions ───

  db.exec(`
    CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT,
      agent_id TEXT,
      session_id TEXT,
      type TEXT NOT NULL,
      level INTEGER NOT NULL CHECK (level IN (1, 2, 3)),
      status TEXT NOT NULL DEFAULT 'pending',
      question_title TEXT NOT NULL,
      question_description TEXT NOT NULL,
      question_payload TEXT NOT NULL DEFAULT '{}',
      suggested_action TEXT,
      suggested_message TEXT,
      options TEXT,
      auto_decision_action TEXT,
      auto_decision_reason TEXT,
      auto_decision_at INTEGER,
      response_action TEXT,
      response_message TEXT,
      response_modified_payload TEXT,
      response_by TEXT,
      timeout_ms INTEGER,
      fallback_action TEXT NOT NULL DEFAULT 'fail',
      expires_at INTEGER,
      source TEXT NOT NULL DEFAULT 'orchestrator',
      batch_index INTEGER,
      attempt INTEGER,
      priority TEXT NOT NULL DEFAULT 'normal',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      responded_at INTEGER,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_interactions_run_id ON interactions (run_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_interactions_status ON interactions (status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_interactions_run_status ON interactions (run_id, status)');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_interactions_expires ON interactions (expires_at) WHERE status = 'pending' AND expires_at IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_interactions_task_id ON interactions (task_id) WHERE task_id IS NOT NULL`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_interactions_type ON interactions (type)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `);

  // ─── Messaging: P2P Messages ───

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('dm','broadcast','task_assignment','shutdown','plan_approval','idle_notification','review_feedback')),
      payload TEXT NOT NULL DEFAULT '{}',
      summary TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      read_at INTEGER,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent_id, read, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_from_agent ON messages(from_agent_id, created_at)');

  ensureNullableTextColumn(db, 'messages', 'summary');
  migrateMessagesCheckConstraint(db);

  // ─── Agent Lifecycle: Heartbeats ───

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_heartbeats (
      agent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','working','offline')),
      current_task_id TEXT,
      last_seen INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, run_id),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_heartbeats_run ON agent_heartbeats(run_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_heartbeats_last_seen ON agent_heartbeats(last_seen)');
}

function ensureTextColumn(db: Database, tableName: string, columnName: string, defaultValueSql: string): void {
  const rows = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  const hasColumn = rows.some((row) => row.name === columnName);
  if (hasColumn) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} TEXT NOT NULL DEFAULT ${defaultValueSql}`);
}

function ensureIntegerColumn(db: Database, tableName: string, columnName: string, defaultValueSql: string): void {
  const rows = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  const hasColumn = rows.some((row) => row.name === columnName);
  if (hasColumn) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} INTEGER NOT NULL DEFAULT ${defaultValueSql}`);
}

function ensureNullableTextColumn(db: Database, tableName: string, columnName: string): void {
  const rows = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  const hasColumn = rows.some((row) => row.name === columnName);
  if (hasColumn) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} TEXT`);
}

function ensureTerminalSessionsIsolation(db: Database): void {
  const row = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'terminal_sessions'").get() as { sql?: string } | null;
  const createSql = row?.sql ?? '';

  if (!createSql.includes('UNIQUE(project_id, agent_id)')) {
    return;
  }

  db.exec('BEGIN');

  try {
    db.exec(`
      CREATE TABLE terminal_sessions_v2 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        mcp_server_ids TEXT NOT NULL DEFAULT '[]',
        working_directory TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        cli_session_id TEXT,
        access_token TEXT NOT NULL DEFAULT '',
        runtime_fingerprint TEXT NOT NULL DEFAULT '',
        runtime_version INTEGER NOT NULL DEFAULT 1,
        restart_required INTEGER NOT NULL DEFAULT 0,
        restart_reason TEXT NOT NULL DEFAULT '',
        restart_marked_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      INSERT INTO terminal_sessions_v2 (id, project_id, agent_id, mcp_server_ids, working_directory, status, cli_session_id, access_token, runtime_fingerprint, runtime_version, restart_required, restart_reason, restart_marked_at, created_at, updated_at)
      SELECT id, project_id, agent_id, mcp_server_ids, working_directory, status, cli_session_id, '', '', 1, 0, '', 0, created_at, updated_at
      FROM terminal_sessions
    `);

    db.exec('DROP TABLE terminal_sessions');
    db.exec('ALTER TABLE terminal_sessions_v2 RENAME TO terminal_sessions');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateMessagesCheckConstraint(db: Database): void {
  const row = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get() as { sql?: string } | null;
  const createSql = row?.sql ?? '';

  if (createSql.includes('task_report')) return;
  if (!createSql.includes('CHECK')) return;

  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE messages_v2 (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        from_agent_id TEXT NOT NULL,
        to_agent_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('dm','broadcast','task_assignment','shutdown','plan_approval','idle_notification','review_feedback','task_report','escalation')),
        payload TEXT NOT NULL DEFAULT '{}',
        summary TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      INSERT INTO messages_v2 (id, run_id, from_agent_id, to_agent_id, type, payload, summary, read, created_at, read_at)
      SELECT id, run_id, from_agent_id, to_agent_id, type, payload, summary, read, created_at, read_at
      FROM messages
    `);

    db.exec('DROP TABLE messages');
    db.exec('ALTER TABLE messages_v2 RENAME TO messages');

    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent_id, read, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_from_agent ON messages(from_agent_id, created_at)');

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateAssignedAgentTypeToJsonArray(db: Database): void {
  const rows = db.query(
    `SELECT id, assigned_agent_type FROM tasks WHERE assigned_agent_type IS NOT NULL AND assigned_agent_type NOT LIKE '[%'`,
  ).all() as Array<{ id: string; assigned_agent_type: string }>;
  if (rows.length === 0) return;

  const stmt = db.prepare('UPDATE tasks SET assigned_agent_type = $val WHERE id = $id');
  for (const row of rows) {
    const types = row.assigned_agent_type.split(',').map(s => s.trim()).filter(Boolean);
    stmt.run({ $id: row.id, $val: JSON.stringify(types) });
  }
}
