"""Local dev server for docs/ with caching disabled (so reloads always get fresh JS).

    python3 scripts/serve.py            # http://localhost:8765 (IPv4 + IPv6 loopback)
"""

import http.server
import socket
import sys
import threading
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "docs"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter
        if "404" in (fmt % args):
            super().log_message(fmt, *args)


class V6Server(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6


def serve(server_cls, host):
    handler = partial(NoCache, directory=str(ROOT))
    with server_cls((host, PORT), handler) as httpd:
        httpd.serve_forever()


if __name__ == "__main__":
    threading.Thread(target=serve, args=(V6Server, "::1"), daemon=True).start()
    print(f"serving {ROOT} at http://localhost:{PORT}", flush=True)
    serve(http.server.ThreadingHTTPServer, "127.0.0.1")
