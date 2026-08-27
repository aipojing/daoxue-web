import { useState } from 'react';
import { useParams } from 'react-router-dom';
import StudentWizard from '../components/StudentWizard';
import LearningArchivePanel from '../components/LearningArchivePanel';
import { EMPTY_PROFILE_FORM } from '../types';
import { parseSelfLearnProfileForm, useSelfLearnOverview } from '../hooks/useSelfLearnOverview';

export default function StudentProfilePage() {
  const { studentId } = useParams();
  const { overview, error, loading, load } = useSelfLearnOverview(studentId);
  const [wizardOpen, setWizardOpen] = useState(false);
  if (loading && !overview) return <div className="page-loading"><div className="spinner" /></div>;
  if (!overview) return <div className="page"><div className="form-error">{error || '加载失败'}</div><button className="btn btn-primary" onClick={() => void load()}>重新加载</button></div>;
  return <div className="page"><div className="page-header"><h1>学习档案</h1></div>{error && <div className="form-error">{error}</div>}<LearningArchivePanel overview={overview} studentId={studentId ?? ''} onEditProfile={() => setWizardOpen(true)} />{wizardOpen && <StudentWizard mode="profile" studentId={Number(studentId)} initialForm={overview.profile ? parseSelfLearnProfileForm(overview.profile.form_json) : EMPTY_PROFILE_FORM} onClose={() => setWizardOpen(false)} onDone={() => { setWizardOpen(false); void load(); }} />}</div>;
}
