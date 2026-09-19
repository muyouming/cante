import http.server, os, socketserver, sys, urllib.parse
root, portfile, probe = sys.argv[1], sys.argv[2], sys.argv[3]

def injected(query):
    flags = []
    if "provisioned=1" in query:
        flags.append("<script>window.__CANTE_PROVISIONED__=true;</script>")
    if "probe=1" in query:
        with open(probe, encoding="utf-8") as h:
            flags.append("<script>" + h.read() + "</script>")
    return "".join(flags)

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=root, **k)
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        script = injected(parsed.query)
        if script and parsed.path in ("/", "/index.html"):
            html = open(os.path.join(root, "index.html"), encoding="utf-8").read()
            html = html.replace("<head>", "<head>" + script, 1)
            body = html.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()
    def log_message(self, *a): pass

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

with Server(("127.0.0.1", 0), Handler) as httpd:
    with open(portfile, "w") as h: h.write(str(httpd.server_address[1]))
    httpd.serve_forever()
