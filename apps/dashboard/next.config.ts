import type { NextConfig } from "next";

// Fully static: `next build` writes plain HTML/JS/CSS to out/. No server, API routes or runtime data access.
const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
};

export default config;
