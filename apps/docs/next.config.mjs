import { createMDX } from "fumadocs-mdx/next";

// The GitHub Pages project path of this repository.
const basePath = "/agent-platform";

/** @type {import('next').NextConfig} */
const config = {
  output: "export",
  basePath,
  // Pages serves `foo/index.html` for `foo/`, not `foo.html` for `foo`.
  trailingSlash: true,
  reactStrictMode: true,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default createMDX()(config);
