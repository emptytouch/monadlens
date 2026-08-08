import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Moss (@themoss/core, @themoss/simulator) is an ESM-only, Node-only library
  // with a hard dependency on debug_traceCall. It must run on the Node runtime
  // and must be kept external (not bundled) so Next doesn't choke on its ESM
  // output during the server build.
  serverExternalPackages: ["@themoss/core", "@themoss/simulator"],
  // Allow localhost access from 127.0.0.1 (Next.js 16 blocks cross-origin dev resources by default)
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
