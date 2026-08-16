/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // src/db/index.ts imports both drivers so the choice can be made at runtime.
  // PGlite ships a multi-megabyte WASM build of Postgres that must not go
  // through the bundler — kept external, it stays a plain node require that is
  // only ever reached on the local, DATABASE_URL-less path.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
