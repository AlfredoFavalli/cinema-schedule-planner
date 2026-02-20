"""Compatibility shim for legacy script name."""
import runpy
from pathlib import Path

runpy.run_path(str(Path(__file__).resolve().parent / "apps/scraping/scrape_film_affinity_upcoming_releases.py"), run_name="__main__")
