import { describe, it, expect } from 'vitest';
import { parseMistakeCard } from '../src/worker/mistakes/extract';

const validCard = {
  title: '分式加法',
  knowledge_point: '异分母分式相加',
  my_answer: '2/5',
  key_error: '直接分子分母相加',
  error_tags: ['数量关系建立错误'],
  correct_steps: '先通分再相加',
  reminder: '异分母先通分',
  retest_question: '计算 1/4 + 1/6',
};

describe('parseMistakeCard', () => {
  it('解析合法 JSON', () => {
    const r = parseMistakeCard(JSON.stringify(validCard));
    expect('card' in r && r.card.title).toBe('分式加法');
  });

  it('容忍 markdown 代码围栏', () => {
    const r = parseMistakeCard('```json\n' + JSON.stringify(validCard) + '\n```');
    expect('card' in r).toBe(true);
  });

  it('容忍代码围栏后的说明文字', () => {
    const r = parseMistakeCard('```json\n' + JSON.stringify(validCard) + '\n```\n以上是整理结果。');
    expect('card' in r).toBe(true);
  });

  it('no_mistake 返回 noMistake', () => {
    const r = parseMistakeCard('{"no_mistake": true}');
    expect('noMistake' in r).toBe(true);
  });

  it('缺 title 返回 error', () => {
    const { title: _title, ...rest } = validCard;
    const r = parseMistakeCard(JSON.stringify(rest));
    expect('error' in r).toBe(true);
  });

  it('error_tags 非数组返回 error', () => {
    const r = parseMistakeCard(JSON.stringify({ ...validCard, error_tags: '粗心' }));
    expect('error' in r).toBe(true);
  });

  it('完全损坏的输入返回 error', () => {
    expect('error' in parseMistakeCard('not json at all')).toBe(true);
  });
});
