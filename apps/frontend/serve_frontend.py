"""Serve the frontend from the repository root for correct relative paths."""

from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
HOST = "127.0.0.1"
PORT = 8080


def main() -> None:
    handler = partial(SimpleHTTPRequestHandler, directory=str(REPO_ROOT))
    with ThreadingHTTPServer((HOST, PORT), handler) as server:
        print(f"Frontend: http://{HOST}:{PORT}/apps/frontend/index.html")
        server.serve_forever()


if __name__ == "__main__":
    main()
