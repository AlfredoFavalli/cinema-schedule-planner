import os
import shutil
import requests
from bs4 import BeautifulSoup
import pandas as pd
from datetime import datetime, timedelta
from urllib.parse import urljoin

class CinesRenoirScraper:
    def __init__(self, base_urls, days_in_advance=10):
        self.base_urls = base_urls
        self.days_in_advance = days_in_advance
        self.soup = None
        self.current_page_url = None
        self.data = []

    def fetch_page(self, url, date):
        """Fetches the webpage content for a specific date and parses it with BeautifulSoup."""
        full_url = f"{url}?fecha={date}"
        response = requests.get(full_url)
        if response.status_code == 200:
            self.soup = BeautifulSoup(response.content, 'html.parser')
            self.current_page_url = response.url
        else:
            raise Exception(f"Failed to fetch page for {date}: {response.status_code}")

    def _extract_poster_url(self, block):
        """Extracts and normalizes the movie poster URL from the movie block."""
        poster_container = block.select_one('.row > .col-3')
        if not poster_container:
            return None

        # Renoir exposes the full-size image in an <a> wrapping <img>.
        poster_candidate = None
        for anchor in poster_container.select('a[href]'):
            if anchor.find('img'):
                poster_candidate = anchor.get('href')
                break

        # Fallback to image src if href is unavailable.
        if not poster_candidate:
            image = poster_container.select_one('img[src]')
            if image:
                poster_candidate = image.get('src')

        if not poster_candidate:
            return None

        return urljoin(self.current_page_url or '', poster_candidate.strip())

    def extract_movie_data(self, cine_name, date):
        """Extracts movie data from the HTML."""
        movie_blocks = self.soup.find_all('div', class_='my-account-content mb-15 d-none d-lg-block')

        for block in movie_blocks:
            # Extract movie details
            movie_element = block.find('div', class_='col-4 pl-0 pr-0')
            title_element = movie_element.find('a')
            director_element = movie_element.find('small', style="color:#748294")
            duration_element = movie_element.find(string=lambda t: 'Duración' in t)
            poster_url = self._extract_poster_url(block)

            title = title_element.text.strip() if title_element else None
            director = director_element.text.strip().replace('de ', '') if director_element else None
            duration = duration_element.strip().replace('Duración ', '').replace(' minutos', '') if duration_element else None

            # Extract showtimes
            showtime_section = block.find('div', class_='col-7')
            time_slots = showtime_section.find_all('div', style="width: 80px; float: left; margin-right: 20px;")

            for slot in time_slots:
                room_element = slot.find('span', style="font-size:12px")
                time_element = slot.find('a', class_='btn btn-primary')

                room = room_element.text.strip().replace('sala ', '') if room_element else None
                time = time_element.text.strip() if time_element else None

                self.data.append({
                    'Pelicula': title,
                    'Director': director,
                    'Duración': duration,
                    'Poster_URL': poster_url,
                    'Sala': room,
                    'Horario': time,
                    'Fecha': date,  # Directly use the date passed to the method
                    'Cine': cine_name
                })

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
        print(f"Data saved to {filename}")


if __name__ == "__main__":
    base_urls = [
        ("https://www.cinesrenoir.com/cine/cines-princesa/cartelera/", "Renoir Princesa"),
        ("https://www.cinesrenoir.com/cine/renoir-plaza-de-espana/cartelera/", "Renoir Plaza de España")
    ]
    scraper = CinesRenoirScraper(base_urls, days_in_advance=10)

    scraper.scrape_for_date_range()
    scraper.save_to_csv("_1_data/cines_renoir")
