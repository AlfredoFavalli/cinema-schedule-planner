import os
import pandas as pd
from datetime import datetime
import re


class MovieFilter:
    def __init__(self, folder_path):
        self.display_settings()

        self.folder_path = folder_path
        self.sala_capacity = {
            "Renoir Princesa": {
                1: 87, 2: 107, 3: 83, 4: 175, 5: 191, 6: 170, 7: 120, 8: 76, 9: 195, 10: 190, 11: 190
            },
            "Renoir Plaza de España": {
                1: 139, 2: 95, 3: 149, 4: 71, 5: 68
            },
            "Golem Madrid": {
                1: 74, 2: 193, 3: 64, 4: 115, 5: 157
            }
        }
        self.original_data = None  # Store the unfiltered dataset
        self.data = None  # Store the working copy of the dataset

    def display_settings(self):
        pd.set_option('display.max_columns', None)
        pd.set_option('display.max_rows', None)
        pd.set_option('display.width', 100000)

    def get_recent_files(self):
        files = [f for f in os.listdir(self.folder_path) if f.startswith("cines_") and f.endswith(".csv")]
        files.sort(
            key=lambda x: datetime.strptime(re.search(r"\d{4}-\d{2}-\d{2}_\d{2}-\d{2}", x).group(), "%Y-%m-%d_%H-%M"),
            reverse=True)
        return files[:2]

    def load_and_merge_data(self):
        recent_files = self.get_recent_files()
        dataframes = [pd.read_csv(os.path.join(self.folder_path, file)) for file in recent_files]
        merged_data = pd.concat(dataframes, ignore_index=True)
        self.original_data = merged_data  # Save the unfiltered dataset
        return merged_data

    def clean_pelicula_titles(self, df):
        df['Pelicula'] = df['Pelicula'].apply(lambda x: re.sub(r"\(.*?\)", "", x).strip().upper())
        return df

    def display_movies(self, movies):
        if movies.empty:
            print("\nNo movies to display.")
            return

        current_movie = None
        current_date = None

        for _, row in movies.iterrows():
            movie = row['Pelicula']
            director = row['Director']
            day_of_week = row['Fecha'].strftime('%A')
            date = row['Fecha'].strftime('%Y-%m-%d')
            sala = row['Sala']
            horario = row['Horario']
            cine = row['Cine']
            end_time = row['End_Time']
            seats = self.sala_capacity.get(cine, {}).get(sala, 0)

            if movie != current_movie:
                if current_movie is not None:
                    print("\n" + "-" * 50)
                current_movie = movie
                print(f"\n{movie} ({row['Duración']} minutes)")
                print(f"Directed by: {director}")

            if date != current_date:
                current_date = date
                print(f"\n  {date} ({day_of_week}):")

            print(f"    - {horario} to {end_time} | Sala {sala} ({seats} seats) @ {cine}")

        print("\n" + "-" * 50)

    def display_all_movies(self):
        first_run = True  # Flag to track if it's the first run

        while True:
            if not first_run:
                # Ask the user if they want to reselect movies
                reselect = input("\nDo you want to reselect movies? (yes/no): ").strip().lower()
                if reselect in ['no', 'n', 'N', 'NO']:
                    print("\nExiting movie selection.")
                    break
                elif reselect not in ['yes', 'y', 'Y', 'YES']:
                    print("\nInvalid input. Please type 'y' or 'n'.")
                    continue

            # Use the original data to display all movies
            all_movies = self.original_data.groupby('Pelicula').agg({
                'Director': 'first',
                'Duración': 'first'
            }).reset_index()

            print("\nAvailable Movies:")
            for i, row in all_movies.iterrows():
                print(f"{i + 1}. {row['Pelicula']} ({row['Duración']} minutes) - Directed by: {row['Director']}")

            selected_indices = input(
                "\nEnter the numbers of the movies you want to see details for,\nseparated by commas (or type 'quit' to exit): "
            )

            if selected_indices.lower() == 'quit':
                print("\nExiting movie selection.")
                break

            # 🔹 Only input parsing is protected
            try:
                selected_indices = [int(i.strip()) - 1 for i in selected_indices.split(',')]
            except ValueError as e:
                print("\nInvalid input format. Error:", e)
                continue

            if any(index < 0 or index >= len(all_movies) for index in selected_indices):
                print("\nInvalid input. Please select numbers from the list.")
                continue

            selected_movies = all_movies.iloc[selected_indices]['Pelicula']
            self.data = self.original_data[self.original_data['Pelicula'].isin(selected_movies)].copy()

            # 🔹 Now errors here will show their real cause
            filtered_movies = self.get_filtered_movies()
            if not filtered_movies.empty:
                self.display_movies(filtered_movies)

            first_run = False  # Update the flag after the first run

    def get_filtered_movies(self):
        if self.data.empty:
            print("\nNo data available to filter.")
            return self.data

        self.data['Fecha'] = pd.to_datetime(self.data['Fecha'], errors='coerce')
        self.data['Horario'] = (
            pd.to_datetime(
                self.data['Horario'].astype(str).str.strip(),
                format='%H:%M',
                errors='coerce'
            ).dt.time
        )

        # 🔹 DROP ROWS THAT WOULD BREAK TIME CALCULATION
        self.data = self.data.dropna(subset=['Horario', 'Duración'])

        # Filter by days: Monday, Tuesday, Thursday and Friday
        self.data = self.data[self.data['Fecha'].dt.dayofweek.isin([0, 1, 2, 3, 4])]

        if self.data.empty:
            print("\nNo movies match the selected days (Monday, Tuesday, Thursday).")
            return self.data

        # Calculate movie end time
        self.data['End_Time'] = self.data.apply(
            lambda row: (
                    datetime.combine(datetime.today(), row['Horario']) + pd.Timedelta(minutes=row['Duración'])
            ).time(),
            axis=1
        )

        # Filter movies starting after 20:00 or finishing before 21:00
        self.data = self.data[
            (self.data['Horario'] <= datetime.strptime('20:00', '%H:%M').time()) &
            (self.data['End_Time'] < datetime.strptime('21:00', '%H:%M').time())
            ]
        if self.data.empty:
            print("\nNo movies match the selected time criteria (start before 20:00 and end before 21:00).")
            return self.data

        # Filter salas with more than 100 seats
        def has_enough_seats(row):
            cine = row['Cine']
            sala = row['Sala']
            return self.sala_capacity.get(cine, {}).get(sala, 0) > 100

        self.data = self.data[self.data.apply(has_enough_seats, axis=1)]
        if self.data.empty:
            print("\nNo movies available in salas with more than 100 seats.")
            return self.data

        # Sort by Movie, Sala (biggest first), Horario (earlier first)
        self.data = self.data.sort_values(by=['Pelicula', 'Fecha', 'Sala', 'Horario'],
                                          ascending=[True, True, False, True])

        return self.data



# Example Usage
if __name__ == "__main__":
    folder_path = "_1_data"
    movie_filter = MovieFilter(folder_path)

    # Load and preprocess data
    movie_filter.data = movie_filter.load_and_merge_data()
    movie_filter.data = movie_filter.clean_pelicula_titles(movie_filter.data)

    # Display all movies and let user select
    movie_filter.display_all_movies()

    # Filter and display movies
    filtered_movies = movie_filter.get_filtered_movies()
    movie_filter.display_movies(filtered_movies)