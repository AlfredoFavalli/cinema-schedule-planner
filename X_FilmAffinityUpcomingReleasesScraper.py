import argparse
import csv
import json
import re
import shutil
from datetime import date, datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.error import URLError
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen

BASE_URL = "https://www.filmaffinity.com/es/rdcat.php?id=upc_th_es"
FA_BASE = "https://www.filmaffinity.com"
CANONICAL_PATH = Path("0_data/filmAffinity_upcoming_releases.csv")
BACKUP_DIR = Path("0_data/backups")


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
    return parser.parse_args()


def normalize(value: Optional[str]) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def parse_int(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    digits = re.sub(r"[^\d]", "", str(value))
    return int(digits) if digits else None


def parse_float(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    if "--" in value:
        return None
    match = re.search(r"\d+(?:[\.,]\d+)?", value)
    if not match:
        return None
    return float(match.group(0).replace(",", "."))


def split_srcset(srcset: str) -> Optional[str]:
    best_url = None
    best_width = -1
    for part in srcset.split(','):
        bits = part.strip().split()
        if not bits:
            continue
        cand = bits[0]
        width = 0
        if len(bits) > 1 and bits[1].endswith('w'):
            try:
                width = int(bits[1][:-1])
            except ValueError:
                width = 0
        if width >= best_width:
            best_width = width
            best_url = cand
    return urljoin(FA_BASE, best_url) if best_url else None


def fetch_page(url: str) -> str:
    req = Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urlopen(req, timeout=30) as resp:
        return resp.read().decode('utf-8', errors='replace')


def extract_date_groups(html: str) -> List[Tuple[str, str]]:
    groups = []
    pattern = re.compile(r'(<div class="fa-content-card rdate-cat" id="date-(\d{4}-\d{2}-\d{2})".*?</div>\s*</div>)', re.DOTALL)
    for block, date_str in pattern.findall(html):
        groups.append((date_str, block))
    return groups


def extract_people(block: str, css_hint: str) -> List[Dict[str, Optional[str]]]:
    section = re.search(rf'<div[^>]*class="[^"]*{css_hint}[^"]*"[^>]*>(.*?)</div>', block, re.DOTALL)
    if not section:
        return []
    people = []
    for href, name in re.findall(r'<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', section.group(1), re.DOTALL):
        clean_name = normalize(re.sub(r'<[^>]+>', ' ', name))
        if clean_name:
            people.append({'name': clean_name, 'url': urljoin(FA_BASE, href)})
    return people


def extract_movie_rows(group_html: str, release_date: str) -> List[Dict[str, object]]:
    rows = []
    for card in re.findall(r'(<div[^>]*class="[^"]*row movie-card[^"]*"[^>]*>.*?</div>\s*</div>)', group_html, re.DOTALL):
        movie_id = normalize(re.search(r'data-movie-id="([^"]+)"', card).group(1) if re.search(r'data-movie-id="([^"]+)"', card) else '')
        title_match = re.search(r'class="[^"]*mc-title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', card, re.DOTALL)
        film_url = urljoin(FA_BASE, title_match.group(1)) if title_match else None
        title = normalize(re.sub(r'<[^>]+>', ' ', title_match.group(2) if title_match else ''))

        srcset_match = re.search(r'(?:data-srcset|srcset)="([^"]+)"', card)
        src_match = re.search(r'(?:data-src|src)="([^"]+)"', card)
        poster_url = split_srcset(srcset_match.group(1)) if srcset_match else (urljoin(FA_BASE, src_match.group(1)) if src_match else None)

        runtime = parse_int(re.search(r'(\d+)\s*min', card, re.IGNORECASE).group(1) if re.search(r'(\d+)\s*min', card, re.IGNORECASE) else None)
        year = parse_int(re.search(r'\b(19|20)\d{2}\b', card).group(0) if re.search(r'\b(19|20)\d{2}\b', card) else None)

        country_code = None
        cc = re.search(r'/imgs/countries2/([A-Za-z]{2})\.png', card)
        if cc:
            country_code = cc.group(1).upper()

        genres = [normalize(re.sub(r'<[^>]+>', ' ', g)) for g in re.findall(r'<[^>]*class="[^"]*type[^"]*"[^>]*>(.*?)</', card, re.DOTALL)]
        synopsis = normalize(re.sub(r'<[^>]+>', ' ', re.search(r'class="[^"]*synopsis[^"]*"[^>]*>(.*?)</', card, re.DOTALL).group(1) if re.search(r'class="[^"]*synopsis[^"]*"[^>]*>(.*?)</', card, re.DOTALL) else ''))

        director = extract_people(card, 'direct')
        cast_top = extract_people(card, 'cast')

        rating_avg = parse_float(re.search(r'class="[^"]*avgrat[^"]*"[^>]*>(.*?)</', card, re.DOTALL).group(1) if re.search(r'class="[^"]*avgrat[^"]*"[^>]*>(.*?)</', card, re.DOTALL) else None)
        rating_count = parse_int(re.search(r'class="[^"]*ratcount[^"]*"[^>]*>(.*?)</', card, re.DOTALL).group(1) if re.search(r'class="[^"]*ratcount[^"]*"[^>]*>(.*?)</', card, re.DOTALL) else None)

        theaters_match = re.search(r'<a[^>]*href="([^"]*cityTheaters[^"]*)"[^>]*>(.*?)</a>', card, re.DOTALL | re.IGNORECASE)
        theaters_url = urljoin(FA_BASE, theaters_match.group(1)) if theaters_match else None
        theaters_count = parse_int(theaters_match.group(2) if theaters_match else None)

        trailer_available = bool(re.search(r'trailer', card, re.IGNORECASE))

        rows.append({
            'movie_id': movie_id,
            'release_date': release_date,
            'title': title,
            'filmaffinity_url': film_url,
            'poster_url': poster_url,
            'duration_min': runtime,
            'year': year,
            'country_code': country_code,
            'genres': json.dumps([g for g in genres if g], ensure_ascii=False),
            'synopsis_short': synopsis,
            'director': json.dumps(director, ensure_ascii=False),
            'cast_top': json.dumps(cast_top, ensure_ascii=False),
            'rating_avg': rating_avg,
            'rating_count': rating_count,
            'theaters_count': theaters_count,
            'theaters_url': theaters_url,
            'trailer_available': trailer_available,
            'scraped_at': datetime.utcnow().isoformat(timespec='seconds') + 'Z',
        })
    return rows


def scrape_window(start: date, end: date, max_stale_scrolls: int) -> List[Dict[str, object]]:
    all_rows: Dict[Tuple[str, str], Dict[str, object]] = {}
    stale = 0
    offset = 0

    # Consent is browser-managed; for HTTP scraping we keep this step explicit/no-op.
    accepted_banner = False

    while stale < max_stale_scrolls:
        url = BASE_URL if offset == 0 else f"{BASE_URL}&{urlencode({'offset': offset})}"
        html = fetch_page(url)

        if not accepted_banner and 'id="accept-btn"' in html:
            accepted_banner = True

        groups = extract_date_groups(html)
        if not groups:
            stale += 1
            offset += 1
            continue

        newest_seen = None
        before = len(all_rows)
        for release_str, block in groups:
            release = datetime.strptime(release_str, '%Y-%m-%d').date()
            newest_seen = release if newest_seen is None or release > newest_seen else newest_seen
            if not (start <= release <= end):
                continue
            for row in extract_movie_rows(block, release_str):
                key = (str(row.get('movie_id', '')), str(row.get('release_date', '')))
                all_rows[key] = row

        if newest_seen and newest_seen > end:
            break

        stale = stale + 1 if len(all_rows) == before else 0
        offset += 1

    return list(all_rows.values())


def read_existing(path: Path) -> Dict[Tuple[str, str], Dict[str, object]]:
    if not path.exists():
        return {}
    out = {}
    with path.open('r', encoding='utf-8', newline='') as fh:
        for row in csv.DictReader(fh):
            out[(row.get('movie_id', ''), row.get('release_date', ''))] = row
    return out


def backup_file(path: Path, keep: int) -> None:
    if not path.exists():
        return
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    copy = BACKUP_DIR / f'filmAffinity_upcoming_releases_{stamp}.csv'
    shutil.copy2(path, copy)
    files = sorted(BACKUP_DIR.glob('filmAffinity_upcoming_releases_*.csv'))
    while len(files) > keep:
        files.pop(0).unlink(missing_ok=True)


def merge(existing: Dict[Tuple[str, str], Dict[str, object]], fresh: List[Dict[str, object]]) -> Tuple[int, int]:
    added = 0
    updated = 0
    for row in fresh:
        key = (str(row.get('movie_id', '')), str(row.get('release_date', '')))
        normalized = {k: '' if v is None else v for k, v in row.items()}
        if key not in existing:
            existing[key] = normalized
            added += 1
        elif any(str(existing[key].get(k, '')) != str(v) for k, v in normalized.items()):
            existing[key] = normalized
            updated += 1
    return added, updated


def write_canonical(path: Path, rows: Dict[Tuple[str, str], Dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        'movie_id', 'release_date', 'title', 'filmaffinity_url', 'poster_url', 'duration_min', 'year',
        'country_code', 'genres', 'synopsis_short', 'director', 'cast_top', 'rating_avg', 'rating_count',
        'theaters_count', 'theaters_url', 'trailer_available', 'scraped_at',
    ]
    sorted_rows = sorted(rows.values(), key=lambda r: (r.get('release_date', ''), r.get('title', '')))
    with path.open('w', encoding='utf-8', newline='') as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(sorted_rows)


def main() -> None:
    args = parse_args()
    start = date.today()
    end = add_months(start, 2)

    try:
        scraped = scrape_window(start, end, args.max_stale_scrolls)
    except URLError as exc:
        print(f"Network error while scraping: {exc}")
        scraped = []

    existing = read_existing(CANONICAL_PATH)
    added, updated = merge(existing, scraped)
    backup_file(CANONICAL_PATH, args.backup_keep)
    write_canonical(CANONICAL_PATH, existing)

    print(f"Window: {start} -> {end}")
    print(f"Scraped rows in window: {len(scraped)}")
    print(f"Added: {added} | Updated: {updated} | Canonical rows: {len(existing)}")
    print(f"Saved to: {CANONICAL_PATH}")


if __name__ == '__main__':
    main()
