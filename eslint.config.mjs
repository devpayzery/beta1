import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // supabase/verify-migrations.mjs and contracts/compile-check.mjs are Node scripts that run
  // with pnpm verify:migrations, pnpm compile:contracts and are not part of the Next bundle, so they
  // need Node globals. Without this entry, no-undef complains about console and process in files
  // that work fine.
  { files: ['supabase/**/*.mjs', 'contracts/**/*.mjs'], languageOptions: { globals: { console: 'readonly', process: 'readonly' } } },
  { ignores: ['.next/**', 'node_modules/**', 'public/**', '.agents/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
)