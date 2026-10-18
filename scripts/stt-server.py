"""
Local speech-to-text for the bridge: faster-whisper on this machine's GPU.

The cloud services that hear him have allowances, and when one runs out he
goes deaf. This one has none. It listens on loopback only, takes the bytes of
one clip in a POST to /stt, and answers {"text": "..."}.

    .venv-stt/Scripts/python scripts/stt-server.py

Settings, all optional (read from the environment, which start.mjs fills
from .env.local):
    JARVIS_STT_MODEL   whisper model size or path   (default: medium)
    JARVIS_STT_DEVICE  cuda | cpu                   (default: cuda, falls back to cpu)
    JARVIS_STT_PORT    port on 127.0.0.1            (default: 8790)
    JARVIS_LANG        e.g. pt-BR                   (default: pt-BR)
"""

import io
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock


def add_cuda_dlls():
    # The CUDA libraries come as pip wheels (nvidia-cublas-cu12,
    # nvidia-cudnn-cu12). Windows does not search their folders by itself.
    if os.name != "nt":
        return
    base = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")
    for pkg in ("cublas", "cudnn"):
        path = os.path.join(base, pkg, "bin")
        if os.path.isdir(path):
            os.add_dll_directory(path)
            os.environ["PATH"] = path + os.pathsep + os.environ.get("PATH", "")


add_cuda_dlls()

from faster_whisper import WhisperModel  # noqa: E402

MODEL = os.environ.get("JARVIS_STT_MODEL", "medium")
DEVICE = os.environ.get("JARVIS_STT_DEVICE", "cuda")
PORT = int(os.environ.get("JARVIS_STT_PORT", "8790"))
LANG = (os.environ.get("JARVIS_LANG") or os.environ.get("VITE_JARVIS_LANG") or "pt-BR").split("-")[0].lower()

# No initial prompt naming him. It helps Whisper spell "Jarvis", but it also
# makes it hear "Jarvis" where nobody said it — which is a false wake. The
# misspellings are caught by the name pattern in voice.ts instead.


def load():
    try:
        return WhisperModel(MODEL, device=DEVICE, compute_type="int8_float16" if DEVICE == "cuda" else "int8"), DEVICE
    except Exception as err:  # no GPU, or the CUDA libraries are missing
        print(f"[stt] {DEVICE} unavailable ({err}); using the CPU", flush=True)
        return WhisperModel(MODEL, device="cpu", compute_type="int8"), "cpu"


model, device = load()
# One clip at a time: the GPU does not get faster by being asked twice.
lock = Lock()


def transcribe(audio: bytes) -> str:
    with lock:
        segments, _ = model.transcribe(
            io.BytesIO(audio),
            language=LANG,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        return " ".join(s.text.strip() for s in segments).strip()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet: the bridge logs what matters
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ok": True, "model": MODEL, "device": device})
        self.reply(404, {})

    def do_POST(self):
        if self.path != "/stt":
            return self.reply(404, {})
        size = int(self.headers.get("content-length") or 0)
        if not 0 < size <= 25 * 1024 * 1024:
            return self.reply(400, {"error": "bad size"})
        audio = self.rfile.read(size)
        started = time.perf_counter()
        try:
            text = transcribe(audio)
        except Exception as err:
            return self.reply(500, {"error": str(err)})
        self.reply(200, {"text": text, "ms": round((time.perf_counter() - started) * 1000)})


def watch_parent():
    """Leave when the launcher does, so a closed window leaves no orphan on the port."""
    pid = int(os.environ.get("JARVIS_PARENT_PID") or 0)
    if not pid:
        return

    def alive():
        if os.name != "nt":
            try:
                os.kill(pid, 0)
                return True
            except OSError:
                return False
        # Not os.kill: on Windows signal 0 is CTRL_C_EVENT, not a probe.
        import ctypes

        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        k.GetExitCodeProcess(h, ctypes.byref(code))
        k.CloseHandle(h)
        return code.value == 259  # STILL_ACTIVE

    def loop():
        while alive():
            time.sleep(2)
        os._exit(0)

    import threading

    threading.Thread(target=loop, daemon=True).start()


if __name__ == "__main__":
    watch_parent()
    # Warm up once, so the first real question does not pay for loading kernels.
    try:
        import numpy

        list(model.transcribe(numpy.zeros(16000, dtype="float32"), language=LANG)[0])
    except Exception:
        pass
    print(f"[stt] faster-whisper {MODEL} on {device}, listening on 127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
