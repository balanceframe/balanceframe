import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const nuxtRequire = createRequire(require.resolve('nuxt/package.json'));
const devtoolsRequire = createRequire(nuxtRequire.resolve('@nuxt/devtools/package.json'));
const editorRequire = createRequire(devtoolsRequire.resolve('launch-editor'));
const shellQuote = editorRequire('shell-quote') as {
  parse(command: string): unknown[];
  quote(tokens: (string | { comment: string })[]): string;
};
const guessEditor = editorRequire('./guess') as (command: string) => string[];

describe('Nuxt devtools editor shell quoting', () => {
  // GHSA-pqg4-j6r4-53mv: only construct text; never execute quoted output.
  it.each(['\n', '\r', '\u2028', '\u2029'])('rejects a line terminator after a comment: %j', (terminator) => {
    expect(() => shellQuote.quote(['editor', { comment: 'note' }, `file${terminator}MARKER`])).toThrow(TypeError);
  });

  it('preserves editor parsing and ordinary quoted arguments', () => {
    expect(guessEditor('code --wait "budget file.txt"')).toEqual(['code', '--wait', 'budget file.txt']);
    const args = ['editor', 'budget file.txt', 'literal;marker'];
    expect(shellQuote.parse(shellQuote.quote(args))).toEqual(args);
    expect(shellQuote.quote(['editor', { comment: 'note' }, 'file'])).toContain('#note');
  });
});
