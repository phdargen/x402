import {
  createAuthCaptureServer,
  registerDeferredAdminRoutes,
  startAuthCaptureServer,
} from "./lib";

const ctx = createAuthCaptureServer("delegated-deferred");
registerDeferredAdminRoutes(ctx);

startAuthCaptureServer(ctx).catch(err => {
  console.error("Startup failed:", err);
  process.exit(1);
});
