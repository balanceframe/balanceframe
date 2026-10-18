import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const coreRequire = createRequire(require.resolve('@actual-app/core/server/rules/action'));
type ParsedTemplate = { body: { program: { blockParams: unknown } }[] };
type CompiledTemplate = ((
  context: Record<string, unknown>,
  options?: { allowProtoMethodsByDefault: boolean },
) => string) & {
  _setup(options: Record<string, unknown>): void;
};
const Handlebars = coreRequire('handlebars') as {
  parse(template: string): ParsedTemplate;
  compile(template: unknown): CompiledTemplate;
  precompile(template: unknown): string;
};

// GHSA-8r5x-fm3f-whwj: inspect code generation without rendering the untrusted AST.
function untrustedAst() {
  const ast = Handlebars.parse('{{#missingHelper}}{{/missingHelper}}');
  ast.body[0].program.blockParams = { length: 'UNTRUSTED_AST_MARKER' };
  return ast;
}

describe('Actual core standalone Handlebars compiler', () => {
  it('rejects a type-confused blockParams length during precompilation', () => {
    expect(() => Handlebars.precompile(untrustedAst())).toThrow(/blockParams|AST/i);
  });

  it('rejects the same AST when lazy compilation is initialized without rendering', () => {
    expect(() => Handlebars.compile(untrustedAst())._setup({})).toThrow(/blockParams|AST/i);
  });

  it('keeps a prototype constructor hidden even when prototype methods are enabled', () => {
    // GHSA-p8wg-vrv2-v86f: only look up/stringify the result; never invoke the constructor.
    const template = Handlebars.compile('{{lookup (lookup fn "__proto__") "constructor"}}');
    expect(template({ fn() {} }, { allowProtoMethodsByDefault: true })).toBe('');
  });

  it('preserves ordinary rule templates and trusted parsed templates', () => {
    expect(Handlebars.compile('Payment to {{payee}}')({ payee: 'Local shop' })).toBe('Payment to Local shop');
    expect(Handlebars.compile(Handlebars.parse('{{#if paid}}Paid{{else}}Due{{/if}}'))({ paid: true })).toBe('Paid');
    expect(Handlebars.precompile('Payment to {{payee}}')).toContain('payee');
  });
});
