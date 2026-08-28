import { Link, useOutletContext } from 'react-router-dom';
import StudentFormModal from '../components/StudentFormModal';
import { IconLamp, IconNotebook, IconTarget } from '../components/icons';
import type { StudentWorkspaceContext } from '../components/StudentWorkspaceLayout';
import StudentAvatar from '../components/StudentAvatar';
import { useState } from 'react';

export default function StudentDetailPage() {
  const { student, reloadStudent } = useOutletContext<StudentWorkspaceContext>();
  const [editOpen, setEditOpen] = useState(false);
  return (
    <div className="page">
      <div className="page-header">
        <div className="student-header">
          <StudentAvatar name={student.name} color={student.color} gender={student.gender} className="avatar-lg" />
          <div><h1>今日学习</h1><p className="text-secondary">{student.name} · {student.grade}{student.textbook ? ` · ${student.textbook}` : ''}</p></div>
        </div>
        <div className="header-actions"><button className="btn" onClick={() => setEditOpen(true)}>编辑资料</button><Link to={`/students/${student.id}/mistakes`} className="btn"><IconNotebook size={16} />错题本</Link></div>
      </div>
      <p className="text-secondary mode-intro">选择今天的学习方式，也可以在左侧工作台查看掌握记录和学习档案。</p>
      <div className="mode-grid">
        <Link to={`/students/${student.id}/selflearn`} className="mode-card mode-card-selflearn">
          <div className="mode-card-head"><span className="mode-card-icon"><IconTarget size={26} /></span><span className="mode-card-title">正式测验与自学</span><span className="mode-card-tag">有计划地学新内容</span></div>
          <p className="mode-card-desc">根据孩子画像安排学习，完成后记录知识掌握、每课输出和家长反馈。</p>
          <span className="mode-card-fit">适合：每天固定时间的系统自学、预习补弱和专项提升</span>
        </Link>
        <Link to={`/students/${student.id}/tutoring`} className="mode-card mode-card-tutoring">
          <div className="mode-card-head"><span className="mode-card-icon"><IconLamp size={26} /></span><span className="mode-card-title">AI 辅导</span><span className="mode-card-tag">遇到具体题目时用</span></div>
          <p className="mode-card-desc">把作业或练习里的题目发给 AI，它会分步引导孩子自己解出来。</p>
          <span className="mode-card-fit">适合：写作业卡壳、订正错题和考前针对性练习</span>
        </Link>
      </div>
      {editOpen && <StudentFormModal student={student} onClose={() => setEditOpen(false)} onSaved={() => { setEditOpen(false); void reloadStudent(); }} />}
    </div>
  );
}
