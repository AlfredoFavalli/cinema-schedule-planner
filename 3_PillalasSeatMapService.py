import argparse
import json
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


def extract_attr(tag, attr_name):
    match = re.search(rf'{attr_name}\s*=\s*(["\'])(.*?)\1', tag, flags=re.IGNORECASE | re.DOTALL)
    return unescape(match.group(2).strip()) if match else ''


def extract_style_position(style):
    if not style:
        return None, None
    left_match = re.search(r'left\s*:\s*([\d.]+)px', style, flags=re.IGNORECASE)
    top_match = re.search(r'top\s*:\s*([\d.]+)px', style, flags=re.IGNORECASE)
    left = float(left_match.group(1)) if left_match else None
    top = float(top_match.group(1)) if top_match else None
    return left, top


def classify_from_src(src):
    for icon_name, seat_type in ICON_TO_TYPE.items():
        if icon_name in src.lower():
            return seat_type
    return None


def nearest_index(values, target, tolerance=3.0):
    for idx, value in enumerate(values):
        if abs(value - target) <= tolerance:
            return idx + 1
    values.append(target)
    values.sort()
    return values.index(target) + 1


def parse_seat_map(html, ticket_url=''):
    img_tags = re.findall(r'<img\b[^>]*>', html, flags=re.IGNORECASE)
    seats = []
    x_values = []
    y_values = []

    for tag in img_tags:
        src = extract_attr(tag, 'src')
        seat_type = classify_from_src(src)
        if not seat_type:
            continue

        style = extract_attr(tag, 'style')
        x, y = extract_style_position(style)
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
