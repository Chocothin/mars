import { mkdirSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SKILLS_DIR = join(homedir(), '.mars', 'skills');

export function getSkillsDir(): string {
  return SKILLS_DIR;
}

export function ensureSkillsDir(): void {
  mkdirSync(SKILLS_DIR, { recursive: true });
}

export function skillFilePath(name: string): string {
  return join(SKILLS_DIR, `${name}.md`);
}

export async function writeSkillFile(name: string, content: string): Promise<string> {
  ensureSkillsDir();
  const filePath = skillFilePath(name);
  await Bun.write(filePath, content);
  return filePath;
}

export async function readSkillFile(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  return Bun.file(filePath).text();
}

export function deleteSkillFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

export function renameSkillFile(oldPath: string, newPath: string): void {
  if (existsSync(oldPath)) {
    renameSync(oldPath, newPath);
  }
}
