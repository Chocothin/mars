import { SkillService } from '../../skills/service';

export class SkillResolver {
  constructor(private skillService: SkillService) {}

  async resolve(skillName: string): Promise<{ name: string; content: string } | null> {
    const skills = await this.skillService.list({ search: skillName });
    const match = skills.find(s => s.name === skillName);
    if (!match) return null;
    return { name: match.name, content: match.content };
  }

  async listNames(): Promise<string[]> {
    const skills = await this.skillService.list({});
    return skills.map(s => s.name);
  }
}
