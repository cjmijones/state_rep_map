import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/tiles/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Origin, X-Requested-With, Content-Type, Accept" },
          { key: "Content-Type", value: "application/x-protobuf" },
          { key: "Content-Encoding", value: "gzip" },
        ],
      },
    ];
  },
};

export default nextConfig;
