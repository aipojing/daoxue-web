import { useState, type FormEvent } from 'react';
import { apiPost, apiPut, ApiError } from '../api';
import { GRADES, PROVINCES, splitRegion, joinRegion, type Student } from '../types';

const COLOR_OPTIONS = ['#1e5b4a', '#b8432f', '#33648f', '#b0782a', '#635c9b', '#3a7d5c'];

interface Props {
  student: Student | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function StudentFormModal({ student, onClose, onSaved }: Props) {
  const [name, setName] = useState(student?.name ?? '');
  const [grade, setGrade] = useState(student?.grade ?? '初一');
  const [textbook, setTextbook] = useState(student?.textbook ?? '');
  const initialRegion = splitRegion(student?.region ?? '');
  const [province, setProvince] = useState(initialRegion.province);
  const [city, setCity] = useState(initialRegion.city);
  const [color, setColor] = useState(student?.color ?? COLOR_OPTIONS[0]!);
  const [notes, setNotes] = useState(student?.notes ?? '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    const body = { name, grade, textbook, region: joinRegion(province, city), color, notes };
    try {
      if (student) {
        await apiPut(`/api/students/${student.id}`, body);
      } else {
        await apiPost('/api/students', body);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败，请重试');
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={onSubmit}>
        <h2 className="modal-title">{student ? '编辑学生' : '添加学生'}</h2>
        {error && <div className="form-error">{error}</div>}
        <label className="form-label">
          姓名 *
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="孩子的名字" required maxLength={20} />
        </label>
        <label className="form-label">
          年级 *
          <select value={grade} onChange={(e) => setGrade(e.target.value)}>
            {GRADES.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
        <label className="form-label">
          教材版本
          <input value={textbook} onChange={(e) => setTextbook(e.target.value)} placeholder="如：人教版" maxLength={30} />
        </label>
        <div className="form-row">
          <label className="form-label">
            所在省份
            <select value={province} onChange={(e) => setProvince(e.target.value)}>
              <option value="">不填</option>
              {PROVINCES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="form-label">
            城市
            <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="如：杭州" maxLength={20} />
          </label>
        </div>
        <div className="form-label">
          头像颜色
          <div className="color-options">
            {COLOR_OPTIONS.map((cOpt) => (
              <button
                key={cOpt}
                type="button"
                className={cOpt === color ? 'color-dot selected' : 'color-dot'}
                style={{ background: cOpt }}
                onClick={() => setColor(cOpt)}
                aria-label={`颜色 ${cOpt}`}
              />
            ))}
          </div>
        </div>
        <label className="form-label">
          备注（AI 会参考）
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="如：计算基础较弱，需要更耐心的讲解"
            rows={3}
            maxLength={500}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}
