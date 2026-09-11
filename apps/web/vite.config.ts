import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiProxy = {
  '/api': {
    target: 'http://127.0.0.1:3000',
    changeOrigin: false,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    // 开发代理：/api 转发到本地 API，浏览器侧同源，无需 CORS
    proxy: apiProxy,
  },
  preview: {
    // 生产构建预览（vite preview）同样代理 /api，用于 Service Worker 离线验证
    proxy: apiProxy,
  },
});
