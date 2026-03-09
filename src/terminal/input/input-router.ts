export type InputRouteResult =
  | { type: 'message'; text: string }
  | { type: 'shell'; command: string }
  | { type: 'skill'; skillName: string; remainder: string }
  | { type: 'builtin'; name: string; args: string[] };

const BUILTINS = new Set(['cd', 'pwd', 'clear', 'help']);

export class InputRouter {
  route(input: string): InputRouteResult {
    const trimmed = input.trim();
    if (!trimmed) return { type: 'message', text: '' };

    if (trimmed.startsWith('!')) {
      return { type: 'shell', command: trimmed.slice(1).trim() };
    }

    if (trimmed.startsWith('/')) {
      const withoutSlash = trimmed.slice(1);
      const spaceIndex = withoutSlash.indexOf(' ');
      const name = spaceIndex === -1 ? withoutSlash : withoutSlash.slice(0, spaceIndex);
      const remainder = spaceIndex === -1 ? '' : withoutSlash.slice(spaceIndex + 1).trim();

      if (!name) return { type: 'message', text: trimmed };

      if (BUILTINS.has(name)) {
        const args = remainder ? remainder.split(/\s+/) : [];
        return { type: 'builtin', name, args };
      }

      return { type: 'skill', skillName: name, remainder };
    }

    return { type: 'message', text: trimmed };
  }
}
