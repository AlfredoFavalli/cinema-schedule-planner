import os
import json
import shutil
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

    def fetch_film_details(self, film_relative_url):
        """Fetches and parses a film detail page. Cached by URL."""
        if film_relative_url in self.film_cache:
            return self.film_cache[film_relative_url]

        film_url = urljoin("https://www.cinesrenoir.com", film_relative_url)
        r = requests.get(film_url)
        if r.status_code != 200:
            return {}

        soup = BeautifulSoup(r.content, "html.parser")

        def get_text(label):
            h6 = soup.find("h6", string=label)
            if not h6:
                return None
            p = h6.find_next("p")
            return p.get_text(strip=True) if p else None

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
            "Idioma_Original": get_text("Idioma original"),
            "Calificación": get_text("Calificación"),
            "Estreno": get_text("Estreno"),
            "Intérpretes": get_text("Intérpretes"),
            "Sinopsis": get_text("Sinopsis"),
        }

        self.film_cache[film_relative_url] = details
        return details


    def fetch_page(self, url, date):
        """Fetches the webpage content for a specific date and parses it with BeautifulSoup."""
        full_url = f"{url}?fecha={date}"
        response = requests.get(full_url)
        if response.status_code == 200:
            self.soup = BeautifulSoup(response.content, 'html.parser')
        else:
            raise Exception(f"Failed to fetch page for {date}: {response.status_code}")

    def extract_movie_data(self, cine_name, date):
        """Extracts movie data from the HTML."""
        movie_blocks = self.soup.find_all('div', class_='my-account-content mb-15 d-none d-lg-block')

        for block in movie_blocks:
            # Extract movie details
            movie_element = block.find('div', class_='col-4 pl-0 pr-0')
            title_element = movie_element.find('a')
            film_relative_url = title_element["href"] if title_element else None
            title = title_element.text.strip() if title_element else None

            film_details = (
                self.fetch_film_details(film_relative_url)
                if film_relative_url
                else {}
            )
            director_element = movie_element.find('small', style="color:#748294")
            duration_element = movie_element.find(string=lambda t: 'Duración' in t)

            title = title_element.text.strip() if title_element else None
            director = director_element.text.strip().replace('de ', '') if director_element else None
            duration = duration_element.strip().replace('Duración ', '').replace(' minutos', '') if duration_element else None

            # Extract showtimes
            showtime_section = block.find('div', class_='col-7')
            time_slots = showtime_section.find_all('div', style="width: 80px; float: left; margin-right: 20px;")

            for slot in time_slots:
                room_element = slot.find('span', style="font-size:12px")
                time_element = slot.find('a', class_='btn btn-primary')
                ticket_url = (
                    urljoin("https://www.pillalas.com", time_element.get('href'))
                    if time_element and time_element.get('href')
                    else None
                )

                room = room_element.text.strip().replace('sala ', '') if room_element else None
                time = time_element.text.strip() if time_element else None

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
                self.fetch_page(url, date)
                self.extract_movie_data(cine_name, date)

    def save_to_csv(self, filename_prefix):
        """Saves the extracted data to a CSV file with today's date and time appended to the filename."""
        now = datetime.now().strftime('%Y-%m-%d_%H-%M')
        filename = f"{filename_prefix}_{now}.csv"
        data_dir = os.path.dirname(filename_prefix)  # Extract the directory from the prefix
        base_prefix = os.path.basename(filename_prefix)  # Extract the actual prefix without directories

        # Ensure the archive directory exists
        archive_dir = os.path.join(data_dir, '_0_archive', '_1_renoir')
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
    scraper.save_to_csv("_1_data/cines_renoir")
