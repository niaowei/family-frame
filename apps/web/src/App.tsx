import { Link, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { createContext, useContext, useEffect, useState } from 'react';
import { APP_NAME } from '@family-frame/shared';
import type { MemberProfile } from '@family-frame/shared';
import { api } from './lib/api';
import FramePage from './frame/FramePage';
import LoginPage from './pages/LoginPage';
import SendPage from './pages/SendPage';
import HistoryPage from './pages/HistoryPage';
import FamilyPage from './pages/FamilyPage';
import { familyEntryPath, rememberFamily } from './lib/familyEntry';

export interface MeState {
  member: MemberProfile | null;
  loading: boolean;
  setMember: (member: MemberProfile | null) => void;
}

const MeContext = createContext<MeState | null>(null);

export function useMe(): MeState {
  const state = useContext(MeContext);
  if (!state) throw new Error('家人页面需要登录上下文');
  return state;
}

export function useRequireLogin(member: MemberProfile | null, loading: boolean): boolean {
  const navigate = useNavigate();
  useEffect(() => {
    if (!loading && !member) {
      navigate(familyEntryPath(), { replace: true });
    }
  }, [loading, member, navigate]);
  return !!member && !loading;
}

function Header({ member }: { member: MemberProfile | null }) {
  const navigate = useNavigate();
  const { setMember } = useMe();
  const [error, setError] = useState('');
  const logout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
      setMember(null);
      navigate(familyEntryPath(), { replace: true });
    } catch { setError('退出失败，请检查网络后重试'); }
  };
  return (
    <header className="app-header">
      <span className="app-title">{APP_NAME}</span>
      {member && (
        <nav className="app-nav">
          <Link to="/send">发送</Link>
          <Link to="/history">历史</Link>
          <Link to="/family">家庭</Link>
          <button type="button" className="link-button" onClick={logout}>
            退出（{member.displayName}）
          </button>
        </nav>
      )}
      {error && <span role="alert">{error}</span>}
    </header>
  );
}

/** 家人端布局（带导航与登录检查）；/frame 相框端完全独立，无导航无登录 */
function MemberLayout() {
  const [member, setMember] = useState<MemberProfile | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const expired = () => setMember(null);
    window.addEventListener('ff-session-expired', expired);
    api<{ member: MemberProfile; familyCode: string }>('/api/auth/me')
      .then((res) => { if (!cancelled) { rememberFamily(res.familyCode); setMember(res.member); } })
      .catch(() => { if (!cancelled) setMember(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; window.removeEventListener('ff-session-expired', expired); };
  }, []);

  return (
    <MeContext.Provider value={{ member, loading, setMember }}><div className="app-shell">
      <Header member={member} />
      {loading ? <main className="page"><p className="muted">正在加载…</p></main> : <Outlet />}
    </div></MeContext.Provider>
  );
}

export default function App() {
  return (
    <Routes>
      {/* 相框端：全屏独立界面，不使用家人端导航/登录 */}
      <Route path="/frame" element={<FramePage />} />
      <Route element={<MemberLayout />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/family/:code" element={<LoginPage />} />
        <Route path="/join/:token" element={<LoginPage />} />
        <Route path="/family" element={<FamilyPage />} />
        <Route path="/send" element={<SendPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="*" element={<Navigate to="/send" replace />} />
      </Route>
    </Routes>
  );
}
