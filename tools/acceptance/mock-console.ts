/** Synthetic local console for repeatable acceptance without real accounts. */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { ImageItem, Task } from "../../src/lib/types";

export async function startMockConsole(port = 0) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const task: Task = {
    id: 42, task_id: "local-task-42", name: "local-acceptance", status: 2,
    cpu: 4, gpu: 1, memory: 16, releace_conditions: 2,
    releace_time: new Date(Date.now() + 5 * 60_000).toISOString(),
    create_time: new Date(Date.now() - 3_600_000).toISOString(),
    ip: "127.0.0.1", ssh_username: "local-test", ssh_port: "22022",
  };
  let images: ImageItem[] = [{ id: 11, name: "acceptance-image", description: "Synthetic image" }];
  let editingSupported = true;
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 256 * 1024) { res.writeHead(413).end(); return; }
      chunks.push(Buffer.from(chunk));
    }
    let body: unknown = null;
    try { if (size) body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { res.writeHead(400).end(); return; }
    requests.push({ method, path: url.pathname, body });
    const send = (data: unknown, status = 200, code = 0) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code, message: code ? "Synthetic rejection" : "ok", data }));
    };
    if (url.pathname === "/__acceptance/state") { send({ task, images, requests }); return; }
    if (url.pathname === "/__acceptance/editing" && method === "POST") {
      editingSupported = Boolean((body as { supported?: boolean } | null)?.supported); send({ editingSupported }); return;
    }
    if (url.pathname === "/api/user/token") { send({ token: "local-acceptance-token" }); return; }
    if (url.pathname === "/api/token") { send({ token: "local-bootstrap" }); return; }
    if (req.headers.authorization !== "Bearer local-acceptance-token") { send(null, 401); return; }
    if (url.pathname === "/api/user/userinfo") { send({ id: "local-acceptance", username: "local-acceptance", name: "Local acceptance" }); return; }
    if (url.pathname === "/api/instance/console") { send({ run_task_count: 1, pending_task_count: 0, run_time: { day: 3600 }, cost_map: { day: 0 } }); return; }
    if (url.pathname === "/api/instance/task" && method === "GET") { send({ items: [task], total: 1 }); return; }
    if (url.pathname === "/api/instance/task/42" && method === "PATCH") {
      if (!editingSupported) { send(null, 405); return; }
      Object.assign(task, body); send(task); return;
    }
    if (url.pathname === "/api/instance/task/42" && method === "PUT") { task.status = 4; send({ released: true }); return; }
    if (url.pathname === "/api/instance/task_log") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Local synthetic task ready\nNo remote account used\n"); return;
    }
    if (url.pathname === "/api/instance/monitor_index") {
      const points = Array.from({ length: 121 }, (_, index) => ({ timestamp: Date.now() - index * 60_000, value: 0 }));
      send({ cpu: [{ name: "CPU", data: points }], network: [{ name: "network", data: points }] }); return;
    }
    if (["/api/instance/statics", "/api/instance/statics_cost", "/api/instance/statics_cost/month"].includes(url.pathname)) { send([]); return; }
    if (url.pathname === "/api/image/image" && method === "GET") { send({ items: images, total: images.length }); return; }
    if (url.pathname === "/api/image/image_system") { send({ items: [{ id: 21, name: "synthetic-system-image" }], total: 1 }); return; }
    if (url.pathname === "/api/image/image/11" && method === "PUT") {
      images = images.map((image) => image.id === 11 ? { ...image, ...(body as object) } : image); send(images[0]); return;
    }
    if (url.pathname === "/api/image/image/11" && method === "DELETE") { images = images.filter((image) => image.id !== 11); send({ deleted: true }); return; }
    if (url.pathname === "/api/image/image/11" && method === "GET") { send(images[0]); return; }
    if (url.pathname.startsWith("/api/resource/") || url.pathname.startsWith("/api/price/")) { send([]); return; }
    send(null, 404);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local listen address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api`, requests, task,
    setEditingSupported(value: boolean) { editingSupported = value; },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await startMockConsole(Number(process.env.EASY_CONSOLE_ACCEPTANCE_PORT ?? 28991));
  process.stdout.write(`Synthetic console: ${mock.baseUrl}\n`);
}
