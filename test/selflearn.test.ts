import { describe, it, expect } from 'vitest';
import { detectSelfLearnBlocks, parseSelfLearnExtraction } from '../src/worker/selflearn/blocks';
import { buildSelfLearnMemory } from '../src/worker/selflearn/prompt-builder';

describe('detectSelfLearnBlocks', () => {
  it('识别并切出每课输出块（含系统判断与调度指令）', () => {
    const text = [
      '好的，我们来总结。',
      '【每课输出】',
      '一、今日内容：分数加法',
      '【系统判断】',
      '- 是否允许继续推进：否',
      '【给下一次学习的调度指令】',
      '- 下一次优先做什么：复测',
    ].join('\n');
    const r = detectSelfLearnBlocks(text);
    expect(r.lessonOutput).toContain('分数加法');
    expect(r.lessonOutput).toContain('调度指令');
    expect(r.dailyReport).toBeUndefined();
  });

  it('识别每日家长反馈块，且不吞掉后续每课输出', () => {
    const text = [
      '【每课输出】',
      '一、今日内容：循环语句',
      '【每日家长反馈】',
      '一、今日学习内容：Python 循环',
      '【给家长的一句话总结】',
      '今天孩子理解了 for 循环。',
    ].join('\n');
    const r = detectSelfLearnBlocks(text);
    expect(r.lessonOutput).toContain('循环语句');
    expect(r.lessonOutput).not.toContain('家长反馈');
    expect(r.dailyReport).toContain('Python 循环');
    expect(r.dailyReport).toContain('一句话总结');
  });

  it('识别多张错题卡', () => {
    const text = [
      '【错题卡】',
      '- 方向 / 知识点：数学 / 分数加法',
      '【错题卡】',
      '- 方向 / 知识点：数学 / 通分',
    ].join('\n');
    const r = detectSelfLearnBlocks(text);
    expect(r.mistakeCards).toHaveLength(2);
  });

  it('识别画像摘要（含启动建议）', () => {
    const text = '前言\n【孩子学习画像摘要】\n一、基础信息\n【第一版学习启动建议】\n- 建议先学：分数';
    const r = detectSelfLearnBlocks(text);
    expect(r.profileSummary).toContain('基础信息');
    expect(r.profileSummary).toContain('建议先学');
  });

  it('识别画像草稿', () => {
    const r = detectSelfLearnBlocks('【孩子学习画像草稿 v2】\n- 年级年龄：初一 13 岁');
    expect(r.profileDraft).toContain('初一');
    expect(r.profileSummary).toBeUndefined();
  });

  it('普通消息全部为空', () => {
    const r = detectSelfLearnBlocks('我们先做一道保温题：1/2 + 1/4 = ?');
    expect(r.lessonOutput).toBeUndefined();
    expect(r.dailyReport).toBeUndefined();
    expect(r.mistakeCards).toBeUndefined();
    expect(r.profileSummary).toBeUndefined();
  });
});

describe('parseSelfLearnExtraction', () => {
  it('解析合法抽取结果', () => {
    const raw = JSON.stringify({
      direction: '数学',
      nextInstruction: '先复测通分',
      knowledgePoints: [
        { direction: '数学', chain: '分数运算', name: '异分母加法', level: 'L2', evidence: '需要提示', needsRetest: true },
      ],
      mistakeCards: [
        { title: '1/2+1/3 算错', knowledgePoint: '异分母加法', myAnswer: '2/5', keyError: '直接相加', errorTags: ['步骤断裂'], correctSteps: '先通分', reminder: '先通分', retestQuestion: '1/4+1/6' },
      ],
    });
    const r = parseSelfLearnExtraction(raw);
    expect(r).not.toBeNull();
    expect(r!.knowledgePoints[0]!.level).toBe('L2');
    expect(r!.mistakeCards).toHaveLength(1);
  });

  it('非法 level 的知识点被丢弃而不是整体失败', () => {
    const raw = JSON.stringify({
      knowledgePoints: [
        { direction: '数学', name: '通分', level: 'L9' },
        { direction: '数学', name: '约分', level: 'L3' },
      ],
    });
    const r = parseSelfLearnExtraction(raw);
    expect(r!.knowledgePoints).toHaveLength(1);
    expect(r!.knowledgePoints[0]!.name).toBe('约分');
  });

  it('损坏 JSON 返回 null', () => {
    expect(parseSelfLearnExtraction('not json')).toBeNull();
  });
});

describe('buildSelfLearnMemory', () => {
  it('注入画像、知识点与调度指令', () => {
    const memory = buildSelfLearnMemory({
      profileText: '初一，数学补弱',
      knowledgePoints: [
        { direction: '数学', chain: '分数运算', name: '通分', level: 'L2', needs_retest: 1, needs_warmup: 0, needs_rebuild: 0, can_network: 0 },
      ],
      recentInstructions: ['下一次优先做什么：复测通分'],
      lastDailyReport: '今天完成分数加法学习',
      pendingMistakes: [{ title: '1/2+1/3 算错', next_review_date: '2026-08-05' }],
    });
    expect(memory).toContain('初一，数学补弱');
    expect(memory).toContain('通分');
    expect(memory).toContain('L2');
    expect(memory).toContain('待复测');
    expect(memory).toContain('复测通分');
  });

  it('无记忆时输出首次说明', () => {
    const memory = buildSelfLearnMemory({
      profileText: null,
      knowledgePoints: [],
      recentInstructions: [],
      lastDailyReport: null,
      pendingMistakes: [],
    });
    expect(memory).toContain('暂无');
  });
});
