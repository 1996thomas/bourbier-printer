import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { PNG } from "pngjs";

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

// ─── Atkinson dithering ───────────────────────────────────────────────────────
//
// Converts a grayscale-ish PNG to a 1-bit raster suitable for thermal printing.
// Pipeline: RGBA → grayscale → 3×3 unsharp mask → Atkinson dither
//
// Atkinson propagates only 6/8 of the error → highlights stay clean,
// well suited for 1-bit / 203 DPI thermal output.

const SHARPEN_AMOUNT = 1.5;  // unsharp mask strength before dithering

function ditherAtkinson(buffer: Buffer): Buffer {
  const png = PNG.sync.read(buffer);
  const { width, height, data } = png;
  const n = width * height;

  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    gray[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  }

  // Unsharp mask (3×3 box blur)
  const blurred = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            sum += gray[ny * width + nx]; count++;
          }
        }
      }
      blurred[y * width + x] = sum / count;
    }
  }
  for (let i = 0; i < n; i++) {
    gray[i] = Math.max(0, Math.min(255, gray[i] + SHARPEN_AMOUNT * (gray[i] - blurred[i])));
  }

  // Atkinson dither
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const old = gray[idx];
      const nw  = old >= 128 ? 255 : 0;
      gray[idx]  = nw;
      const e    = (old - nw) / 8;

      if (x + 1 < width)  gray[idx + 1]                 += e;
      if (x + 2 < width)  gray[idx + 2]                 += e;
      if (y + 1 < height) {
        if (x - 1 >= 0)   gray[(y + 1) * width + x - 1] += e;
                          gray[(y + 1) * width + x]      += e;
        if (x + 1 < width)gray[(y + 1) * width + x + 1] += e;
      }
      if (y + 2 < height) gray[(y + 2) * width + x]     += e;
    }
  }

  for (let i = 0; i < n; i++) {
    const v = gray[i] >= 128 ? 255 : 0;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }

  return Buffer.from(PNG.sync.write(png));
}

// ─── ESC/POS builder ──────────────────────────────────────────────────────────
//
// Converts a 1-bit PNG to a single GS v 0 raster command for Epson TM printers.
// bytesPerRow = ceil(width/8), MSB = leftmost pixel, bit 1 = black dot.

function buildEscPos(pngBuffer: Buffer): Buffer {
  const png = PNG.sync.read(pngBuffer);
  const { width, height, data } = png;
  const bytesPerRow = Math.ceil(width / 8);

  log.info(`ESC/POS: ${width}×${height}px  ${bytesPerRow}B/row  ${((bytesPerRow * height) / 1024).toFixed(1)}KB`);

  const imageData = Buffer.alloc(bytesPerRow * height, 0);
  for (let y = 0; y < height; y++) {
    for (let bx = 0; bx < bytesPerRow; bx++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = bx * 8 + bit;
        if (x < width) {
          const idx = (y * width + x) * 4;
          if (data[idx] < 128) byte |= (0x80 >> bit);
        }
      }
      imageData[y * bytesPerRow + bx] = byte;
    }
  }

  const xL = bytesPerRow & 0xFF, xH = (bytesPerRow >> 8) & 0xFF;
  const yL = height      & 0xFF, yH = (height      >> 8) & 0xFF;

  return Buffer.concat([
    Buffer.from([0x1B, 0x40]),                              // ESC @  — reset
    Buffer.from([0x1D, 0x76, 0x30, 0x00, xL, xH, yL, yH]), // GS v 0 — raster image
    imageData,
    Buffer.from([0x1B, 0x64, 0x04]),                        // ESC d 4 — paper feed
    Buffer.from([0x1D, 0x56, 0x41, 0x10]),                  // GS V A  — partial cut
  ]);
}

// ─── Print ────────────────────────────────────────────────────────────────────
//
// Windows  → python  + win32print (official Epson driver, no rate limiting needed)
// macOS/Linux → python3 + pyusb   (direct USB, 8 KB/55 ms rate limiting)

const PRINT_SCRIPT = path.join(__dirname, "..", "print_escpos.py");
const PYTHON_CMD   = process.platform === "win32" ? "python" : "python3";

function sendToPrinterScript(binPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(`${PYTHON_CMD} "${PRINT_SCRIPT}" < "${binPath}"`, (err, _out, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve();
    });
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
  buffer?:   Buffer;
};

const jobs = new Map<string, PrintJob>();

function makeId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function publicJob(job: PrintJob) {
  const { buffer: _, ...rest } = job;
  return rest;
}

// ─── Prints dir ───────────────────────────────────────────────────────────────

const PRINTS_DIR = path.join(__dirname, "..", "prints");
if (!fs.existsSync(PRINTS_DIR)) fs.mkdirSync(PRINTS_DIR, { recursive: true });

// Save dithered PNG + ESC/POS binary, then send to printer via USB.
async function processPrint(id: string, buffer: Buffer, filename: string): Promise<void> {
  const pngPath = path.join(PRINTS_DIR, filename);
  const binPath = pngPath.replace(/\.png$/, ".bin");

  const dithered = ditherAtkinson(buffer);
  fs.writeFileSync(pngPath, dithered);
  log.ok(`[${id}] saved ${filename}`);

  const escpos = buildEscPos(dithered);
  fs.writeFileSync(binPath, escpos);

  await sendToPrinterScript(binPath);
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

  const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  const id       = makeId();
  const filename = `${id}.png`;

  log.info(`[${id}] print request — ${(buffer.byteLength / 1024).toFixed(1)} KB`);

  try {
    await processPrint(id, buffer, filename);
    log.ok(`[${id}] done`);
    jobs.set(id, { id, filename, attempts: 1, status: "done", error: null, createdAt: new Date().toISOString() });
    res.json({ success: true, id, filename });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[${id}] ${message}`);
    jobs.set(id, { id, filename: null, attempts: 1, status: "failed", error: message, createdAt: new Date().toISOString(), buffer });
    res.status(500).json({ success: false, id, error: message });
  }
});

app.post("/jobs/:id/retry", async (req: Request, res: Response) => {
  const job = jobs.get(req.params.id);
  if (!job)         { res.status(404).json({ error: "Job not found" }); return; }
  if (!job.buffer)  { res.status(400).json({ error: "Buffer gone, cannot retry" }); return; }
  if (job.status === "done") { res.json({ success: true, filename: job.filename }); return; }

  job.attempts++;
  const filename = `${job.id}_retry${job.attempts}.png`;

  try {
    await processPrint(job.id, job.buffer, filename);
    log.ok(`[${job.id}] retry OK`);
    job.status = "done"; job.filename = filename; job.error = null; delete job.buffer;
    res.json({ success: true, id: job.id, filename });
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
