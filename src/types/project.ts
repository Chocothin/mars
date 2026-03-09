export type ProjectStatus = 'active' | 'archived';

export type TaskStatus = 'backlog' | 'blocked' | 'ready' | 'in_progress' | 'review' | 'done' | 'failed' | 'cancelled';

export const KANBAN_COLUMNS: readonly TaskStatus[] = [
  'backlog',
  'blocked',
  'ready',
  'in_progress',
  'review',
  'done',
  'failed',
  'cancelled',
] as const;

export interface Project {
  id: string;
  name: string;
  description: string;
  instructions: string;
  directoryPath: string;
  providerId?: string;
  status: ProjectStatus;
  agentIds: string[];
  mcpServerIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  instructions?: string;
  directoryPath: string;
  providerId?: string;
  agentIds?: string[];
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  instructions?: string;
  providerId?: string;
  status?: ProjectStatus;
  agentIds?: string[];
  mcpServerIds?: string[];
}

export interface ProjectQuery {
  status?: ProjectStatus;
  search?: string;
  sortBy?: 'name' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface IProjectService {
  create(input: CreateProjectInput): Promise<Project>;
  getById(id: string): Promise<Project | null>;
  update(id: string, input: UpdateProjectInput): Promise<Project | null>;
  delete(id: string): Promise<boolean>;
  list(query: ProjectQuery): Promise<Project[]>;
  validateDirectory(directoryPath: string): Promise<void>;
  initProjectDirectory(directoryPath: string): Promise<void>;
}
