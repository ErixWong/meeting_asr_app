/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // #54：运行时数据库入口改成 knex（better-sqlite3 / mysql2 / tedious）后，knex 必须留给
  // Node 运行时 require —— 否则 webpack 会去静态解析 knex 的 dialects 索引，撞上它 require
  // 的**未安装的可选驱动**（实测 `Can't resolve 'mariadb/callback'` / `'oracledb'`）而 build 失败。
  // 这几个包都是原生/重型依赖，打进 bundle 也没有意义。
  serverExternalPackages: ["knex", "better-sqlite3", "mysql2", "tedious"],
};

export default nextConfig;
