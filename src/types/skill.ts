export interface Skill {
  id: string;
  name: string;
  content: string;
  filePath: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSkillInput {
  name: string;
  content: string;
}

export interface UpdateSkillInput {
  name?: string;
  content?: string;
}

export interface SkillQuery {
  search?: string;
  sortBy?: 'name' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface ISkillService {
  create(input: CreateSkillInput): Promise<Skill>;
  getById(id: string): Promise<Skill | null>;
  update(id: string, input: UpdateSkillInput): Promise<Skill | null>;
  delete(id: string): Promise<boolean>;
  list(query: SkillQuery): Promise<Skill[]>;
}
