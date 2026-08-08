import { memo, useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

// DeepSeek 常输出 \( \) / \[ \] 定界的公式，remark-math 只识别 $ / $$，先行转换
function normalizeMathDelimiters(text: string): string {
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, expr: string) => `$$${expr}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, expr: string) => `$${expr}$`);
}

function PreWithCopy(props: ComponentPropsWithoutRef<'pre'>) {
  const preRef = useRef<HTMLPreElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const onCopy = async () => {
    const text = preRef.current?.innerText ?? '';
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  };

  return (
    <div className="code-block-wrap">
      <button type="button" className="code-copy-btn" onClick={() => void onCopy()}>
        {copied ? '已复制 ✓' : '复制'}
      </button>
      <pre ref={preRef} {...props} />
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkGfm]}
        rehypePlugins={[rehypeKatex]}
        components={{ pre: PreWithCopy }}
      >
        {normalizeMathDelimiters(content)}
      </ReactMarkdown>
    </div>
  );
}

export default memo(MarkdownContent);
