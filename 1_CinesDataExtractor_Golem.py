"""Compatibility shim for legacy script name."""
import runpy
from pathlib import Path

runpy.run_path(str(Path(__file__).resolve().parent / "apps/scraping/extract_golem_showtimes.py"), run_name="__main__")
