import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  // **/.venv/ is warehouse/.venv, the dbt virtualenv scripts/venv.sh builds.
  // urllib3 vendors a JavaScript web worker inside it, so without this line
  // `npm run lint` reports errors from a dependency's dependency the moment
  // anyone runs the warehouse demo.
  { ignores: ['dist/', 'coverage/', '.agent-work/**', '**/.venv/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    // Operator tooling that runs inside the n8n container, where the package is
    // ESM but n8n's own modules are not — hence .cjs and CommonJS globals.
    files: ['**/*.cjs'],
    languageOptions: {
      globals: globals.node,
      sourceType: 'commonjs'
    },
    rules: {
      // require() is the point: these load n8n's own CommonJS internals by path.
      '@typescript-eslint/no-require-imports': 'off'
    }
  }
);
