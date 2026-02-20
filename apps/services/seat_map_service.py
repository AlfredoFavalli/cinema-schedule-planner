import argparse
import csv
import json
import os
import re
from datetime import datetime, timezone
from html import unescape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

ICON_TO_TYPE = {
    'normal.png': 'normal',
    'vendida.png': 'vendida',
    'minusvalido.png': 'minusvalido',
    'noactiva.png': 'noactiva',
}

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) CinemaSchedulePlanner/1.0',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

UPCOMING_CSV_PATH = os.path.join('data', 'raw', 'film_affinity', 'upcoming_releases.csv')


def load_upcoming_releases(path=UPCOMING_CSV_PATH):
    if not os.path.exists(path):
        return []

    rows = []
    with open(path, 'r', encoding='utf-8', newline='') as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            parsed = dict(row)
            parsed['duration_min'] = int(row['duration_min']) if row.get('duration_min') else None
            parsed['year'] = int(row['year']) if row.get('year') else None
            parsed['rating_avg'] = float(row['rating_avg']) if row.get('rating_avg') else None
            parsed['rating_count'] = int(row['rating_count']) if row.get('rating_count') else None
            parsed['theaters_count'] = int(row['theaters_count']) if row.get('theaters_count') else None
            parsed['trailer_available'] = str(row.get('trailer_available', '')).lower() in ('1', 'true', 'yes')

            for field in ('genres', 'director', 'cast_top'):
                value = row.get(field)
                try:
                    parsed[field] = json.loads(value) if value else []
                except json.JSONDecodeError:
                    parsed[field] = []

            rows.append(parsed)
    return rows


def extract_attr(tag, attr_name):
    # 1) quoted value: attr="..." or attr='...'
    quoted = re.search(
        rf'\b{re.escape(attr_name)}\s*=\s*(["\'])(.*?)\1',
        tag,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if quoted:
        return unescape(quoted.group(2).strip())

    # 2) unquoted value: attr=value
    unquoted = re.search(
        rf'\b{re.escape(attr_name)}\s*=\s*([^\s>]+)',
        tag,
        flags=re.IGNORECASE,
    )
    return unescape(unquoted.group(1).strip()) if unquoted else ''


def parse_float(text):
    if text is None:
        return None
    match = re.search(r'-?\d+(?:\.\d+)?', str(text))
    return float(match.group(0)) if match else None


def extract_style_position(style):
    if not style:
        return None, None

    def pick(prop):
        match = re.search(rf'{prop}\s*:\s*(-?\d+(?:\.\d+)?)(?:px)?', style, flags=re.IGNORECASE)
        return float(match.group(1)) if match else None

    left = pick('left')
    top = pick('top')

    if left is None or top is None:
        # Some pages place elements using transform translate(Xpx,Ypx)
        translate = re.search(
            r'transform\s*:\s*translate\(\s*(-?\d+(?:\.\d+)?)px\s*,\s*(-?\d+(?:\.\d+)?)px\s*\)',
            style,
            flags=re.IGNORECASE,
        )
        if translate:
            left = left if left is not None else float(translate.group(1))
            top = top if top is not None else float(translate.group(2))

    return left, top


def classify_from_src(src):
    src_l = (src or '').lower()
    for icon_name, seat_type in ICON_TO_TYPE.items():
        if icon_name in src_l:
            return seat_type
    return None


def extract_position_from_tag(tag):
    # Priority 1: style coordinates
    style = extract_attr(tag, 'style')
    x, y = extract_style_position(style)

    # Priority 2: direct data attributes
    if x is None:
        x = parse_float(extract_attr(tag, 'data-x'))
    if y is None:
        y = parse_float(extract_attr(tag, 'data-y'))

    # Priority 3: alternative semantic attrs (column/row)
    col = parse_float(extract_attr(tag, 'data-col'))
    if col is None:
        col = parse_float(extract_attr(tag, 'data-columna'))
    if col is None:
        col = parse_float(extract_attr(tag, 'columna'))

    row = parse_float(extract_attr(tag, 'data-row'))
    if row is None:
        row = parse_float(extract_attr(tag, 'data-fila'))
    if row is None:
        row = parse_float(extract_attr(tag, 'fila'))

    # If true pixel coords are missing, synthesize from row/column indices.
    if x is None and col is not None:
        x = col
    if y is None and row is not None:
        y = row

    return x, y


def nearest_index(values, target, tolerance=3.0):
    for idx, value in enumerate(values):
        if abs(value - target) <= tolerance:
            return idx + 1
    values.append(target)
    values.sort()
    return values.index(target) + 1


def parse_seat_map(html, ticket_url=''):
    # Include both <img> and <input ... type=image> seats.
    seat_tags = re.findall(r'<(?:img|input)\b[^>]*>', html, flags=re.IGNORECASE)
    seats = []
    x_values = []
    y_values = []

    for tag in seat_tags:
        src = extract_attr(tag, 'src')
        seat_type = classify_from_src(src)
        if not seat_type:
            continue

        x, y = extract_position_from_tag(tag)
        if x is None or y is None:
            continue

        label = extract_attr(tag, 'title') or extract_attr(tag, 'alt')
        seat = {
            'id': extract_attr(tag, 'id') or None,
            'label': label or None,
            'type': seat_type,
            'x': x,
            'y': y,
            'src': src,
            'is_available': seat_type == 'normal',
        }
        seats.append(seat)
        x_values.append(x)
        y_values.append(y)

    sorted_x = sorted(set(x_values))
    sorted_y = sorted(set(y_values))

    for seat in seats:
        seat['column'] = nearest_index(sorted_x, seat['x'])
        seat['row'] = nearest_index(sorted_y, seat['y'])

    totals = {
        'total_seats': len(seats),
        'available_normal': sum(1 for s in seats if s['type'] == 'normal'),
        'sold_vendida': sum(1 for s in seats if s['type'] == 'vendida'),
        'pmr_minusvalido': sum(1 for s in seats if s['type'] == 'minusvalido'),
        'unavailable_noactiva': sum(1 for s in seats if s['type'] == 'noactiva'),
    }
    totals['occupancy_ratio'] = (
        round(totals['sold_vendida'] / totals['total_seats'], 4)
        if totals['total_seats']
        else 0.0
    )

    return {
        'ticket_url': ticket_url,
        'fetched_at': datetime.now(timezone.utc).isoformat(),
        'totals': totals,
        'bounds': {
            'min_x': min(x_values) if x_values else None,
            'max_x': max(x_values) if x_values else None,
            'min_y': min(y_values) if y_values else None,
            'max_y': max(y_values) if y_values else None,
            'rows': len(sorted_y),
            'columns': len(sorted_x),
        },
        'seats': seats,
    }


def fetch_html(url):
    req = Request(url, headers=HEADERS)
    with urlopen(req, timeout=25) as response:
        return response.read().decode('utf-8', errors='replace')


def parse_ticket_page(ticket_url):
    parsed = urlparse(ticket_url)
    if parsed.scheme not in ('http', 'https'):
        raise ValueError('Ticket URL must be http or https.')
    if 'pillalas.com' not in parsed.netloc.lower():
        raise ValueError('Ticket URL must point to pillalas.com.')

    html = fetch_html(ticket_url)
    return parse_seat_map(html, ticket_url=ticket_url)


class SeatMapHandler(BaseHTTPRequestHandler):
    def _send_json(self, status_code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send_json(200, {'ok': True})

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ('/api/upcoming-releases', '/upcoming-releases'):
            releases = load_upcoming_releases()
            self._send_json(200, {'rows': releases, 'count': len(releases)})
            return

        if parsed.path not in ('/api/seatmap', '/seatmap'):
            self._send_json(404, {'error': 'Not found'})
            return

        params = parse_qs(parsed.query)
        ticket_url = (params.get('ticket_url') or [''])[0].strip()
        if not ticket_url:
            self._send_json(400, {'error': 'Missing ticket_url query parameter.'})
            return

        try:
            payload = parse_ticket_page(ticket_url)
            self._send_json(200, payload)
        except ValueError as exc:
            self._send_json(400, {'error': str(exc)})
        except HTTPError as exc:
            self._send_json(502, {'error': f'Pillalas returned HTTP {exc.code}.'})
        except URLError as exc:
            self._send_json(502, {'error': f'Failed to reach Pillalas: {exc.reason}.'})
        except Exception as exc:
            self._send_json(500, {'error': f'Unexpected error: {exc}'})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Pillalas seat map scraper service.')
    parser.add_argument('--host', default='127.0.0.1', help='Host to bind HTTP service.')
    parser.add_argument('--port', type=int, default=8765, help='Port to bind HTTP service.')
    parser.add_argument('--ticket-url', help='Optional: fetch a single URL and print JSON to stdout.')
    args = parser.parse_args()

    if args.ticket_url:
        print(json.dumps(parse_ticket_page(args.ticket_url), ensure_ascii=False, indent=2))
    else:
        server = ThreadingHTTPServer((args.host, args.port), SeatMapHandler)
        print(f'Seat map service listening on http://{args.host}:{args.port}')
        server.serve_forever()
