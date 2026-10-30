/** Renderer acceptance over one loopback origin, without a desktop profile. */
import { createServer } from "vite";

const port = 1439;
const mockOrigin = "http://127.0.0.1:28991";
process.env.VITE_API_BASE_URL = `http://127.0.0.1:${port}/api`;
process.env.VITE_MONITOR_DASHBOARD_URL = `http://127.0.0.1:${port}/monitor`;

const server = await createServer({
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    proxy: { "/api": mockOrigin, "/__acceptance": mockOrigin, "/monitor": mockOrigin },
  },
});
await server.listen();
server.printUrls();
