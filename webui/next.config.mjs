/** @type {import('next').NextConfig} */
const nextConfig = {
  // `pg` is a native-ish node module; keep it out of the bundler's hands.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
