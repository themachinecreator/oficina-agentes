/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [{ source: '/', destination: '/oficina.html' }];
  },
};
export default nextConfig;
