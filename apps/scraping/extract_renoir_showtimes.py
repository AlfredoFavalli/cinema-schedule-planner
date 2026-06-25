import os
import json
import shutil
import re
import unicodedata
import requests
from bs4 import BeautifulSoup
import pandas as pd
from datetime import datetime, timedelta
from urllib.parse import urljoin

class CinesRenoirScraper:
    def __init__(self, base_urls, days_in_advance=1):
        self.base_urls = base_urls
        self.days_in_advance = days_in_advance
        self.soup = None
        self.data = []
        self.film_cache = {}  # NEW: avoid re-scraping same film
        self._seen_rows = set()

    def fetch_film_details(self, film_relative_url):
        """Fetches and parses a film detail page. Cached by URL."""
        if film_relative_url in self.film_cache:
            return self.film_cache[film_relative_url]

        film_url = urljoin("https://www.cinesrenoir.com", film_relative_url)
        r = requests.get(film_url, headers={
            'User-Agent': (
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
                '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'
            )
        }, timeout=30)
        if r.status_code != 200:
            return {}

        soup = BeautifulSoup(r.content, "html.parser")

        def normalize_label(value):
            text = self._clean_text(value).rstrip(':').casefold()
            return ''.join(
                char for char in unicodedata.normalize('NFD', text)
                if unicodedata.category(char) != 'Mn'
            )

        label_to_column = {
            "calificacion": "Calificación",
            "idioma original": "Idioma_Original",
            "estreno": "Estreno",
            "interpretes": "Intérpretes",
            "sinopsis": "Sinopsis",
        }

        def clean_detail_text(value):
            text = self._clean_text(value)
            text = re.sub(r'\[\+\s*ver[^\]]*\]', '', text, flags=re.I)
            return self._clean_text(text) or None

        def get_element_text(element):
            if not element:
                return None

            # Work on a detached fragment so removing labels/buttons does not
            # mutate the soup used by subsequent field extraction.
            fragment = BeautifulSoup(str(element), "html.parser")
            for unwanted in fragment.select("p.detalle-label, a, button, script, style"):
                unwanted.extract()
            return clean_detail_text(fragment.get_text(" ", strip=True))

        def get_following_value(label_element):
            if not label_element:
                return None

            for sibling in label_element.next_siblings:
                text = self._clean_text(
                    sibling.get_text(" ", strip=True)
                    if hasattr(sibling, "get_text")
                    else str(sibling)
                )
                value = clean_detail_text(text)
                if value:
                    return value
            return get_element_text(label_element.parent)

        def get_long_detail(block, complete_selector):
            # Desktop descriptions are not truncated. On mobile, Renoir keeps
            # the full text in hidden "*-completa" blocks and renders a short
            # teaser plus a "[+ ver ...]" expander separately.
            for selector in (".d-none.d-md-block", complete_selector):
                value = get_element_text(block.select_one(selector))
                if value:
                    return value
            return get_following_value(block.select_one("p.detalle-label"))

        detail_values = {
            "Idioma_Original": None,
            "Calificación": None,
            "Estreno": None,
            "Intérpretes": None,
            "Sinopsis": None,
        }
        detail_container = soup.select_one("div.single_product_desc") or soup
        for block in detail_container.select("div.short_overview.mb-4"):
            label_element = block.select_one("p.detalle-label")
            if not label_element:
                continue

            column = label_to_column.get(normalize_label(label_element.get_text(" ", strip=True)))
            if not column:
                continue

            if column == "Intérpretes":
                value = get_long_detail(block, ".interpretes-completa")
            elif column == "Sinopsis":
                value = get_long_detail(block, ".sinopsis-completa")
            else:
                value = get_following_value(label_element)

            if value and (not detail_values[column] or len(value) > len(detail_values[column])):
                detail_values[column] = value

        # Poster
        poster_img = soup.select_one(".single_product_thumb img")
        poster_url = (
            urljoin("https://www.cinesrenoir.com", poster_img["src"])
            if poster_img and poster_img.get("src")
            else None
        )

        details = {
            "Film_URL": film_url,
            "Poster_URL": poster_url,
            "Idioma_Original": detail_values["Idioma_Original"],
            "Calificación": detail_values["Calificación"],
            "Estreno": detail_values["Estreno"],
            "Intérpretes": detail_values["Intérpretes"],
            "Sinopsis": detail_values["Sinopsis"],
        }

        self.film_cache[film_relative_url] = details
        return details


    def fetch_page(self, url, date):
        """Fetches the webpage content for a specific date and parses it with BeautifulSoup."""
        full_url = f"{url}?fecha={date}"
        response = requests.get(full_url, headers={
            'User-Agent': (
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
                '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'
            )
        }, timeout=30)
        if response.status_code != 200:
            raise Exception(f"Failed to fetch page for {date}: {response.status_code}")

        self.soup = BeautifulSoup(response.content, 'html.parser')
        has_showtime_markup = self.soup.select_one(
            'a[href*="/pelicula/"], a[href*="/pase/"], a[href*="pillalas.com/pase"]'
        )
        if not has_showtime_markup:
            print(f"No Renoir showtimes found for {date}; skipping {full_url}")
            return False

        return True

    def _clean_text(self, value):
        return re.sub(r'\s+', ' ', value or '').strip()

    def _extract_duration(self, block):
        duration_text = block.find(string=re.compile(r'Duración\s+\d+', re.I))
        if not duration_text:
            return None
        match = re.search(r'Duración\s+(\d+)', self._clean_text(duration_text), re.I)
        return match.group(1) if match else None

    def _extract_director(self, movie_element, block):
        director_element = movie_element.find('small', style=lambda value: value and '#748294' in value)
        if director_element:
            return self._clean_text(director_element.get_text()).removeprefix('de ')

        director_text = block.find(string=re.compile(r'^\s*de\s+\S+', re.I))
        if director_text:
            return re.sub(r'^de\s+', '', self._clean_text(director_text), flags=re.I)
        return None

    def _extract_room(self, slot):
        room_text = slot.find(string=re.compile(r'sala\s*\d+', re.I))
        if not room_text:
            return None
        match = re.search(r'sala\s*(\d+)', self._clean_text(room_text), re.I)
        return match.group(1).zfill(2) if match else None

    def _extract_showtime_slots(self, block):
        links = block.select('a[href*="/pase/"], a[href*="pillalas.com/pase"], a.btn.btn-primary')
        for link in links:
            time_text = self._clean_text(link.get_text())
            if not re.fullmatch(r'\d{1,2}:\d{2}', time_text):
                continue

            slot = link.find_parent('div') or link.parent
            yield slot, link

    def extract_movie_data(self, cine_name, date):
        """Extracts movie data from the HTML."""
        movie_blocks = self.soup.select('div.my-account-content.mb-15')
        if not movie_blocks:
            movie_blocks = [link.find_parent('div', class_=lambda c: c and 'my-account-content' in c) for link in self.soup.select('a[href*="/pelicula/"]')]
            movie_blocks = [block for block in movie_blocks if block]

        for block in movie_blocks:
            movie_element = block.select_one('div.col-4.pl-0.pr-0') or block
            title_element = movie_element.select_one('a[href*="/pelicula/"]') or movie_element.find('a')
            film_relative_url = title_element.get('href') if title_element else None
            title = self._clean_text(title_element.get_text()) if title_element else None
            if not title:
                continue

            film_details = self.fetch_film_details(film_relative_url) if film_relative_url else {}
            director = self._extract_director(movie_element, block)
            duration = self._extract_duration(block)

            for slot, time_element in self._extract_showtime_slots(block):
                ticket_url = (
                    urljoin("https://www.pillalas.com", time_element.get('href'))
                    if time_element and time_element.get('href')
                    else None
                )
                room = self._extract_room(slot)
                time = self._clean_text(time_element.get_text()) if time_element else None
                key = (title, room, time, date, cine_name, ticket_url)
                if key in self._seen_rows:
                    continue
                self._seen_rows.add(key)

                row = {
                    'Pelicula': title,
                    'Director': director,
                    'Duración': duration,
                    'Sala': room,
                    'Horario': time,
                    'Fecha': date,
                    'Cine': cine_name,
                    'Tickets_URL': ticket_url,
                }

                row.update(film_details)
                self.data.append(row)

    def scrape_for_date_range(self):
        """Scrapes the website for today's date and the specified number of days in advance."""
        today = datetime.today()
        for url, cine_name in self.base_urls:
            for i in range(self.days_in_advance + 1):
                date = (today + timedelta(days=i)).strftime('%Y-%m-%d')
                print(f"Scraping data for {cine_name} on {date}...")
                if self.fetch_page(url, date):
                    self.extract_movie_data(cine_name, date)

    def save_to_csv(self, filename_prefix):
        """Saves the extracted data to a CSV file with today's date and time appended to the filename."""
        now = datetime.now().strftime('%Y-%m-%d_%H-%M')
        filename = f"{filename_prefix}_{now}.csv"
        data_dir = os.path.dirname(filename_prefix)  # Extract the directory from the prefix
        base_prefix = os.path.basename(filename_prefix)  # Extract the actual prefix without directories

        if not self.data:
            raise RuntimeError('Renoir scraper extracted 0 rows; refusing to overwrite the latest CSV with an empty file')

        # Ensure the archive directory exists
        archive_dir = os.path.join(data_dir, 'archive', 'renoir')
        os.makedirs(archive_dir, exist_ok=True)

        # Move existing files to the archive folder
        existing_files = [
            f for f in os.listdir(data_dir)
            if f.startswith(base_prefix) and f.endswith('.csv')
        ]
        for old_file in existing_files:
            old_file_path = os.path.join(data_dir, old_file)
            shutil.move(old_file_path, os.path.join(archive_dir, old_file))

        # Save the new file
        df = pd.DataFrame(self.data)
        df.to_csv(filename, index=False)

        # Update manifest with the latest CSV filenames
        manifest_path = os.path.join(data_dir, 'latest.json')
        manifest = {}
        if os.path.exists(manifest_path):
            try:
                with open(manifest_path, 'r', encoding='utf-8') as manifest_file:
                    manifest = json.load(manifest_file)
            except json.JSONDecodeError:
                manifest = {}

        manifest['renoir'] = os.path.basename(filename)
        with open(manifest_path, 'w', encoding='utf-8') as manifest_file:
            json.dump(manifest, manifest_file, ensure_ascii=False, indent=2)

        print(f"Data saved to {filename}")
        print(f"Manifest updated at {manifest_path}")


if __name__ == "__main__":
    base_urls = [
        ("https://www.cinesrenoir.com/cine/cines-princesa/cartelera/", "Renoir Princesa"),
        ("https://www.cinesrenoir.com/cine/renoir-plaza-de-espana/cartelera/", "Renoir Plaza de España")
    ]
    scraper = CinesRenoirScraper(base_urls, days_in_advance=10)

    scraper.scrape_for_date_range()
    scraper.save_to_csv("data/interim/cinema_sessions/cines_renoir")
