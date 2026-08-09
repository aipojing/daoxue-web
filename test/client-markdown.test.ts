import { describe, expect, it } from 'vitest';
import { normalizeMathDelimiters } from '../src/client/lib/markdown';

describe('MarkdownContent', () => {
  it('不把代码块中的 LaTeX 定界字面量改写为公式', () => {
    const source = ['```js', 'const pattern = /\\(abc\\)/;', '```'].join('\n');

    const normalized = normalizeMathDelimiters(source);

    expect(normalized).toContain('const pattern = /\\(abc\\)/;');
    expect(normalized).not.toContain('const pattern = /$abc$/;');
  });
});
