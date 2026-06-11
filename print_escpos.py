#!/usr/bin/env python3
"""
Bourbier Printer — ESC/POS print pipeline.

Architecture
────────────
  Node.js server
    → print_escpos.py <image.png>
      → ImagePipeline  : PNG → grayscale → ESC/POS bytes (in memory, no I/O)
      → PrinterBackend : ESC/POS bytes → printer

Backends
────────
  WindowsSpoolBackend  Windows only
    ESC/POS bytes → Windows Print Spooler → official Epson TM-T88V driver → printer.
    The driver owns all USB transport. No rate limiting, no STALL handling needed.

  UsbBackend           macOS / Linux
    ESC/POS bytes → raw pyusb → Epson TM-T88V USB endpoint.
    Fresh device handle per job (dispose_resources after each job) to avoid
    stale IOKit pipe state left by a previous failed job.
    7.2 KB chunks + 30 ms sleep: printer consumes 7.2 KB in ~50 ms, next chunk
    arrives at ~37 ms — 13 ms before buffer empties, no white bands.

Setup
─────
  pip install python-escpos Pillow
  Windows : also pip install pywin32
            install the official Epson TM-T88V driver
            set PRINTER_NAME in .env (default: "EPSON TM-T88V")
  macOS   : brew install libusb

Usage
─────
  python3 print_escpos.py <image.png>
"""

from __future__ import annotations

import os
import sys
import time
from abc import ABC, abstractmethod
from PIL import Image


# ═══════════════════════════════════════════════════════════════════
# Logging
# ═══════════════════════════════════════════════════════════════════

def _log(msg: str) -> None:
    print(msg, file=sys.stderr)


# ═══════════════════════════════════════════════════════════════════
# Backend abstraction
# ═══════════════════════════════════════════════════════════════════

class PrinterBackend(ABC):
    """Send raw ESC/POS bytes to the printer."""

    @abstractmethod
    def send(self, data: bytes) -> None: ...


class WindowsSpoolBackend(PrinterBackend):
    """
    Sends ESC/POS bytes to the Windows Print Spooler as a RAW job.
    The official Epson driver handles all USB transport — no rate limiting needed.
    """

    def __init__(self, printer_name: str) -> None:
        self.printer_name = printer_name

    def send(self, data: bytes) -> None:
        import win32print

        _log(f"  printer : {self.printer_name}")
        _log(f"  payload : {len(data):,} B")

        handle = win32print.OpenPrinter(self.printer_name)
        try:
            job_id = win32print.StartDocPrinter(handle, 1, ("Bourbier Photo", None, "RAW"))
            _log(f"  job id  : {job_id}")
            win32print.StartPagePrinter(handle)
            written = win32print.WritePrinter(handle, data)
            win32print.EndPagePrinter(handle)
            win32print.EndDocPrinter(handle)
            _log(f"  written : {written:,} B → spooler queued")
        except OSError as exc:
            _log(f"  ERROR   : {exc}")
            raise
        finally:
            win32print.ClosePrinter(handle)


class UsbBackend(PrinterBackend):
    """
    Sends ESC/POS bytes directly to the Epson TM-T88V USB endpoint.
    Opens a fresh device handle for every job and disposes it afterwards.

    Why fresh handle per job:
      On macOS/IOKit, a failed job leaves pending transfers in the libusb pipe.
      Reusing the same handle means the NEXT job inherits that broken state,
      resulting in ~500 ms for the first 7 KB write, then an immediate STALL.
      dispose_resources() releases the IOKit reference without touching the device.
      Never call clear_halt() on macOS — it triggers ClearPipeStallBothEnds()
      which causes a full USB device reset (errno 19, device disappears).
    """

    VID   = 0x04b8
    PID   = 0x0e02
    CHUNK = 7200    # 100 rows × 72 B = 7.2 KB < 32 KB printer receive buffer
    SLEEP = 0.030   # s between chunks: printer needs ~50 ms to print 7.2 KB;
                    # next chunk arrives at ~37 ms — 13 ms margin before starvation

    def send(self, data: bytes) -> None:
        import usb.core
        import usb.util

        _log(f"  payload : {len(data):,} B")

        dev = usb.core.find(idVendor=self.VID, idProduct=self.PID)
        if dev is None:
            raise RuntimeError(f"Printer {self.VID:04x}:{self.PID:04x} not found")

        try:
            usb.util.claim_interface(dev, 0)

            cfg  = dev.get_active_configuration()
            intf = cfg[(0, 0)]
            ep   = usb.util.find_descriptor(
                intf,
                custom_match=lambda e:
                    usb.util.endpoint_direction(e.bEndpointAddress)
                    == usb.util.ENDPOINT_OUT,
            )
            if ep is None:
                raise RuntimeError("No bulk OUT endpoint found")

            total   = len(data)
            n_chunks = (total + self.CHUNK - 1) // self.CHUNK
            _log(f"  chunks  : {n_chunks} × {self.CHUNK} B + {self.SLEEP * 1000:.0f} ms sleep")
            _log("  " + "─" * 46)

            for i in range(0, total, self.CHUNK):
                chunk = data[i : i + self.CHUNK]
                idx   = i // self.CHUNK + 1
                t0    = time.perf_counter()
                ep.write(chunk, timeout=3000)
                ms    = (time.perf_counter() - t0) * 1000
                _log(f"  [{idx:02d}/{n_chunks}]  {i:6d}–{i+len(chunk):6d} B  {ms:6.1f} ms")
                if i + self.CHUNK < total:
                    time.sleep(self.SLEEP)

            _log("  " + "─" * 46)

        finally:
            try:
                usb.util.release_interface(dev, 0)
            except Exception:
                pass
            usb.util.dispose_resources(dev)
            _log("  USB     : handle released + disposed")


def get_backend() -> PrinterBackend:
    if os.name == "nt":
        name = os.environ.get("PRINTER_NAME", "EPSON TM-T88V")
        return WindowsSpoolBackend(name)
    return UsbBackend()


# ═══════════════════════════════════════════════════════════════════
# Image pipeline
# ═══════════════════════════════════════════════════════════════════

class ImagePipeline:
    """PNG → grayscale image + ESC/POS binary (all in memory)."""

    # python-escpos TM-T88V profile caps at 512 px, but 80 mm paper = 576 dots
    # (72 mm × 8 dot/mm at 203 DPI). Patch the profile to allow full width.
    PROFILE_WIDTH = 576

    def __init__(self, img_path: str) -> None:
        self.img_path = img_path

    def load(self) -> Image.Image:
        img = Image.open(self.img_path).convert("L")
        _log(f"  image   : {img.width} × {img.height} px")

        # Save 1-bit version for visual debug.
        # If white bands appear in this file → dithering issue.
        # If absent → USB timing issue.
        debug = self.img_path.replace(".png", "_1bit.png")
        img.convert("1").save(debug)
        _log(f"  1-bit   : {debug}")

        return img

    def to_escpos(self, img: Image.Image) -> bytes:
        from escpos.printer import Dummy

        d = Dummy(profile="TM-T88V")
        d.profile.profile_data["media"]["width"]["pixels"] = self.PROFILE_WIDTH
        d._raw(b"\x1b\x40")   # ESC @ — reset printer (clears margins, density, etc.)
        d.image(img)
        d.cut()
        data: bytes = d.output
        _log(f"  ESC/POS : {len(data):,} B")
        return data


# ═══════════════════════════════════════════════════════════════════
# Entry point
# ═══════════════════════════════════════════════════════════════════

def main() -> None:
    if len(sys.argv) < 2:
        _log("Usage: print_escpos.py <image.png>")
        sys.exit(1)

    img_path = sys.argv[1]

    backend  = get_backend()
    pipeline = ImagePipeline(img_path)

    _log(f"\n{'═' * 50}")
    _log(f"source  : {img_path}")
    _log(f"backend : {backend.__class__.__name__}")

    img   = pipeline.load()
    data  = pipeline.to_escpos(img)

    t0 = time.perf_counter()
    backend.send(data)
    _log(f"total   : {time.perf_counter() - t0:.2f} s")
    _log(f"{'═' * 50}\n")


if __name__ == "__main__":
    main()
