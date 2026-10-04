import js from '@eslint/js';
import parser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/dist/**', '**/target/**', '**/node_modules/**', '**/.*',
      '**/*.{js,mjs,cjs}', 'coverage/**', 'crates/node-binding/index.d.ts',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.es2022,
        defineAppConfig: 'readonly',
        defineNuxtConfig: 'readonly',
        KeyboardEvent: 'readonly',
        RequestInit: 'readonly',
        $fetch: 'readonly',
        computed: 'readonly',
        defineNitroPlugin: 'readonly',
        afterEach: 'readonly',
        defineEventHandler: 'readonly',
        useRuntimeConfig: 'readonly',
        getHeader: 'readonly',
        setResponseStatus: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': 'off',
      'no-redeclare': 'off',
      // Preserve the existing lint policy; this is a toolchain migration.
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },
];
