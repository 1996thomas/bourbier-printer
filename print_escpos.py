#!/usr/bin/env python3
"""
Sends raw ESC/POS binary from stdin to the Epson TM-T88V.

Windows  — uses win32print with the official Epson driver.
           No rate limiting needed: the driver handles USB flow control.
           Requires: pip install pywin32
           Set PRINTER_NAME env var to match the name in "Printers & Scanners".

macOS / Linux — uses pyusb directly over USB, bypassing CUPS.
           Rate control: TM-T88V consumes ~142 KB/s (250mm/s × 8dot/mm × 72B/row).
           8 KB chunks + 55 ms delays → ~145 KB/s, avoids both starvation and STALL.
           Never call clear_halt() on macOS — it triggers a full USB device reset.
           Requires: pip install pyusb  +  brew install libusb  (macOS)

Usage: python3 print_escpos.py < file.bin
"""

import sys
import os


# ─── Windows ──────────────────────────────────────────────────────────────────

def print_windows(data: bytes) -> None:
    import win32print  # pywin32

    printer_name = os.environ.get("PRINTER_NAME", "EPSON TM-T88V")
    handle = win32print.OpenPrinter(printer_name)
    try:
        win32print.StartDocPrinter(handle, 1, ("Bourbier", None, "RAW"))
        win32print.StartPagePrinter(handle)
        win32print.WritePrinter(handle, data)
        win32print.EndPagePrinter(handle)
        win32print.EndDocPrinter(handle)
        print(f"OK: {len(data)} bytes → {printer_name}", file=sys.stderr)
    finally:
        win32print.ClosePrinter(handle)


# ─── macOS / Linux ────────────────────────────────────────────────────────────

VID   = 0x04b8
PID   = 0x0e02
CHUNK = 8192   # 8 KB per write
DELAY = 0.055  # 55 ms between chunks → ~145 KB/s

def print_usb(data: bytes) -> None:
    import time
    import usb.core
    import usb.util

    dev = usb.core.find(idVendor=VID, idProduct=PID)
    if dev is None:
        print(f"Printer {VID:04x}:{PID:04x} not found", file=sys.stderr)
        sys.exit(1)

    try:
        usb.util.claim_interface(dev, 0)
    except usb.core.USBError as e:
        print(f"claim_interface failed: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        cfg  = dev.get_active_configuration()
        intf = cfg[(0, 0)]
        ep   = usb.util.find_descriptor(
            intf,
            custom_match=lambda e:
                usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_OUT
        )
        if ep is None:
            print("No bulk OUT endpoint found", file=sys.stderr)
            sys.exit(1)

        total = len(data)
        sent  = 0
        for i in range(0, total, CHUNK):
            chunk = data[i:i + CHUNK]
            ep.write(chunk, timeout=15000)
            sent += len(chunk)
            if i + CHUNK < total:
                time.sleep(DELAY)

        print(f"OK: {sent}/{total} bytes", file=sys.stderr)

    finally:
        try:
            usb.util.release_interface(dev, 0)
        except Exception:
            pass


# ─── Entry point ──────────────────────────────────────────────────────────────

def main():
    data = sys.stdin.buffer.read()
    if not data:
        print("No data on stdin", file=sys.stderr)
        sys.exit(1)

    if os.name == "nt":
        print_windows(data)
    else:
        print_usb(data)


if __name__ == "__main__":
    main()
