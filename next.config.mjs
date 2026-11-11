/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['ffmpeg-static'],
  outputFileTracingIncludes: {
    '/api/cron/theo-historias': ['./node_modules/ffmpeg-static/ffmpeg', './assets/fonts/**'],
    '/api/cron/theo-editar': ['./node_modules/ffmpeg-static/ffmpeg', './assets/fonts/**'],
  },
  async rewrites() {
    return [{ source: '/', destination: '/oficina.html' }];
  },
};
export default nextConfig;
