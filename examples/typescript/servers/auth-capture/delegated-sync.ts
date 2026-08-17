import {
  createAuthCaptureServer,
  startAuthCaptureServer,
} from "./lib";

const ctx = createAuthCaptureServer("delegated-sync");

startAuthCaptureServer(ctx).catch(err => {
  console.error("Startup failed:", err);
  process.exit(1);
});
