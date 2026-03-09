export type MemoryTier = 'global' | 'project' | 'agent';
export type MemoryFileType = 'markdown' | 'json';

export interface MemoryFile {
  id: string;
  tier: MemoryTier;
  scope: string;
  filename: string;
  relativePath: string;
  isProtected: boolean;
  content: string;
  fileType: MemoryFileType;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryMetadata {
  id: string;
  tier: MemoryTier;
  scope: string;
  filename: string;
  filePath: string;
  sizeBytes: number;
  tokenCount: number;
  isProtected: boolean;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  accessCount: number;
  checksum: string;
}

export interface MemoryFrontmatter {
  title?: string;
  tags?: string[];
  tier?: MemoryTier;
  scope?: string;
  createdAt?: string;
  protected?: boolean;
}

export interface CreateMemoryFileInput {
  tier: MemoryTier;
  scope: string;
  filename: string;
  content: string;
  tags?: string[];
}

export interface UpdateMemoryFileInput {
  content?: string;
  tags?: string[];
  filename?: string;
}

export interface MemoryQuery {
  tier?: MemoryTier;
  scope?: string;
  tags?: string[];
  search?: string;
  isProtected?: boolean;
  sortBy?: 'createdAt' | 'updatedAt' | 'lastAccessedAt' | 'sizeBytes' | 'tokenCount';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface MemoryStats {
  totalFiles: number;
  totalSizeBytes: number;
  totalTokens: number;
  protectedFiles: number;
  compactableFiles: number;
  byTier: Record<MemoryTier, { files: number; sizeBytes: number; tokens: number }>;
}

export interface IMemoryStorage {
  createFile(input: CreateMemoryFileInput): Promise<MemoryFile>;
  readFile(id: string): Promise<MemoryFile | null>;
  updateFile(id: string, input: UpdateMemoryFileInput): Promise<MemoryFile | null>;
  deleteFile(id: string): Promise<boolean>;
  listFiles(query: MemoryQuery): Promise<MemoryFile[]>;
  getFilePath(tier: MemoryTier, scope: string, filename: string): string;
  ensureDirectoryExists(tier: MemoryTier, scope: string): Promise<void>;
}

export interface IMemoryIndex {
  index(metadata: MemoryMetadata): Promise<void>;
  update(id: string, updates: Partial<MemoryMetadata>): Promise<void>;
  remove(id: string): Promise<void>;
  query(q: MemoryQuery): Promise<MemoryMetadata[]>;
  getById(id: string): Promise<MemoryMetadata | null>;
  recordAccess(id: string): Promise<void>;
  getStats(tier?: MemoryTier, scope?: string): Promise<MemoryStats>;
}

export interface CompactionResult {
  compactedFiles: number;
  originalTokens: number;
  resultTokens: number;
  savedTokens: number;
  newFileId: string;
}

export interface CompactionEstimate {
  targetFiles: number;
  currentTokens: number;
  estimatedResultTokens: number;
  estimatedSaving: number;
}

export interface ICompactor {
  identifyTargets(tier: MemoryTier, scope: string, maxTokens: number): Promise<MemoryMetadata[]>;
  compact(fileIds: string[]): Promise<CompactionResult>;
  estimateCompaction(fileIds: string[]): Promise<CompactionEstimate>;
}
