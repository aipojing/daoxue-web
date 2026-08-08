import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiGet, apiDelete, ApiError } from '../api';
import type { Student } from '../types';
import StudentFormModal from '../components/StudentFormModal';
import StudentWizard from '../components/StudentWizard';

export default function StudentsPage() {
  const [students, setStudents] = useState<Student[] | null>(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<{ open: boolean; student: Student | null }>({
    open: false,
    student: null,
  });
  const [wizardOpen, setWizardOpen] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      setStudents(await apiGet<Student[]>('/api/students'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onDelete = async (student: Student) => {
    const typed = window.prompt(
      `删除「${student.name}」会同时删除该学生的全部会话、错题本和学习画像，且无法恢复。\n如果确认，请输入学生姓名：`,
    );
    if (typed === null) return;
    if (typed.trim() !== student.name) {
      setError('姓名不匹配，已取消删除');
      return;
    }
    try {
      await apiDelete(`/api/students/${student.id}`);
      setError('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '删除失败，请重试');
    }
  };

  if (!students) {
    if (error) {
      return (
        <div className="page">
          <div className="form-error">{error}</div>
          <button className="btn btn-primary" onClick={() => void load()}>
            重新加载
          </button>
        </div>
      );
    }
    return (
      <div className="page-loading">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>我的学生</h1>
        <button className="btn btn-primary" onClick={() => setWizardOpen(true)}>
          ＋ 添加学生
        </button>
      </div>

      {error && <div className="form-error">{error}</div>}

      {students.length === 0 && (
        <div className="empty-state">
          <p>还没有学生档案。</p>
          <p>点击「添加学生」为孩子创建档案，即可开始 AI 辅导。</p>
        </div>
      )}

      <div className="student-grid">
        {students.map((s) => (
          <div key={s.id} className="student-card">
            <Link to={`/students/${s.id}`} className="student-card-main">
              <span className="avatar" style={{ background: s.color }}>
                {s.name.slice(0, 1)}
              </span>
              <span className="student-card-info">
                <span className="student-card-name">{s.name}</span>
                <span className="student-card-meta">
                  {s.grade}
                  {s.textbook ? ` · ${s.textbook}` : ''}
                </span>
                <span className="student-card-stats">
                  {s.conversation_count ?? 0} 次会话 · {s.pending_mistake_count ?? 0} 道待复测错题
                </span>
              </span>
            </Link>
            <div className="student-card-actions">
              <button className="btn btn-sm" onClick={() => setModal({ open: true, student: s })}>
                编辑
              </button>
              <button className="btn btn-sm btn-danger-ghost" onClick={() => void onDelete(s)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      {modal.open && (
        <StudentFormModal
          student={modal.student}
          onClose={() => setModal({ open: false, student: null })}
          onSaved={() => {
            setModal({ open: false, student: null });
            void load();
          }}
        />
      )}

      {wizardOpen && (
        <StudentWizard
          mode="create"
          onClose={() => setWizardOpen(false)}
          onDone={(student) => {
            setWizardOpen(false);
            // 建完直接进学生主页选模式，避免家长填完表单不知道下一步
            if (student) navigate(`/students/${student.id}`);
            else void load();
          }}
        />
      )}
    </div>
  );
}
