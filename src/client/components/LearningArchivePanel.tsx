import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { SelfLearnOverview } from '../types';
import MarkdownContent from './MarkdownContent';
import { formatDateTime, formatFullDateTime } from '../lib/datetime';

function ExpandableRecord({ title, meta, content }: { title: string; meta: string; content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card record-card">
      <button className="record-header" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="record-title">{title}</span>
        <span className="record-meta">{meta}</span>
        <span className="expand-arrow">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="record-content"><MarkdownContent content={content} /></div>}
    </div>
  );
}

interface LearningArchivePanelProps {
  overview: SelfLearnOverview;
  studentId: string;
  onEditProfile?: () => void;
}

export default function LearningArchivePanel({ overview, studentId, onEditProfile }: LearningArchivePanelProps) {
  const [profileOpen, setProfileOpen] = useState(false);
  const profileReady = !!overview.profile?.ready;

  return (
    <section aria-labelledby="learning-archive-title">
      <h2 id="learning-archive-title" className="section-title">学习档案</h2>
      {profileReady && overview.profile && (
        <div className="card">
          <button className="record-header" aria-expanded={profileOpen} onClick={() => setProfileOpen(!profileOpen)}>
            <span className="record-title">孩子学习画像</span>
            <span className="record-meta">更新于 {formatFullDateTime(overview.profile.updated_at)}</span>
            <span className="expand-arrow">{profileOpen ? '▲' : '▼'}</span>
          </button>
          {profileOpen && <pre className="profile-pre">{overview.profile.profile_text}</pre>}
          {onEditProfile && <div className="selflearn-actions"><button className="btn btn-sm" onClick={onEditProfile}>编辑画像表单</button></div>}
        </div>
      )}

      <h3 className="section-title">自学会话</h3>
      {overview.conversations.length === 0 ? <p className="text-secondary">还没有自学会话。</p> : (
        <div className="conversation-list card">
          {overview.conversations.map((conversation) => (
            <Link key={conversation.id} to={`/students/${studentId}/chat/${conversation.id}`} className="conversation-item">
              <span className="subject-chip" style={{ background: '#635c9b' }}>
                {conversation.mode === 'selflearn-profiling' ? '画像' : '学习'}
              </span>
              <span className="conversation-title">{conversation.title}</span>
              <span className="conversation-time">{formatDateTime(conversation.updated_at)}</span>
            </Link>
          ))}
        </div>
      )}

      <h3 className="section-title">每课输出</h3>
      {overview.lessonOutputs.length === 0 ? <p className="text-secondary">暂无每课输出。每完成一个学习单元，AI 会自动生成并存档。</p> : (
        <div className="record-list">
          {overview.lessonOutputs.map((output) => (
            <ExpandableRecord key={output.id} title={`${output.direction || '学习'} · ${formatFullDateTime(output.created_at)}`} meta={output.next_instruction ? `下一步：${output.next_instruction.slice(0, 30)}` : ''} content={output.content} />
          ))}
        </div>
      )}

      <h3 className="section-title">每日家长反馈</h3>
      {overview.dailyReports.length === 0 ? <p className="text-secondary">暂无每日反馈。每天学习结束时对 AI 说“今天结束”即可生成。</p> : (
        <div className="record-list">
          {overview.dailyReports.map((report) => <ExpandableRecord key={report.id} title={`家长反馈 · ${report.report_date}`} meta="" content={report.content} />)}
        </div>
      )}
    </section>
  );
}
