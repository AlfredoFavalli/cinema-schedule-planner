"""Run all scraping workflows in a single command."""

from __future__ import annotations

import runpy
from pathlib import Path


def run_script(script_name: str) -> None:
    script_path = Path(__file__).resolve().parent / script_name
    print(f"\n=== Running {script_name} ===")
    runpy.run_path(str(script_path), run_name="__main__")


def main() -> None:
    run_script("extract_renoir_showtimes.py")
    run_script("extract_golem_showtimes.py")
    run_script("scrape_film_affinity_upcoming_releases.py")


if __name__ == "__main__":
    main()
