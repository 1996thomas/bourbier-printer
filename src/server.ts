import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { exec } from "child_process";

// ─── Logger ───────────────────────────────────────────────────────────────────

const C = {
  reset:  "\x1b[0m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  cyan:   "\x1b[36m",
  bold:   "\x1b[1m",
};

function ts() {
  return C.dim + new Date().toISOString().replace("T", " ").replace("Z", "") + C.reset;
}

const log = {
  info:  (msg: string) => console.log(`${ts()}  ${C.cyan}INFO${C.reset}   ${msg}`),
  ok:    (msg: string) => console.log(`${ts()}  ${C.green}OK${C.reset}     ${msg}`),
  warn:  (msg: string) => console.warn(`${ts()}  ${C.yellow}WARN${C.reset}   ${msg}`),
  error: (msg: string) => console.error(`${ts()}  ${C.red}ERROR${C.reset}  ${msg}`),
};

// ─── Print ────────────────────────────────────────────────────────────────────
//
// Delegates all image processing (dithering, ESC/POS generation) and USB/Win32
// communication to print_escpos.py (python-escpos library).
//
// Windows  → python  (uses win32print + official Epson driver)
// macOS/Linux → python3 (uses pyusb, direct USB, fragment-based rate control)

const PRINT_SCRIPT = path.join(__dirname, "..", "print_escpos.py");
const PYTHON_CMD   = process.platform === "win32" ? "python" : "python3";

function printPng(pngPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(
      `${PYTHON_CMD} "${PRINT_SCRIPT}" "${pngPath}"`,
      { env: process.env, timeout: 60_000 },
      (err, _out, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message));
        else resolve();
      }
    );
  });
}

// ─── Job store ────────────────────────────────────────────────────────────────

type JobStatus = "done" | "failed";

type PrintJob = {
  id:        string;
  createdAt: string;
  status:    JobStatus;
  filename:  string | null;
  error:     string | null;
  attempts:  number;
  pngPath?:  string;
};

const jobs = new Map<string, PrintJob>();

function makeId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function publicJob(job: PrintJob) {
  const { pngPath: _, ...rest } = job;
  return rest;
}

// ─── Prints dir ───────────────────────────────────────────────────────────────

const PRINTS_DIR = path.join(__dirname, "..", "prints");
if (!fs.existsSync(PRINTS_DIR)) fs.mkdirSync(PRINTS_DIR, { recursive: true });

async function processPrint(id: string, buffer: Buffer, filename: string): Promise<string> {
  const pngPath = path.join(PRINTS_DIR, filename);
  fs.writeFileSync(pngPath, buffer);
  log.ok(`[${id}] saved ${filename} (${(buffer.byteLength / 1024).toFixed(1)} KB)`);
  await printPng(pngPath);
  return pngPath;
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app  = express();
const PORT = 9456;

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "20mb" }));

app.use((req: Request, _res: Response, next: NextFunction) => {
  log.info(`${C.bold}${req.method}${C.reset} ${req.path}`);
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/jobs", (_req, res) => {
  const list   = [...jobs.values()].map(publicJob).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const counts = { done: 0, failed: 0 };
  for (const j of jobs.values()) counts[j.status]++;
  res.json({ jobs: list, counts });
});

app.post("/print", async (req: Request, res: Response) => {
  const { imageBase64 } = req.body as { imageBase64?: string };

  if (!imageBase64) {
    res.status(400).json({ error: "imageBase64 required" });
    return;
  }

  const buffer   = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  const id       = makeId();
  const filename = `${id}.png`;

  log.info(`[${id}] print request — ${(buffer.byteLength / 1024).toFixed(1)} KB`);

  try {
    const pngPath = await processPrint(id, buffer, filename);
    log.ok(`[${id}] done`);
    jobs.set(id, { id, filename, attempts: 1, status: "done", error: null, createdAt: new Date().toISOString(), pngPath });
    res.json({ success: true, id, filename });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[${id}] ${message}`);
    const pngPath = path.join(PRINTS_DIR, filename);
    jobs.set(id, { id, filename, attempts: 1, status: "failed", error: message, createdAt: new Date().toISOString(), pngPath: fs.existsSync(pngPath) ? pngPath : undefined });
    res.status(500).json({ success: false, id, error: message });
  }
});

app.post("/jobs/:id/retry", async (req: Request, res: Response) => {
  const job = jobs.get(req.params.id);
  if (!job)          { res.status(404).json({ error: "Job not found" }); return; }
  if (!job.pngPath)  { res.status(400).json({ error: "PNG gone, cannot retry" }); return; }
  if (job.status === "done") { res.json({ success: true, filename: job.filename }); return; }

  job.attempts++;

  try {
    await printPng(job.pngPath);
    log.ok(`[${job.id}] retry OK`);
    job.status = "done"; job.error = null;
    res.json({ success: true, id: job.id, filename: job.filename });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    job.error = message;
    log.error(`[${job.id}] retry failed — ${message}`);
    res.status(500).json({ success: false, id: job.id, error: message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  ${C.bold}${C.green}Bourbier Printer${C.reset}  http://localhost:${PORT}`);
  console.log(`  ${C.dim}prints :${C.reset} ${PRINTS_DIR}`);
  console.log(`  ${C.dim}script :${C.reset} ${PRINT_SCRIPT} (${PYTHON_CMD})\n`);
});
