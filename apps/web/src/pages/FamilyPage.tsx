import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { familyEntryPath, rememberFamily } from '../lib/familyEntry';
import { useMe, useRequireLogin } from '../App';

interface FamilyInfo {
  name: string; code: string;
  members: { id: string; displayName: string; role: string }[];
  invitations: { id: string; expiresAt: string; createdAt: string }[];
}

export default function FamilyPage() {
  const { member, loading, setMember } = useMe();
  const ready = useRequireLogin(member, loading);
  const navigate = useNavigate();
  const [family, setFamily] = useState<FamilyInfo | null>(null);
  const [invitation, setInvitation] = useState<{ id: string; url: string } | null>(null);
  const [target, setTarget] = useState('');
  const [pin, setPin] = useState('');
  const [adminPin, setAdminPin] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deviceCode, setDeviceCode] = useState('');
  const load = async () => {
    const result = await api<FamilyInfo>('/api/family');
    rememberFamily(result.code); setFamily(result);
  };
  useEffect(() => { if (ready) void load().catch((err: Error) => setError(err.message)); }, [ready]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : '操作失败，请重试'); }
    finally { setBusy(false); }
  };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setNotice('链接已复制，可以发给家人'); }
    catch { setNotice('请长按下面的链接复制'); }
  };
  if (!ready) return null;
  const entry = family ? new URL(familyEntryPath(family.code), window.location.origin).href : '';
  return <main className="page">
    <p className="page-eyebrow">家庭设置</p>
    <h1>{family?.name ?? '我的家庭'}</h1>
    <p className="page-subtitle">设置一次，以后顺手分享。</p>
    {family && <section className="card">
      <h2>家庭入口</h2><p>把入口保存到手机桌面，或发到家庭群。换手机后选择自己的名字、输入 PIN 即可恢复。</p>
      <p><a className="share-link" href={entry}>{entry}</a></p><button className="primary-button" onClick={() => void copy(entry)}>复制家庭入口</button>
      <p className="muted">入口只用于找到家庭，查看和发送内容仍需登录。不需要安装 APK。</p>
    </section>}
    {member?.role === 'ADMIN' && family && <>
      <section className="card"><h2>绑定奶奶的相框</h2>
        <p>打开相框设置里的“显示设备配对码”，把屏幕上的 6 位数字填在这里。绑定到：{family.name}。</p>
        <form className="form" onSubmit={(e) => { e.preventDefault(); void run(async () => {
          await api('/api/pair/claim', { method: 'POST', body: JSON.stringify({ code: deviceCode }) });
          setDeviceCode(''); setNotice('已绑定。相框联网时会自动确认并开始接收，以后不用重复绑定。');
        }); }}>
          <label>相框设备码<input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={deviceCode} onChange={(e) => setDeviceCode(e.target.value)} /></label>
          <button className="primary-button" disabled={busy}>绑定到这个家庭</button>
        </form><p className="muted">家人换手机、重新登录或重置 PIN，都不影响相框绑定。</p>
      </section>
      <section className="card"><h2>邀请新家人</h2><p>每个邀请限一位新成员使用，24 小时有效。已有成员请使用上面的家庭入口。</p>
        <button className="primary-button" disabled={busy} onClick={() => void run(async () => {
          const result = await api<{ id: string; token: string }>('/api/family/invitations', { method: 'POST', body: '{}' });
          setInvitation({ id: result.id, url: new URL(`/join/${result.token}`, window.location.origin).href }); await load();
        })}>生成邀请链接</button>
        {invitation && <div><p><a className="share-link" href={invitation.url}>{invitation.url}</a></p><button className="link-button" onClick={() => void copy(invitation.url)}>复制邀请链接</button></div>}
        {family.invitations.map((item) => <p key={item.id} className="muted">{new Date(item.createdAt).toLocaleString('zh-CN')} 创建的邀请
          <button className="link-button" disabled={busy} onClick={() => void run(async () => {
            await api(`/api/family/invitations/${item.id}`, { method: 'DELETE' });
            if (invitation?.id === item.id) setInvitation(null);
            await load(); setNotice('邀请已撤销');
          })}>撤销</button></p>)}
      </section>
      <section className="card"><h2>帮家人重置 PIN</h2>
        <form className="form" onSubmit={(e) => { e.preventDefault(); void run(async () => {
          await api(`/api/family/members/${encodeURIComponent(target)}/pin`, { method: 'POST', body: JSON.stringify({ pin, adminPin }) });
          setPin(''); setAdminPin('');
          if (target === member.id) { setMember(null); navigate(familyEntryPath(family.code)); return; }
          setNotice('PIN 已重置。请将新 PIN 私下告诉这位家人，让他从家庭入口重新登录；相框绑定不变。');
        }); }}>
          <label>选择成员<select value={target} onChange={(e) => setTarget(e.target.value)} required><option value="">请选择</option>{family.members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select></label>
          <label>新 PIN<input type="password" inputMode="numeric" pattern="[0-9]{6,20}" minLength={6} maxLength={20} required value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="new-password" /></label>
          <label>你的管理员 PIN<input type="password" inputMode="numeric" required value={adminPin} onChange={(e) => setAdminPin(e.target.value)} autoComplete="current-password" /></label>
          <p className="muted">重置后，该成员所有旧手机登录都会失效，照片和成员身份保留。</p><button className="primary-button" disabled={busy}>重置 PIN</button>
        </form>
      </section>
    </>}
    {notice && <p className="success-banner" role="status">{notice}</p>}{error && <p className="error-text" role="alert">{error}</p>}
  </main>;
}
