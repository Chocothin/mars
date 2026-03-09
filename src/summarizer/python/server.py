"""
KoBART Summarization Microservice
Model: EbanLee/kobart-summary-v3 (124M params)
Serves HTTP on localhost:19540 for the mars orchestration server.
"""

import json
import time
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Lock

import torch
from transformers import PreTrainedTokenizerFast, BartForConditionalGeneration

MODEL_ID = "EbanLee/kobart-summary-v3"
PORT = 19540
MAX_INPUT_TOKENS = 1024

model = None
tokenizer = None
model_lock = Lock()


def load_model():
    global model, tokenizer
    t0 = time.time()
    tokenizer = PreTrainedTokenizerFast.from_pretrained(MODEL_ID)
    model = BartForConditionalGeneration.from_pretrained(MODEL_ID)
    model.eval()
    params = sum(p.numel() for p in model.parameters())
    elapsed = time.time() - t0
    print(f"[summarizer] Model loaded: {params / 1e6:.0f}M params in {elapsed:.1f}s", flush=True)


def summarize(text: str, max_length: int = 128, min_length: int = 12) -> dict:
    with model_lock:
        inputs = tokenizer(
            text,
            return_tensors="pt",
            max_length=MAX_INPUT_TOKENS,
            truncation=True,
        )
        input_tokens = inputs["input_ids"].shape[1]

        t0 = time.time()
        with torch.no_grad():
            output_ids = model.generate(
                inputs["input_ids"],
                max_length=max_length,
                min_length=min_length,
                num_beams=4,
                no_repeat_ngram_size=3,
                length_penalty=1.0,
            )
        elapsed = time.time() - t0

        summary = tokenizer.decode(output_ids[0], skip_special_tokens=True)

    return {
        "summary": summary,
        "input_chars": len(text),
        "input_tokens": input_tokens,
        "output_chars": len(summary),
        "elapsed_ms": round(elapsed * 1000),
    }


class SummarizerHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/summarize":
            self._handle_summarize()
        else:
            self._respond(404, {"error": "not found"})

    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {"status": "ok", "model": MODEL_ID})
        else:
            self._respond(404, {"error": "not found"})

    def _handle_summarize(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))

            text = body.get("text", "").strip()
            if not text:
                self._respond(400, {"error": "text is required"})
                return

            max_length = body.get("max_length", 128)
            min_length = body.get("min_length", 12)

            result = summarize(text, max_length=max_length, min_length=min_length)
            self._respond(200, result)

        except json.JSONDecodeError:
            self._respond(400, {"error": "invalid JSON"})
        except Exception as e:
            self._respond(500, {"error": str(e)})

    def _respond(self, status: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"[summarizer] Loading {MODEL_ID}...", flush=True)
    load_model()

    server = HTTPServer(("127.0.0.1", PORT), SummarizerHandler)
    print(f"[summarizer] Serving on http://127.0.0.1:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[summarizer] Shutting down.", flush=True)
        server.server_close()
