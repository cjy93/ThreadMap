import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: ['.next/**', 'dist/**', 'node_modules/**', 'fixtures/**', 'src/db/migrations/**', 'next-env.d.ts', 'reports/**', 'playwright-report/**', 'test-results/**'] },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@next/next/no-html-link-for-pages': 'off',
      // Fetch-on-change effects are intentional here; React Compiler hints stay visible as warnings.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
];

export default config;
