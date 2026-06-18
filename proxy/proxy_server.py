import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ENV_FILE = os.path.join(ROOT_DIR, ".env")


def load_env_file(path):
    if not os.path.exists(path):
        return

    with open(path, "r", encoding="utf-8") as env_file:
        for line in env_file:
            stripped = line.strip()

            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue

            name, value = stripped.split("=", 1)
            os.environ.setdefault(name.strip(), value.strip().strip("\"'"))


def get_required_env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def snowflake_agent_url():
    account_url = get_required_env("SNOWFLAKE_ACCOUNT_URL").rstrip("/")
    database = urllib.parse.quote(get_required_env("SNOWFLAKE_DATABASE"), safe="")
    schema = urllib.parse.quote(get_required_env("SNOWFLAKE_SCHEMA"), safe="")
    agent = urllib.parse.quote(get_required_env("SNOWFLAKE_AGENT"), safe="")
    return f"{account_url}/api/v2/databases/{database}/schemas/{schema}/agents/{agent}:run"


def build_agent_prompt(message, dashboard):
    worksheets = ", ".join(dashboard.get("worksheets", [])) or "unknown"
    dashboard_name = dashboard.get("name") or "unknown"

    return f"""
User request:
{message}

Tableau dashboard context:
- Dashboard: {dashboard_name}
- Worksheets: {worksheets}

Return only one JSON object that gives the user a concise answer and tells Tableau how to filter the dashboard.
Do not include Markdown fences or explanatory text.

Allowed JSON shape:
{{
  "answer": "Michael Schumacher is the most successful German driver by race wins.",
  "filters": [
    {{
      "fieldName": "driver_name",
      "values": ["Michael Schumacher"],
      "targetWorksheetNames": ["Driver Wins", "Constructor Wins", "Race Results"]
    }}
  ]
}}

Use the exact Tableau field name when you know it. If the user asks about a driver, prefer fieldName "driver_name".
If the user asks for results within a constructor/team, include a second filter for the constructor field, for example:
{{
  "answer": "The top Ferrari race winners are Michael Schumacher, Niki Lauda, Sebastian Vettel, Alberto Ascari, and Kimi Raikkonen.",
  "filters": [
    {{
      "fieldName": "driver_name",
      "values": ["Michael Schumacher", "Niki Lauda", "Sebastian Vettel", "Alberto Ascari", "Kimi Raikkonen"],
      "targetWorksheetNames": ["Driver Wins", "Race Results"]
    }},
    {{
      "fieldName": "constructor_name",
      "values": ["Ferrari"],
      "targetWorksheetNames": ["Driver Wins", "Constructor Wins", "Race Results"]
    }}
  ]
}}
If a dashboard filter is not appropriate, return "filters": [].
""".strip()


def call_cortex_agent(message, dashboard):
    token = get_required_env("SNOWFLAKE_PAT")
    payload = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": build_agent_prompt(message, dashboard),
                    }
                ],
            }
        ],
        "stream": False,
    }
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        snowflake_agent_url(),
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )

    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def extract_text(value):
    if isinstance(value, str):
        return value

    if isinstance(value, list):
        return "\n".join(filter(None, (extract_text(item) for item in value)))

    if not isinstance(value, dict):
        return ""

    text_parts = []
    for key in ("text", "message", "response", "answer"):
        if isinstance(value.get(key), str):
            text_parts.append(value[key])

    if isinstance(value.get("content"), list):
        text_parts.append(extract_text(value["content"]))

    return "\n".join(filter(None, text_parts))


def extract_agent_payload(agent_response):
    if isinstance(agent_response, dict):
        if "answer" in agent_response and ("filters" in agent_response or "filter" in agent_response):
            return agent_response

    text = extract_text(agent_response)
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        raise ValueError("The Cortex Agent response did not contain answer/filter JSON.")

    parsed = json.loads(match.group(0))
    answer = parsed.get("answer") or parsed.get("response") or parsed.get("message") or ""
    filters = parsed.get("filters")

    if filters is None:
        filter_instruction = parsed.get("filter", parsed if "fieldName" in parsed else None)
        filters = [] if filter_instruction is None else [filter_instruction]

    return {
        "answer": answer,
        "filters": filters,
    }


class ProxyHandler(BaseHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        if self.path != "/tableau-agent-filter":
            self.send_json({"error": "Not found"}, status=404)
            return

        try:
            length = int(self.headers.get("content-length", "0"))
            body = self.rfile.read(length).decode("utf-8")
            client_payload = json.loads(body)
            message = client_payload.get("message", "")
            dashboard = client_payload.get("dashboard", {})

            if not message:
                raise ValueError("Request body must include message.")

            agent_response = call_cortex_agent(message, dashboard)
            agent_payload = extract_agent_payload(agent_response)
            self.send_json(
                {
                    "answer": agent_payload.get("answer", ""),
                    "filters": agent_payload.get("filters", []),
                    "filter": agent_payload.get("filter"),
                    "agentResponse": agent_response,
                }
            )
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            self.send_json(
                {
                    "error": f"Snowflake returned HTTP {error.code}",
                    "detail": detail,
                },
                status=502,
            )
        except Exception as error:
            self.send_json({"error": str(error)}, status=500)

    def send_json(self, payload, status=200):
        response = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)


def main():
    load_env_file(ENV_FILE)
    port = int(os.environ.get("TABLEAU_AGENT_PROXY_PORT", "8766"))

    try:
        snowflake_agent_url()
        get_required_env("SNOWFLAKE_PAT")
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1

    server = ThreadingHTTPServer(("localhost", port), ProxyHandler)
    print(f"Tableau agent proxy listening on http://localhost:{port}/tableau-agent-filter")
    print(f"Forwarding to {snowflake_agent_url()}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
