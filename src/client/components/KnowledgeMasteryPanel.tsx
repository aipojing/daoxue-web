import { useMemo } from 'react';
import { LEVEL_COLORS, type KnowledgePoint } from '../types';

function KnowledgePointFlags({ knowledgePoint }: { knowledgePoint: KnowledgePoint }) {
  const flags: string[] = [];
  if (knowledgePoint.needs_warmup) flags.push('待保温');
  if (knowledgePoint.needs_retest) flags.push('待复测');
  if (knowledgePoint.needs_rebuild) flags.push('需重构');
  if (knowledgePoint.can_network) flags.push('可组网');
  if (flags.length === 0) return null;
  return (
    <span className="kp-flags">
      {flags.map((flag) => <span key={flag} className="badge">{flag}</span>)}
    </span>
  );
}

export default function KnowledgeMasteryPanel({ knowledgePoints }: { knowledgePoints: KnowledgePoint[] }) {
  const knowledgeByDirection = useMemo(() => {
    const groups = new Map<string, KnowledgePoint[]>();
    for (const knowledgePoint of knowledgePoints) {
      const direction = knowledgePoint.direction || '未分类';
      groups.set(direction, [...(groups.get(direction) ?? []), knowledgePoint]);
    }
    return Array.from(groups.entries());
  }, [knowledgePoints]);

  const levelDescriptions: Array<[keyof typeof LEVEL_COLORS, string]> = [
    ['L1', '听过，还讲不出'],
    ['L2', '带着能做，独立易错'],
    ['L3', '能独立做并说清思路'],
    ['L4', '能迁移、能讲给别人'],
  ];

  return (
    <section aria-labelledby="knowledge-mastery-title">
      <h2 id="knowledge-mastery-title" className="section-title">知识点掌握记录</h2>
      <div className="level-legend" aria-label="掌握等级说明">
        {levelDescriptions.map(([level, description]) => (
          <span key={level} className="level-legend-item">
            <span className="level-chip" style={{ background: LEVEL_COLORS[level] ?? '#6b7280' }}>{level}</span>
            {description}
          </span>
        ))}
      </div>
      {knowledgeByDirection.length === 0 ? (
        <p className="text-secondary">暂无记录。开始学习后，AI 会自动记录每个知识点的 L1-L4 掌握等级。</p>
      ) : knowledgeByDirection.map(([direction, points]) => (
        <div key={direction} className="card kp-group">
          <h3 className="kp-direction">{direction}</h3>
          {points.map((knowledgePoint) => (
            <div key={knowledgePoint.id} className="kp-row">
              <span className="level-chip" style={{ background: LEVEL_COLORS[knowledgePoint.level] ?? '#6b7280' }}>
                {knowledgePoint.level}
              </span>
              <span className="kp-name">
                {knowledgePoint.name}
                {knowledgePoint.chain && <span className="kp-chain">（{knowledgePoint.chain}）</span>}
              </span>
              <KnowledgePointFlags knowledgePoint={knowledgePoint} />
              {knowledgePoint.evidence && <span className="kp-evidence">判定依据：{knowledgePoint.evidence}</span>}
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
