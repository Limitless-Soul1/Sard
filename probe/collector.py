#!/usr/bin/env python3
"""Result collector for the Step 1 runtime probe — THROWAWAY.

A separate file rather than an inline heredoc: the previous attempt embedded this in the shell
script and a quoting error left it dead, so the probe reported nothing and the reason was invisible
until the log was read. Every stage is written the moment it arrives, so a window that dies later
cannot erase what was already proven.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OUT = sys.argv[1]
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8792
count = [0]


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        count[0] += 1
        with open(os.path.join(OUT, "latest.json"), "wb") as f:
            f.write(body)
        try:
            stage = json.loads(body).get("stage", "?")
        except Exception:
            stage = "unparseable"
        line = "{:03d} {}\n".format(count[0], stage)
        with open(os.path.join(OUT, "stages.log"), "a", encoding="utf-8") as f:
            f.write(line)
        print(line, end="", flush=True)
        self.send_response(200)
        self._cors()
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


print("collector listening on {}".format(PORT), flush=True)
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
