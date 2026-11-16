// Re-export the root ESLint config for standalone use by turbo/eslint.
import rules from '../../eslint.config.mjs';

export default [
  ...rules,
  {
    ignores: [
      '**/dist/**/*',
      '**/build/**/*',
      'eslint.config.mjs',
      '**/.release-it.js',
      '**/*.d.ts',
      '**/tsup.config.ts',
    ],
  },
];
