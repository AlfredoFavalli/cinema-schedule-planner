import os
import json
import shutil
import requests
from bs4 import BeautifulSoup
import pandas as pd
import locale
from datetime import datetime
from tqdm import tqdm  # For progress bar
from collections import Counter
from urllib.parse import urljoin
import unicodedata
import re

class GolemScraper:
    def __init__(self, base_url, days_in_advance=10):
        self.base_url = base_url
        self.days_in_advance = days_in_advance
        self.data = []
        self.cine_name = "Golem Madrid"
        self.movie_cache = {}

    def build_movie_slug(self, title):
        import unicodedata, re

        s = unicodedata.normalize("NFKD", title)
        s = s.encode("ascii", "ignore").decode("ascii")

        s = s.replace("(VOSE)", "(V.O.S.E.)")
        s = s.replace("(VOSC)", "(V.O.S.C.)")

        s = s.replace(" ", "-")
        s = re.sub(r"-{2,}", "-", s)

        return f"/golem/pelicula/{s}"

    def extract_movie_page_url(self, soup):
        """Finds the /golem/pelicula/... link from a performance page."""
        a = soup.find("a", href=lambda h: h and h.startswith("/golem/pelicula/"))
        return a["href"] if a else None

    def fetch_perf_codes(self, date):
        """Fetches performance codes for a specific date."""
        url = f"{self.base_url}/{date.replace('-', '')}"
        response = requests.get(url)
        if response.status_code != 200:
            raise Exception(f"Failed to fetch performance codes for {date}: {response.status_code}")

        soup = BeautifulSoup(response.content, 'html.parser')
        perf_codes = {
            a['href'].split('perfCode=')[1].split('&')[0]
            for a in soup.find_all('a', href=True) if 'perfCode' in a['href']
        }
        return list(perf_codes)

    def fetch_movie_details(self, perf_code):
        details_url = (
            "https://www.onlinecinematickets.com/index.php"
            f"?s=GOLMADRID&p=tickets&perfCode={perf_code}"
        )

        r = requests.get(details_url, timeout=15)
        if r.status_code != 200:
            return None

        soup = BeautifulSoup(r.content, "html.parser")
        text = soup.get_text("\n", strip=True)
        lines = [l.strip() for l in text.splitlines() if l.strip()]

        title = None
        sala_line = None
        datetime_line = None

        for i, line in enumerate(lines):
            if "Sala" in line and "|" in line:
                sala_line = line
                if i > 0:
                    title = lines[i - 1]
                if i + 1 < len(lines):
                    datetime_line = lines[i + 1]
                break

        if not title or not datetime_line:
            return None

        parts = datetime_line.split("|")
        fecha = self.format_date(parts[0].strip())
        horario = parts[1].strip() if len(parts) > 1 else None

        sala = sala_line.split("Sala", 1)[-1].strip()

        # 🔑 build movie slug from title
        movie_slug = self.build_movie_slug(title)
        movie_page_details = self.fetch_movie_page_details(movie_slug)

        record = {
            "Pelicula": title,
            "Sala": sala,
            "Horario": horario,
            "Fecha": fecha,
            "Cine": self.cine_name,
        }

        record.update(movie_page_details)
        return record

    def fetch_movie_page_details(self, relative_url):
        if not relative_url:
            return {}

        if relative_url in self.movie_cache:
            return self.movie_cache[relative_url]

        full_url = urljoin("https://golem.es", relative_url)
        print("🔍 Fetching movie page:", full_url)

        r = requests.get(full_url, timeout=15)
        if r.status_code != 200:
            print("❌ Movie page not found:", full_url)
            return {}

        soup = BeautifulSoup(r.content, "html.parser")

        # -------------------------------
        # Helper: read ficha técnica rows
        # -------------------------------
        def find_value(label):
            td = soup.find("td", string=lambda t: t and label in t)
            if not td:
                return None
            sibling = td.find_next_sibling("td")
            return sibling.get_text(" ", strip=True) if sibling else None

        # -------------------------------
        # Poster
        # -------------------------------
        img = soup.find("img", src=lambda s: s and "/golem/carteles/" in s)
        poster_url = urljoin("https://golem.es", img["src"]) if img else None

        # -------------------------------
        # Trailer (YouTube iframe)
        # -------------------------------
        trailer_url = None
        iframe = soup.find("iframe", src=lambda s: s and "youtube.com" in s)
        if iframe:
            trailer_url = iframe["src"]

        # -------------------------------
        # Ficha Artística (Reparto)
        # -------------------------------
        reparto = None
        ficha_label = soup.find("strong", string=lambda t: t and "Ficha Artística" in t)

        if ficha_label:
            tr = ficha_label.find_parent("tr")
            if tr:
                next_tr = tr.find_next_sibling("tr")
                if next_tr:
                    td = next_tr.find("td", class_="txtLectura")
                    if td:
                        reparto = td.get_text(" ", strip=True)

        # -------------------------------
        # Sinopsis (Golem layout)
        # -------------------------------
        sinopsis = None
        sin_label = soup.find("strong", string=lambda t: t and "Sinopsis" in t)

        if sin_label:
            tr = sin_label.find_parent("tr")
            if tr:
                next_tr = tr.find_next_sibling("tr")
                if next_tr:
                    td = next_tr.find("td", class_="txtNegLJust")
                    if td:
                        sinopsis = td.get_text(" ", strip=True)

        # -------------------------------
        # Final payload
        # -------------------------------
        details = {
            "Pelicula_URL": full_url,
            "Titulo_Original": find_value("Título original"),
            "Director": find_value("Dirigida por"),
            "Duración": find_value("Duración"),
            "Nacionalidad": find_value("Nacionalidad"),
            "Reparto": reparto,
            "Sinopsis": sinopsis,
            "Trailer_URL": trailer_url,
            "Poster_URL": poster_url,
        }

        self.movie_cache[relative_url] = details
        return details

    @staticmethod
    def format_date(raw_date):
        """Converts a raw date string like 'sábado 21 diciembre 2024' to 'YYYY-MM-DD'."""
        try:
            # Set the locale to Spanish for parsing Spanish date strings
            locale.setlocale(locale.LC_TIME, 'es_ES.UTF-8')  # Use 'es_ES' for Spanish locale
            date_obj = datetime.strptime(raw_date, '%A %d %B %Y')  # Attempt to parse the raw date
            return date_obj.strftime('%Y-%m-%d')
        except ValueError as e:
            print(f"Error parsing date: {e}")
            return raw_date  # Return as-is if parsing fails
        finally:
            # Reset to the default locale to avoid affecting other parts of the script
            locale.setlocale(locale.LC_TIME, '')

    def scrape_for_date_range(self):
        """Scrapes the website for today's date and the specified number of days in advance."""
        today = pd.Timestamp.today()
        for i in range(self.days_in_advance + 1):
            date = (today + pd.Timedelta(days=i)).strftime('%Y-%m-%d')
            print(f"Scraping data for {self.cine_name} on {date}...")
            try:
                perf_codes = self.fetch_perf_codes(date)
                with tqdm(total=len(perf_codes), desc=f"Processing {date}") as pbar:
                    for perf_code in perf_codes:
                        try:
                            movie_details = self.fetch_movie_details(perf_code)
                            if movie_details:  # Only append if we actually got data
                                self.data.append(movie_details)
                        except Exception as e:
                            print(f"Error fetching details for perfCode {perf_code}: {e}")
                        pbar.update(1)
            except Exception as e:
                print(f"Error scraping for {date}: {e}")

    def save_to_csv(self, filename_prefix):
        """Saves the extracted data to a CSV file with today's date and time appended to the filename."""
        now = datetime.now().strftime('%Y-%m-%d_%H-%M')
        filename = f"{filename_prefix}_{now}.csv"
        data_dir = os.path.dirname(filename_prefix)  # Extract the directory from the prefix
        base_prefix = os.path.basename(filename_prefix)  # Extract the actual prefix without directories

        # Ensure the archive directory exists
        archive_dir = os.path.join(data_dir, 'archive', 'golem')
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

        manifest['golem'] = os.path.basename(filename)
        with open(manifest_path, 'w', encoding='utf-8') as manifest_file:
            json.dump(manifest, manifest_file, ensure_ascii=False, indent=2)

        print(f"Data saved to {filename}")
        print(f"Manifest updated at {manifest_path}")


if __name__ == "__main__":
    base_url = "https://golem.es/golem/golem-madrid"
    scraper = GolemScraper(base_url, days_in_advance=7)
    scraper.scrape_for_date_range()
    scraper.save_to_csv("data/interim/cinema_sessions/cines_golem")
