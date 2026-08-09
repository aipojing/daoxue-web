import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      name: 'raw-markdown',
      enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('.md')) return `export default ${JSON.stringify(code)};`;
      },
    },
  ],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
