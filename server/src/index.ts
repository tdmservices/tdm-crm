import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { ZodError } from "zod";
import "./db.js";
import { HttpError } from "./errors.js";
import { requireAuth } from "./auth.js";
import { refreshRates } from "./fx.js";
import { authRouter } from "./routes/auth.js";
import { usersRouter, settingsRouter } from "./routes/users.js";
import { prospectsRouter } from "./routes/prospects.js";
import { meetingsRouter } from "./routes/meetings.js";
import { tasksRouter } from "./routes/tasks.js";
import { paymentsRouter, commissionRouter, leaderboardRouter } from "./routes/money.js";
import { targetsRouter } from "./routes/targets.js";
import { todayRouter } from "./routes/today.js";
import { reportsRouter } from "./routes/reports.js";
import { scheduleRouter } from "./routes/schedule.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { documentsRouter, portalRouter } from "./routes/documents.js";
import { startJobs } from "./jobs.js";
import { ensureVapid } from "./channels.js";

export const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/auth", authRouter);
app.use("/api/users", requireAuth, usersRouter);
app.use("/api/settings", requireAuth, settingsRouter);
app.use("/api/prospects", requireAuth, prospectsRouter);
app.use("/api/meetings", requireAuth, meetingsRouter);
app.use("/api/tasks", requireAuth, tasksRouter);
app.use("/api/payments", requireAuth, paymentsRouter);
app.use("/api/commission", requireAuth, commissionRouter);
app.use("/api/leaderboard", requireAuth, leaderboardRouter);
app.use("/api/targets", requireAuth, targetsRouter);
app.use("/api/today", requireAuth, todayRouter);
app.use("/api/reports", requireAuth, reportsRouter);
app.use("/api/prospects", requireAuth, scheduleRouter);
app.use("/api/documents", requireAuth, documentsRouter);
app.use("/api/portal", portalRouter);
app.use("/api/webhooks", webhooksRouter);

// Serve the built web app (Abdul's web version) when present.
const webDist = path.resolve(process.cwd(), "../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ZodError) return res.status(400).json({ error: err.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra ?? {}) });
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
});

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 4000);
  app.listen(port, () => console.log(`TDM CRM API on :${port}`));
  refreshRates().then(r => console.log("FX", r.ok ? `rates fetched for ${r.date}` : `fetch failed (${r.error}); using last known rates`));
  setInterval(() => void refreshRates(), 6 * 60 * 60 * 1000);
  try { ensureVapid(); } catch (e) { console.error("vapid", e); }
  startJobs();
}
