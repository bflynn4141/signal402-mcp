import { defineConfig } from 'tsup';
import { readFileSync, writeFileSync } from 'fs';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  dts: false,
  onSuccess: async () => {
    // Add shebang to executable entry points
    for (const file of ['dist/cli.js', 'dist/index.js']) {
      const content = readFileSync(file, 'utf-8');
      if (!content.startsWith('#!')) {
        writeFileSync(file, `#!/usr/bin/env node\n${content}`);
      }
    }
  },
});
