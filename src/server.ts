import express, { Request, Response } from "express";
import fs from "fs";
import path from "path";

const app = express();
const PORT = 9456;
const PRINTS_DIR = path.join(__dirname, "..", "prints");

app.use(express.json({ limit: "20mb" }));

// Ensure prints directory exists at startup
if (!fs.existsSync(PRINTS_DIR)) {
  fs.mkdirSync(PRINTS_DIR, { recursive: true });
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.post("/print", (req: Request, res: Response) => {
  const { imageBase64 } = req.body;

  if (!imageBase64 || typeof imageBase64 !== "string") {
    res.status(400).json({ error: "imageBase64 is required and must be a string" });
    return;
  }

  // Strip data URI prefix if present (e.g. "data:image/png;base64,...")
  const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");

  const buffer = Buffer.from(base64Data, "base64");
  const filename = `print_${Date.now()}.png`;
  const filepath = path.join(PRINTS_DIR, filename);

  fs.writeFile(filepath, buffer, (err) => {
    if (err) {
      console.error("Failed to save image:", err);
      res.status(500).json({ error: "Failed to save image" });
      return;
    }

    console.log(`Image saved: ${filename}`);
    res.json({ success: true, filename });
  });
});

app.listen(PORT, () => {
  console.log(`Bourbier Printer service running on http://localhost:${PORT}`);
});
