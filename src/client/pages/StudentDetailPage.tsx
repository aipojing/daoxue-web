import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiGet, ApiError } from '../api';
import type { Student } from '../types';
import StudentFormModal from '../components/StudentFormModal';
import { IconTarget, IconLamp, IconNotebook } from '../components/icons';

export default function StudentDetailPage() {
  const { studentId } = useParams();
  const [student, setStudent] = useState<Student | null>(null);
  const [error, setError] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const loadGenRef = useRef(0);

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current;
    try {
      const found = await apiGet<Student>(`/api/students/${studentId}`);
      if (gen !== loadGenRef.current) return;
      setStudent(found);
      setError('');
    } catch (e) {
      if (gen !== loadGenRef.current) return;
      setError(e instanceof ApiError ? e.message : '加载失败');
    }
  }, [studentId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!student) {
    if (error) {
      return (
        <div className="page">
          <div className="form-error">{error}</div>
          <div className="selflearn-actions">
            <button className="btn btn-primary" onClick={() => void load()}>
              重新加载
            </button>
            <Link to="/" className="btn">
              返回学生列表
            </Link>
          </div>
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
        <div className="student-header">
          <span className="avatar avatar-lg" style={{ background: student.color }}>
            {student.name.slice(0, 1)}
          </span>
          <div>
            <h1>{student.name}</h1>
            <p className="text-secondary">
              {student.grade}
              {student.textbook ? ` · ${student.textbook}` : ''}
              {student.region ? ` · ${student.region}` : ''}
            </p>
          </div>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={() => setEditOpen(true)}>
            编辑资料
          </button>
          <Link to={`/students/${student.id}/mistakes`} className="btn">
            <IconNotebook size={16} />
            错题本
          </Link>
        </div>
      </div>

      <p className="text-secondary mode-intro">今天想怎么学？两种模式按场景选择：</p>

      <div className="mode-grid">
        <Link to={`/students/${student.id}/selflearn`} className="mode-card mode-card-selflearn">
          <div className="mode-card-head">
            <span className="mode-card-icon">
              <IconTarget size={26} />
            </span>
            <span className="mode-card-title">自学陪伴</span>
            <span className="mode-card-tag">有计划地学新内容</span>
          </div>
          <p className="mode-card-desc">
            AI 根据孩子画像安排每天的学习：旧知识保温 → 拆解今日知识点 → 生成课件去上课 →
            回来测验判定 L1-L4 掌握等级 → 错题复测 → 每日家长反馈。长期跟踪，越用越懂孩子。
          </p>
          <span className="mode-card-fit">适合：每天固定时间的系统自学、预习补弱、专项提升（含编程等任意方向）</span>
        </Link>

        <Link to={`/students/${student.id}/tutoring`} className="mode-card mode-card-tutoring">
          <div className="mode-card-head">
            <span className="mode-card-icon">
              <IconLamp size={26} />
            </span>
            <span className="mode-card-title">解题辅导</span>
            <span className="mode-card-tag">遇到具体题目时用</span>
          </div>
          <p className="mode-card-desc">
            把作业或练习里的题目发给 AI（数学 / 语文 / 物理 / 英语），它不直接报答案，
            而是分步引导孩子自己解出来；支持批改复盘、错因诊断、一键存入错题本。
          </p>
          <span className="mode-card-fit">适合：写作业卡壳、订正错题、考前针对性练习</span>
        </Link>
      </div>

      {editOpen && (
        <StudentFormModal
          student={student}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
