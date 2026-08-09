import { useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api';
import { matchesStudentName, useDialogFocus } from '../lib/modal';
import type { Student } from '../types';

interface Props {
  student: Student;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export default function StudentDeleteModal({ student, onClose, onConfirm }: Props) {
  const [typedName, setTypedName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const requestClose = () => {
    if (!submittingRef.current) onClose();
  };
  const dialogRef = useDialogFocus<HTMLFormElement>(requestClose);
  const nameMatches = matchesStudentName(student.name, typedName);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!nameMatches || submittingRef.current) {
      if (!nameMatches) setError('姓名不匹配，无法删除');
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      await onConfirm();
    } catch (err) {
      submittingRef.current = false;
      setSubmitting(false);
      setError(err instanceof ApiError ? err.message : '删除失败，请重试');
    }
  };

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      <form
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="student-delete-title"
        aria-describedby="student-delete-description"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => void submit(event)}
      >
        <h2 id="student-delete-title" className="modal-title">删除学生</h2>
        <p id="student-delete-description">
          删除「{student.name}」会同时删除该学生的全部会话、错题本和学习画像，且无法恢复。
        </p>
        <label className="form-label">
          输入学生姓名以确认
          <input
            value={typedName}
            onChange={(event) => setTypedName(event.target.value)}
            autoComplete="off"
            disabled={submitting}
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={requestClose} disabled={submitting}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={!nameMatches || submitting}>
            {submitting ? '删除中…' : '确认删除'}
          </button>
        </div>
      </form>
    </div>
  );
}
