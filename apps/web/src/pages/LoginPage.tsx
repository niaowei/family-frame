import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { MemberProfile } from '@family-frame/shared';
import { useMe } from '../App';
import { familyEntryPath, rememberFamily } from '../lib/familyEntry';

interface Entry { id?: string; name: string; code: string; members?: { id: string; displayName: string }[] }

export default function LoginPage() {
  const navigate = useNavigate();
  const { code, token } = useParams();
  const { member, setMember } = useMe();
  const [family, setFamily] = useState<Entry | null>(null);
  const [familyCode, setFamilyCode] = useState('');
  const [memberId, setMemberId] = useState('');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFamily(null); setMemberId(''); setPin(''); setConfirmPin(''); setError('');
    if (code || token) {
      setBusy(true);
      api<Entry>(token ? `/api/auth/invitation/${encodeURIComponent(token)}` : `/api/auth/family/${encodeURIComponent(code!)}`)
        .then((res) => { if (!cancelled) { setFamily(res); if (!token) rememberFamily(res.code); } })
        .catch((err: Error) => { if (!cancelled) setError(err.message); })
        .finally(() => { if (!cancelled) setBusy(false); });
    } else if (!member) {
      const saved = familyEntryPath();
      if (saved !== '/login') navigate(saved, { replace: true });
    }
    return () => { cancelled = true; };
  }, [code, token, navigate, member]);

  useEffect(() => {
    if (member && !token && (!code || family?.id === member.familyId)) navigate('/send', { replace: true });
  }, [member, token, code, family, navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    if (!family) { if (familyCode.trim()) navigate(familyEntryPath(familyCode.trim())); return; }
    if (token && pin !== confirmPin) { setError('两次 PIN 不一致，请重新输入'); return; }
    setBusy(true);
    try {
      const result = await api<{ member: MemberProfile; familyCode: string }>(token ? '/api/auth/join' : '/api/auth/login', {
        method: 'POST', body: JSON.stringify(token ? { token, displayName: name, pin } : { familyCode: family.code, memberId, pin }),
      });
      rememberFamily(result.familyCode); setMember(result.member); navigate('/send', { replace: true });
    } catch (err) { setError(err instanceof Error ? err.message : '暂时无法登录，请重试'); }
    finally { setBusy(false); }
  };

  return <main className="page page-narrow">
    <p className="page-eyebrow">我们的家庭相册</p>
    <h1>{token ? '加入家庭' : '欢迎回来'}</h1>
    <p className="page-subtitle">换了手机也没关系，还是原来的家。</p>
    {family && <p>{family.name}</p>}
    {member ? <p>当前已登录为 {member.displayName}。如需使用其他身份，请先退出；<Link to="/send">继续发送照片</Link>。</p> :
      <form className="form" onSubmit={submit}>
        {!code && !token && <><p className="muted">打开家人分享的家庭入口链接即可选择名字。已有旧邀请码也可以在这里打开家庭入口。</p>
          <label>家庭入口码<input value={familyCode} onChange={(e) => setFamilyCode(e.target.value)} autoComplete="off" required maxLength={64} /></label></>}
        {family && <>
          {token ? <label>你的名字<input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required autoComplete="nickname" /></label> :
            <label>选择自己的名字<select value={memberId} onChange={(e) => setMemberId(e.target.value)} required>
              <option value="">请选择</option>{family.members?.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </select></label>}
          <label>{token ? '设置 PIN（6 至 20 位数字）' : '你的 PIN'}<input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} required minLength={token ? 6 : 4} maxLength={20} pattern={token ? '[0-9]{6,20}' : undefined} autoComplete={token ? 'new-password' : 'current-password'} /></label>
          {token && <label>再次输入 PIN<input type="password" inputMode="numeric" value={confirmPin} onChange={(e) => setConfirmPin(e.target.value)} required autoComplete="new-password" /></label>}
          <p className="muted">{token ? '加入后会记住登录。换手机时，从家庭入口选择名字、输入 PIN 即可恢复。' : '登录后会记住这台手机。忘记 PIN，请联系家庭管理员重置，无需重新绑定相框。'}</p>
          {token && <Link to={familyEntryPath(family.code)}>已经加入过？从家庭入口登录</Link>}
        </>}
        <button className="primary-button" disabled={busy || (!!(code || token) && !family)}>{busy ? '请稍候…' : !family ? '打开家庭入口' : token ? '加入并开始发送' : '登录并开始发送'}</button>
      </form>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </main>;
}
