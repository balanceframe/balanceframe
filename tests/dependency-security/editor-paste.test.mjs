import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(resolve(root, 'node_modules/.pnpm/node_modules/_security-test.cjs'));
const webRequire = createRequire(resolve(root, 'apps/web/package.json'));

test('ProseMirror validates clipboard context attributes before creating wrapper nodes', () => {
  const { Window } = webRequire('happy-dom');
  const window = new Window();
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  for (const key of ['window', 'document', 'navigator', 'CSSStyleRule']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: window[key] ?? window });
  }
  try {
    const { Schema } = require('prosemirror-model');
    const { EditorState } = require('prosemirror-state');
    const { __parseFromClipboard } = require('prosemirror-view');
    const schema = new Schema({ nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'text*', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
      quote: { group: 'block', content: 'block+', attrs: { kind: { default: 'normal', validate: 'string' } }, toDOM: node => ['blockquote', { 'data-kind': node.attrs.kind }, 0] },
      text: {},
    } });
    const state = EditorState.create({ schema });
    const view = { state, someProp: () => undefined };
    const paste = kind => __parseFromClipboard(view, '', `<p data-pm-slice='0 0 ${JSON.stringify(['quote', { kind }])}'>Budget</p>`, false, state.selection.$from);
    const malicious = paste({ onerror: 'MARKER' });
    assert.notEqual(malicious.content.firstChild.type.name, 'quote');
    assert.equal(malicious.content.textBetween(0, malicious.content.size), 'Budget');
    const ordinary = paste('budget');
    assert.equal(ordinary.content.firstChild.type.name, 'quote');
    assert.equal(ordinary.content.firstChild.attrs.kind, 'budget');
  } finally {
    for (const key of ['window', 'document', 'navigator', 'CSSStyleRule']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete globalThis[key];
    }
    window.happyDOM.abort();
  }
});
