import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { requireServerConfig } from "./config.ts";

const { host, port } = requireServerConfig(process.env);

serve({ fetch: createApp().fetch, hostname: host, port }, (info) => {
  console.log(`API listening on http://${info.address}:${String(info.port)}`);
});
