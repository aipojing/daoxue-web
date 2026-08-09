const CODE_SEGMENT_RE = /(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n(?:`{3,}|~{3,})[ \t]*(?=\n|$)|$)|`+[\s\S]*?`+/g;

function normalizeTextMathDelimiters(text: string): string {
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, expr: string) => `$$${expr}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, expr: string) => `$${expr}$`);
}

/** 仅转换 Markdown 正文中的 LaTeX 定界符，代码中的字面量原样保留。 */
export function normalizeMathDelimiters(text: string): string {
  let result = '';
  let cursor = 0;
  for (const match of text.matchAll(CODE_SEGMENT_RE)) {
    const index = match.index;
    result += normalizeTextMathDelimiters(text.slice(cursor, index));
    result += match[0];
    cursor = index + match[0].length;
  }
  return result + normalizeTextMathDelimiters(text.slice(cursor));
}
