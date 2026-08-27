import { useParams } from 'react-router-dom';
import KnowledgeMasteryPanel from '../components/KnowledgeMasteryPanel';
import { useSelfLearnOverview } from '../hooks/useSelfLearnOverview';

export default function StudentMasteryPage() {
  const { studentId } = useParams();
  const { overview, error, loading, load } = useSelfLearnOverview(studentId);
  if (loading && !overview) return <div className="page-loading"><div className="spinner" /></div>;
  if (!overview) return <div className="page"><div className="form-error">{error || '加载失败'}</div><button className="btn btn-primary" onClick={() => void load()}>重新加载</button></div>;
  return <div className="page"><div className="page-header"><h1>知识掌握</h1></div>{error && <div className="form-error">{error}</div>}<KnowledgeMasteryPanel knowledgePoints={overview.knowledgePoints} /></div>;
}
