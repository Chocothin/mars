import type { TaskStatus } from './project';

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Task {
  id: string;
  projectId: string;
  parentTaskId: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  order: number;
  assignedAgentType: string[];
  assignedAgentId: string | null;
  dependsOnTaskIds: string[];
  acceptanceCriteria: string[];
  expectedOutputs: string[];
  maxRetries: number;
  retryCount: number;
  reviewFeedback: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskDependency {
  taskId: string;
  dependsOnTaskId: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  parentTaskId?: string;
  assignedAgentType?: string[];
  assignedAgentId?: string;
  dependsOnTaskIds?: string[];
  acceptanceCriteria?: string[];
  expectedOutputs?: string[];
  maxRetries?: number;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  order?: number;
  assignedAgentType?: string[] | null;
  assignedAgentId?: string | null;
  acceptanceCriteria?: string[];
  expectedOutputs?: string[];
  maxRetries?: number;
  retryCount?: number;
  reviewFeedback?: string | null;
}

export interface TaskQuery {
  status?: TaskStatus;
  priority?: TaskPriority;
  parentTaskId?: string | null;
  assignedAgentType?: string;
  assignedAgentId?: string;
  search?: string;
  sortBy?: 'order' | 'createdAt' | 'updatedAt' | 'priority';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface TaskUpdateResult {
  task: Task;
  warnings: string[];
  autoTransitioned: TaskAutoTransition[];
}

export interface TaskAutoTransition {
  taskId: string;
  taskTitle: string;
  from: TaskStatus;
  to: TaskStatus;
}

export interface ITaskService {
  create(projectId: string, input: CreateTaskInput): Promise<Task>;
  getById(projectId: string, taskId: string): Promise<Task | null>;
  update(projectId: string, taskId: string, input: UpdateTaskInput): Promise<TaskUpdateResult | null>;
  delete(projectId: string, taskId: string): Promise<boolean>;
  list(projectId: string, query: TaskQuery): Promise<Task[]>;
  reorderColumn(projectId: string, status: TaskStatus): Promise<void>;
  addDependency(projectId: string, taskId: string, dependsOnTaskId: string): Promise<void>;
  removeDependency(projectId: string, taskId: string, dependsOnTaskId: string): Promise<void>;
  getDependencies(projectId: string, taskId: string): Promise<Task[]>;
  assignAgent(projectId: string, taskId: string, agentId: string): Promise<Task | null>;
  clearAssignedAgent(projectId: string, taskId: string): Promise<Task | null>;
}
