import argparse
import csv
import json
import re
import shutil
import sys
from datetime import UTC, date, datetime
from html import unescape
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple
from urllib.error import URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

BASE_URL = "https://www.filmaffinity.com/es/rdcat.php?id=upc_th_es"
FA_BASE = "https://www.filmaffinity.com"
CANONICAL_PATH = Path("data/raw/film_affinity/upcoming_releases.csv")
BACKUP_DIR = Path("data/raw/film_affinity/backups")


def add_months(d: date, months: int) -> date:
    month = d.month - 1 + months
    year = d.year + month // 12
    month = month % 12 + 1
    dim = [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return date(year, month, min(d.day, dim[month - 1]))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="FilmAffinity upcoming releases scraper.")
    parser.add_argument("--max-stale-scrolls", type=int, default=8)
    parser.add_argument("--backup-keep", type=int, default=15)
    parser.add_argument("--months-ahead", type=int, default=6, help="Scrape window length in months from start date.")
    parser.add_argument("--start-date", type=str, default=None, help="Optional start date in YYYY-MM-DD. Defaults to today.")
    parser.add_argument("--no-browser", action="store_true", help="Fallback to plain HTTP fetch (debug).")
    return parser.parse_args()


def normalize(value: Optional[str]) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def strip_html(html_fragment: Optional[str]) -> str:
    text = unescape(re.sub(r"<[^>]+>", " ", html_fragment or ""))
    return normalize(text)


def parse_int(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    digits = re.sub(r"[^\d]", "", str(value))
    return int(digits) if digits else None


def parse_float(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    value = value.strip()
    if value == "--":
        return None
    match = re.search(r"\d+(?:[\.,]\d+)?", value)
    return float(match.group(0).replace(",", ".")) if match else None


def split_srcset(srcset: str) -> Optional[str]:
    best_url = None
    best_width = -1
    for part in srcset.split(','):
        bits = part.strip().split()
        if not bits:
            continue
        candidate = bits[0]
        width = 0
        if len(bits) > 1 and bits[1].endswith('w'):
            try:
                width = int(bits[1][:-1])
            except ValueError:
                width = 0
        if width >= best_width:
            best_width = width
            best_url = candidate
    return urljoin(FA_BASE, best_url) if best_url else None


def fetch_page(url: str) -> str:
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def find_matching_div_end(html: str, open_start: int) -> int:
    open_tag_end = html.find('>', open_start)
    if open_tag_end == -1:
        return len(html)

    depth = 1
    pos = open_tag_end + 1
    token_re = re.compile(r"<div\b|</div>", re.IGNORECASE)
    while depth > 0:
        match = token_re.search(html, pos)
        if not match:
            return len(html)
        token = match.group(0).lower()
        if token.startswith("<div"):
            depth += 1
        else:
            depth -= 1
        pos = match.end()
    return pos


def extract_div_blocks(html: str, class_tokens: List[str], id_pattern: Optional[str] = None) -> List[Tuple[str, Optional[str]]]:
    blocks: List[Tuple[str, Optional[str]]] = []
    start_tag_re = re.compile(r"<div\b[^>]*>", re.IGNORECASE)
    id_re = re.compile(id_pattern) if id_pattern else None

    for m in start_tag_re.finditer(html):
        tag = m.group(0)
        class_m = re.search(r'class\s*=\s*"([^"]+)"', tag, re.IGNORECASE)
        if not class_m:
            continue
        classes = class_m.group(1)
        if not all(token in classes for token in class_tokens):
            continue

        id_value = None
        if id_re:
            id_m = re.search(r'id\s*=\s*"([^"]+)"', tag, re.IGNORECASE)
            if not id_m or not id_re.search(id_m.group(1)):
                continue
            id_value = id_m.group(1)

        end = find_matching_div_end(html, m.start())
        blocks.append((html[m.start():end], id_value))
    return blocks


def extract_date_groups(html: str) -> List[Tuple[str, str]]:
    out: List[Tuple[str, str]] = []
    seen = set()

    # Preferred path: old/known container classes with date in id.
    for block, raw_id in extract_div_blocks(
        html,
        ["fa-content-card", "rdate-cat"],
        id_pattern=r"^date-(\d{4}-\d{2}-\d{2}|\d{8})$",
    ):
        if not raw_id:
            continue
        release_raw = raw_id.replace("date-", "", 1)
        if re.fullmatch(r"\d{8}", release_raw):
            release_raw = f"{release_raw[0:4]}-{release_raw[4:6]}-{release_raw[6:8]}"
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", release_raw) and (release_raw, block) not in seen:
            out.append((release_raw, block))
            seen.add((release_raw, block))

    if out:
        return out

    # Fallback path: accept any DIV with id="date-..." regardless of class tokens.
    any_date_div_re = re.compile(
        r'<div\b[^>]*\bid\s*=\s*"date-(\d{4}-\d{2}-\d{2}|\d{8})"[^>]*>',
        re.IGNORECASE,
    )
    for match in any_date_div_re.finditer(html):
        open_tag = match.group(0)
        release_raw = match.group(1)
        if re.fullmatch(r"\d{8}", release_raw):
            release_raw = f"{release_raw[0:4]}-{release_raw[4:6]}-{release_raw[6:8]}"
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", release_raw):
            continue
        end = find_matching_div_end(html, match.start())
        block = html[match.start():end]
        key = (release_raw, block)
        if key in seen:
            continue
        # Keep only blocks that look like they contain movies.
        if "movie-card" not in block:
            continue
        out.append((release_raw, block))
        seen.add(key)

    return out


def extract_people(card: str, class_name: str) -> List[Dict[str, Optional[str]]]:
    section = re.search(rf'<div[^>]*class="[^"]*{class_name}[^"]*"[^>]*>(.*?)</div>', card, re.IGNORECASE | re.DOTALL)
    if not section:
        return []
    people = []
    for href, name in re.findall(r'<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', section.group(1), re.IGNORECASE | re.DOTALL):
        clean_name = strip_html(name)
        if clean_name:
            people.append({"name": clean_name, "url": urljoin(FA_BASE, href)})
    return people


def parse_duration_min(card: str) -> Optional[int]:
    patterns = [
        r'class="[^"]*duration[^"]*"[^>]*>\s*(\d+)\s*min\.?',  # desktop and mobile variants
        r'(\d+)\s*min\.?',
    ]
    for pat in patterns:
        m = re.search(pat, card, re.IGNORECASE | re.DOTALL)
        if m:
            return parse_int(m.group(1))
    return None


def extract_movie_rows(group_html: str, release_date: str) -> List[Dict[str, object]]:
    rows = []
    cards = extract_div_blocks(group_html, ["row", "movie-card"])
    if not cards:
        cards = extract_div_blocks(group_html, ["movie-card"])
    if not cards:
        # Last-resort fallback: any div carrying data-movie-id.
        for m in re.finditer(r'<div\b[^>]*data-movie-id="\d+"[^>]*>', group_html, re.IGNORECASE):
            end = find_matching_div_end(group_html, m.start())
            cards.append((group_html[m.start():end], None))

    for card, _ in cards:
        movie_id_m = re.search(r'data-movie-id="(\d+)"', card)
        movie_id = movie_id_m.group(1) if movie_id_m else ""

        title_m = re.search(r'<div class="fs-6 mc-title">.*?<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', card, re.IGNORECASE | re.DOTALL)
        if not title_m:
            title_m = re.search(r'<a[^>]*href="([^"]*film\d+\.html[^"]*)"[^>]*>(.*?)</a>', card, re.IGNORECASE | re.DOTALL)
        if not title_m:
            title_m = re.search(r'<a[^>]*href="([^"]+)"[^>]*class="[^"]*mc-title[^"]*"[^>]*>(.*?)</a>', card, re.IGNORECASE | re.DOTALL)
        filmaffinity_url = urljoin(FA_BASE, title_m.group(1)) if title_m else None
        title = strip_html(title_m.group(2)) if title_m else ""

        data_srcset_m = re.search(r'data-srcset="([^"]+)"', card, re.IGNORECASE)
        srcset_m = re.search(r'srcset="([^"]+)"', card, re.IGNORECASE)
        src_m = re.search(r'\ssrc="([^"]+)"', card, re.IGNORECASE)
        if data_srcset_m:
            poster_url = split_srcset(data_srcset_m.group(1))
        elif srcset_m:
            poster_url = split_srcset(srcset_m.group(1))
        elif src_m:
            poster_url = urljoin(FA_BASE, src_m.group(1))
        else:
            poster_url = None

        duration_min = parse_duration_min(card)
        genres = [strip_html(x) for x in re.findall(r'<span class="type">(.*?)</span>', card, re.IGNORECASE | re.DOTALL)]
        genres = [g for g in genres if g]

        country_code_m = re.search(r'/imgs/countries2/([A-Za-z]{2})\.png', card)
        country_code = country_code_m.group(1).upper() if country_code_m else None

        year_m = re.search(r'<span class="mc-year[^"]*">\s*(\d{4})', card, re.IGNORECASE)
        year = parse_int(year_m.group(1) if year_m else None)

        synopsis_m = re.search(r'<div class="text-secondary synop"[^>]*>(.*?)</div>', card, re.IGNORECASE | re.DOTALL)
        synopsis_short = strip_html(synopsis_m.group(1)) if synopsis_m else ""

        directors = extract_people(card, "mc-director")
        cast_top = extract_people(card, "mc-cast")

        theaters_m = re.search(r'href="([^"]*cityTheaters[^"]*)"[^>]*>.*?<span[^>]*class="[^"]*badge[^\"]*text-bg-light[^\"]*"[^>]*>(\d+)</span>', card, re.IGNORECASE | re.DOTALL)
        if not theaters_m:
            theaters_m = re.search(r'href="([^"]*cityTheaters[^"]*)"[^>]*>.*?<span[^>]*class="[^"]*badge[^"]*"[^>]*>(\d+)</span>', card, re.IGNORECASE | re.DOTALL)
        theaters_url = urljoin(FA_BASE, theaters_m.group(1)) if theaters_m else None
        theaters_count = parse_int(theaters_m.group(2) if theaters_m else None)

        trailer_available = bool(re.search(r'play-trailer', card, re.IGNORECASE))

        avg_m = re.search(r'<div class="avg[^"]*">\s*([\d,.-]+|--)', card, re.IGNORECASE)
        rating_avg = parse_float(avg_m.group(1) if avg_m else None)

        ratcount_m = re.search(r'class="[^"]*ratcount[^"]*"[^>]*>(.*?)</', card, re.IGNORECASE | re.DOTALL)
        rating_count = parse_int(strip_html(ratcount_m.group(1)) if ratcount_m else None)

        rows.append({
            "movie_id": movie_id,
            "release_date": release_date,
            "title": title,
            "filmaffinity_url": filmaffinity_url,
            "poster_url": poster_url,
            "duration_min": duration_min,
            "year": year,
            "country_code": country_code,
            "genres": json.dumps(genres, ensure_ascii=False),
            "synopsis_short": synopsis_short,
            "director": json.dumps(directors, ensure_ascii=False),
            "cast_top": json.dumps(cast_top, ensure_ascii=False),
            "rating_avg": rating_avg,
            "rating_count": rating_count,
            "theaters_count": theaters_count,
            "theaters_url": theaters_url,
            "trailer_available": trailer_available,
            "scraped_at": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        })

    return rows


def metrics_from_html(html: str) -> Tuple[Set[str], Optional[date], int]:
    groups = extract_date_groups(html)
    ids = set(re.findall(r'data-movie-id="(\d+)"', html))
    max_date = None
    for release_str, _ in groups:
        rel = datetime.strptime(release_str, "%Y-%m-%d").date()
        if max_date is None or rel > max_date:
            max_date = rel
    return ids, max_date, len(groups)


def load_html_with_scroll(window_end: date, max_stale_scrolls: int) -> str:
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60000)

        try:
            page.click("#accept-btn", timeout=2500)
            page.wait_for_timeout(500)
        except PlaywrightTimeoutError:
            pass

        stale = 0
        seen_ids: Set[str] = set()
        prev_group_count = 0

        while stale < max_stale_scrolls:
            html = page.content()
            ids, max_loaded_date, group_count = metrics_from_html(html)
            new_ids = ids - seen_ids
            if new_ids:
                seen_ids.update(new_ids)
                stale = 0
            else:
                stale += 1

            if max_loaded_date and max_loaded_date > window_end:
                break

            current_height = page.evaluate("document.body.scrollHeight")
            page.evaluate("window.scrollBy(0, Math.max(600, window.innerHeight * 0.75));")

            try:
                page.wait_for_function(
                    "(prevGroups, prevHeight) => document.querySelectorAll('.fa-content-card.rdate-cat').length > prevGroups || document.body.scrollHeight > prevHeight",
                    arg=[group_count, current_height],
                    timeout=3000,
                )
            except PlaywrightTimeoutError:
                page.wait_for_timeout(900)

            # extra nudge to trigger lazy loading
            page.evaluate("window.scrollBy(0, 220);")
            page.wait_for_timeout(350)

            if group_count > prev_group_count:
                prev_group_count = group_count

            # If we haven't reached the end of requested window, keep trying even when no new groups once.
            if max_loaded_date is None or max_loaded_date < window_end:
                continue

        final_html = page.content()
        browser.close()
        return final_html


def scrape_window(start: date, end: date, max_stale_scrolls: int, no_browser: bool) -> List[Dict[str, object]]:
    if no_browser:
        html = fetch_page(BASE_URL)
    else:
        html = load_html_with_scroll(end, max_stale_scrolls)

    all_rows: Dict[Tuple[str, str], Dict[str, object]] = {}
    for release_str, group_html in extract_date_groups(html):
        release_date = datetime.strptime(release_str, "%Y-%m-%d").date()
        if not (start <= release_date <= end):
            continue
        for row in extract_movie_rows(group_html, release_str):
            key = (str(row.get("movie_id", "")), str(row.get("release_date", "")))
            all_rows[key] = row
    return list(all_rows.values())


def read_existing(path: Path) -> Dict[Tuple[str, str], Dict[str, object]]:
    if not path.exists():
        return {}
    out = {}
    with path.open("r", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            out[(row.get("movie_id", ""), row.get("release_date", ""))] = row
    return out


def backup_file(path: Path, keep: int) -> None:
    if not path.exists():
        return
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    copy = BACKUP_DIR / f"film_affinity_upcoming_releases_{stamp}.csv"
    shutil.copy2(path, copy)
    files = sorted(BACKUP_DIR.glob("film_affinity_upcoming_releases_*.csv"))
    while len(files) > keep:
        files.pop(0).unlink(missing_ok=True)


def merge(existing: Dict[Tuple[str, str], Dict[str, object]], fresh: List[Dict[str, object]]) -> Tuple[int, int]:
    added = 0
    updated = 0
    for row in fresh:
        key = (str(row.get("movie_id", "")), str(row.get("release_date", "")))
        normalized = {k: "" if v is None else v for k, v in row.items()}
        if key not in existing:
            existing[key] = normalized
            added += 1
        elif any(str(existing[key].get(k, "")) != str(v) for k, v in normalized.items()):
            existing[key] = normalized
            updated += 1
    return added, updated


def write_canonical(path: Path, rows: Dict[Tuple[str, str], Dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "movie_id", "release_date", "title", "filmaffinity_url", "poster_url", "duration_min", "year",
        "country_code", "genres", "synopsis_short", "director", "cast_top", "rating_avg", "rating_count",
        "theaters_count", "theaters_url", "trailer_available", "scraped_at",
    ]
    sorted_rows = sorted(rows.values(), key=lambda r: (r.get("release_date", ""), r.get("title", "")))
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(sorted_rows)


def filter_rows_not_before(existing: Dict[Tuple[str, str], Dict[str, object]], start: date) -> Dict[Tuple[str, str], Dict[str, object]]:
    """Drop entries older than the current scrape window start date."""
    kept: Dict[Tuple[str, str], Dict[str, object]] = {}
    for key, row in existing.items():
        release_str = str(row.get("release_date", "")).strip()
        try:
            release_date = datetime.strptime(release_str, "%Y-%m-%d").date()
        except ValueError:
            continue
        if release_date >= start:
            kept[key] = row
    return kept


def main() -> None:
    args = parse_args()
    if args.months_ahead < 1:
        raise ValueError("--months-ahead must be >= 1")

    start = datetime.strptime(args.start_date, "%Y-%m-%d").date() if args.start_date else date.today()
    end = add_months(start, args.months_ahead)

    try:
        scraped = scrape_window(start, end, args.max_stale_scrolls, args.no_browser)
    except ModuleNotFoundError as exc:
        print(f"Scraper runtime warning: {exc}")
        print("Retrying without browser automation...")
        try:
            scraped = scrape_window(start, end, args.max_stale_scrolls, no_browser=True)
        except URLError as fallback_exc:
            print(f"Scraper runtime warning: {fallback_exc}")
            scraped = []
    except URLError as exc:
        print(f"Scraper runtime warning: {exc}")
        scraped = []

    if not scraped:
        print("❌ No upcoming releases were scraped. Canonical CSV was left unchanged.")
        sys.exit(1)

    existing = read_existing(CANONICAL_PATH)
    existing = filter_rows_not_before(existing, start)
    added, updated = merge(existing, scraped)
    backup_file(CANONICAL_PATH, args.backup_keep)
    write_canonical(CANONICAL_PATH, existing)

    print(f"Window: {start} -> {end}")
    print(f"Scraped rows in window: {len(scraped)}")
    print(f"Added: {added} | Updated: {updated} | Canonical rows: {len(existing)}")
    print(f"Saved to: {CANONICAL_PATH}")


if __name__ == "__main__":
    main()
