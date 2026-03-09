import { describe, it, expect } from 'bun:test';
import { InputRouter } from '../../terminal/input/input-router';

describe('InputRouter', () => {
  const router = new InputRouter();

  describe('plain text messages', () => {
    it('should route plain text as message', () => {
      const result = router.route('hello world');
      expect(result).toEqual({ type: 'message', text: 'hello world' });
    });

    it('should route empty input as message with empty text', () => {
      const result = router.route('');
      expect(result).toEqual({ type: 'message', text: '' });
    });

    it('should route whitespace-only input as message with empty text', () => {
      const result = router.route('   ');
      expect(result).toEqual({ type: 'message', text: '' });
    });

    it('should route single slash as message', () => {
      const result = router.route('/');
      expect(result).toEqual({ type: 'message', text: '/' });
    });
  });

  describe('shell commands', () => {
    it('should route shell command with bang prefix', () => {
      const result = router.route('!ls -la');
      expect(result).toEqual({ type: 'shell', command: 'ls -la' });
    });

    it('should route bang with only whitespace as shell with empty command', () => {
      const result = router.route('!');
      expect(result).toEqual({ type: 'shell', command: '' });
    });

    it('should route bang with trailing whitespace', () => {
      const result = router.route('!   ls -la   ');
      expect(result).toEqual({ type: 'shell', command: 'ls -la' });
    });
  });

  describe('builtin commands', () => {
    it('should route /cd with single argument', () => {
      const result = router.route('/cd /tmp');
      expect(result).toEqual({ type: 'builtin', name: 'cd', args: ['/tmp'] });
    });

    it('should route /cd with multiple arguments', () => {
      const result = router.route('/cd path with spaces');
      expect(result).toEqual({ type: 'builtin', name: 'cd', args: ['path', 'with', 'spaces'] });
    });

    it('should route /pwd without arguments', () => {
      const result = router.route('/pwd');
      expect(result).toEqual({ type: 'builtin', name: 'pwd', args: [] });
    });

    it('should route /clear without arguments', () => {
      const result = router.route('/clear');
      expect(result).toEqual({ type: 'builtin', name: 'clear', args: [] });
    });

    it('should route /help without arguments', () => {
      const result = router.route('/help');
      expect(result).toEqual({ type: 'builtin', name: 'help', args: [] });
    });

    it('should route /pwd with trailing whitespace', () => {
      const result = router.route('/pwd   ');
      expect(result).toEqual({ type: 'builtin', name: 'pwd', args: [] });
    });

    it('should route /cd with trailing whitespace', () => {
      const result = router.route('/cd /tmp   ');
      expect(result).toEqual({ type: 'builtin', name: 'cd', args: ['/tmp'] });
    });
  });

  describe('skill invocations', () => {
    it('should route skill with remainder', () => {
      const result = router.route('/deploy production');
      expect(result).toEqual({ type: 'skill', skillName: 'deploy', remainder: 'production' });
    });

    it('should route skill without remainder', () => {
      const result = router.route('/myskill');
      expect(result).toEqual({ type: 'skill', skillName: 'myskill', remainder: '' });
    });

    it('should route skill with multiple word remainder', () => {
      const result = router.route('/build with flags');
      expect(result).toEqual({ type: 'skill', skillName: 'build', remainder: 'with flags' });
    });

    it('should route skill with trailing whitespace in remainder', () => {
      const result = router.route('/deploy production   ');
      expect(result).toEqual({ type: 'skill', skillName: 'deploy', remainder: 'production' });
    });

    it('should treat slash with leading spaces before name as message', () => {
      const result = router.route('/  deploy production');
      expect(result).toEqual({ type: 'message', text: '/  deploy production' });
    });
  });

  describe('edge cases', () => {
    it('should handle input with leading whitespace', () => {
      const result = router.route('   hello world');
      expect(result).toEqual({ type: 'message', text: 'hello world' });
    });

    it('should handle input with trailing whitespace', () => {
      const result = router.route('hello world   ');
      expect(result).toEqual({ type: 'message', text: 'hello world' });
    });

    it('should handle shell command with leading whitespace', () => {
      const result = router.route('   !ls -la');
      expect(result).toEqual({ type: 'shell', command: 'ls -la' });
    });

    it('should handle builtin with leading whitespace', () => {
      const result = router.route('   /pwd');
      expect(result).toEqual({ type: 'builtin', name: 'pwd', args: [] });
    });

    it('should handle skill with leading whitespace', () => {
      const result = router.route('   /deploy production');
      expect(result).toEqual({ type: 'skill', skillName: 'deploy', remainder: 'production' });
    });

    it('should handle multiple spaces between skill name and remainder', () => {
      const result = router.route('/deploy    production');
      expect(result).toEqual({ type: 'skill', skillName: 'deploy', remainder: 'production' });
    });

    it('should handle multiple spaces between builtin name and args', () => {
      const result = router.route('/cd    /tmp');
      expect(result).toEqual({ type: 'builtin', name: 'cd', args: ['/tmp'] });
    });
  });
});
