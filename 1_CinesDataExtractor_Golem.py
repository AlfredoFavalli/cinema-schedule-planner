import os
import shutil
import requests
from bs4 import BeautifulSoup
import pandas as pd
import locale
from datetime import datetime
from tqdm import tqdm  # For progress bar
from urllib.parse import urljoin

class GolemScraper:
    def __init__(self, base_url, days_in_advance=10):
        self.base_url = base_url
        self.days_in_advance = days_in_advance
        self.data = []
        self.cine_name = "Golem Madrid"

    @staticmethod
    def _normalize_url(base_url, raw_url):
        if not raw_url:
            return None
        return urljoin(base_url, raw_url.strip())

    def _extract_poster_url(self, soup, details_url):
        """Extracts the movie poster URL from ticket detail page table cells."""
        poster_img = None

        # Prefer poster-like paths used by Golem (e.g. /golem/carteles/*.jpg).
        for img in soup.select('td img[src]'):
            src = img.get('src', '').strip()
            if 'carteles' in src.lower():
                poster_img = img
                break

        # Fallback: first image found inside a table cell.
        if not poster_img:
            poster_img = soup.select_one('td img[src]')

        if not poster_img:
            return None

        return self._normalize_url(details_url, poster_img.get('src'))

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
        """Fetches movie details for a specific performance code (Golem Madrid)."""
        details_url = (
            f"https://www.onlinecinematickets.com/index.php?"
            f"s=GOLMADRID&p=tickets&perfCode={perf_code}"
        )

        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/126.0.0.0 Safari/537.36"
            ),
            "Referer": self.base_url,
        }

        try:
            response = requests.get(details_url, headers=headers, timeout=15)
        except Exception as e:
            print(f"[WARN] Request error for perfCode {perf_code}: {e}")
            return None

        if response.status_code != 200:
            print(
                f"[WARN] Non-200 status for perfCode {perf_code}: "
                f"{response.status_code} – skipping."
            )
            return None

        soup = BeautifulSoup(response.content, "html.parser")
        poster_url = self._extract_poster_url(soup, details_url)

        # --- 1) TEXT-BASED PARSE (works with new layout) -------------------------
        page_text = soup.get_text("\n", strip=True)
        lines = [l.strip() for l in page_text.splitlines() if l.strip()]

        title = None
        sala_line = None
        datetime_line = None

        # Look for a line like "GOLEM MADRID | Sala 02"
        sala_index = None
        for i, line in enumerate(lines):
            if "Sala" in line and "|" in line:
                sala_index = i
                sala_line = line
                break

        if sala_index is not None:
            # Previous line is usually the movie title
            if sala_index > 0:
                title = lines[sala_index - 1]

            # Next line is usually "Domingo 16 noviembre 2025 | 19:30"
            if sala_index + 1 < len(lines):
                datetime_line = lines[sala_index + 1]

        # If we couldn't find the basic pattern, skip this perfCode
        if not sala_line or not datetime_line:
            print(f"[WARN] Could not parse basic info from text for perfCode {perf_code} – skipping.")
            return None

        # --- 2) Parse Sala -------------------------------------------------------
        # Example: "GOLEM MADRID | Sala 02"
        sala = None
        try:
            # Split on "|" and take the part containing "Sala"
            parts = [p.strip() for p in sala_line.split("|")]
            sala_part = next((p for p in parts if "Sala" in p), None)
            if sala_part:
                # Keep just the number / name after "Sala"
                sala = sala_part.split("Sala", 1)[-1].strip()
        except Exception:
            sala = None

        # --- 3) Parse Fecha + Horario -------------------------------------------
        # Example: "Domingo 16 noviembre 2025 | 19:30"
        horario = None
        fecha = None
        try:
            dt_parts = [p.strip() for p in datetime_line.split("|")]
            date_part = dt_parts[0] if len(dt_parts) > 0 else None
            time_part = dt_parts[1] if len(dt_parts) > 1 else None

            horario = time_part

            if date_part:
                try:
                    fecha = self.format_date(date_part)
                except Exception as e:
                    # If we can't normalize, keep the raw string
                    print(f"[WARN] Error parsing date '{date_part}' for perfCode {perf_code}: {e}")
                    fecha = date_part
        except Exception as e:
            print(f"[WARN] Error parsing datetime for perfCode {perf_code}: {e}")

        # --- 4) Duration (not visible in snippet; keep None for now) ------------
        duracion = None  # Adjust later if you find where duration lives in the new layout

        # --- 5) Fallback title cleaning -----------------------------------------
        if title:
            # Avoid using generic header texts as title if something weird happened
            for bad in ("Golem Madrid", "GOLEM MADRID", "Menú", "Seleccione el idioma"):
                if bad.lower() in title.lower():
                    title = None
                    break

        if not title:
            # Last-resort title guess: find first line that looks like "X (VOSE)" or similar
            for l in lines:
                if "(VOSE" in l or "(VOSC" in l or "(V.O" in l or "(VO " in l:
                    title = l
                    break

        if not title:
            print(f"[WARN] Could not determine movie title for perfCode {perf_code} – skipping.")
            return None

        # --- 6) Return parsed record --------------------------------------------
        return {
            "Pelicula": title,
            "Director": None,
            "Duración": duracion,
            "Poster_URL": poster_url,
            "Sala": sala,
            "Horario": horario,
            "Fecha": fecha,
            "Cine": self.cine_name,
        }

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
        archive_dir = os.path.join(data_dir, '_0_archive', '_2_golem')
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
        print(f"Data saved to {filename}")


if __name__ == "__main__":
    base_url = "https://golem.es/golem/golem-madrid"
    scraper = GolemScraper(base_url, days_in_advance=7)
    scraper.scrape_for_date_range()
    scraper.save_to_csv("_1_data/cines_golem")
