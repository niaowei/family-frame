// 只记住入口位置；身份验证始终由 HttpOnly Cookie 和服务器负责。
export function rememberFamily(code: string): void {
  try { localStorage.setItem('ff_family_entry', code); } catch { /* 浏览器禁止存储时仍可用分享链接 */ }
}

export function familyEntryPath(code?: string): string {
  if (code) return `/family/${encodeURIComponent(code)}`;
  try {
    const saved = localStorage.getItem('ff_family_entry');
    if (saved) return familyEntryPath(saved);
  } catch { /* 使用普通登录入口 */ }
  return '/login';
}
