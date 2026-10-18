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
import ctypes.wintypes  # noqa: F401  (GetCursorPos needs POINT)
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

from faster_whisper import WhisperModel, decode_audio  # noqa: E402
from faster_whisper.feature_extractor import FeatureExtractor  # noqa: E402

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

# ---------------------------------------------------------------- end of turn
#
# Smart Turn v3 (pipecat-ai/smart-turn, BSD-2): from the sound of the last
# eight seconds — intonation, pace, the shape of the final syllable — the
# probability that the speaker has finished. A transcript can only guess that
# from punctuation, and Whisper puts a full stop on nearly everything.
# Optional: without models/smart-turn-v3.2-cpu.onnx this part is skipped.
TURN_MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", "smart-turn-v3.2-cpu.onnx")
turn_session = None
if os.path.exists(TURN_MODEL):
    try:
        import numpy as np
        import onnxruntime as ort

        _opts = ort.SessionOptions()
        _opts.inter_op_num_threads = 1
        _opts.intra_op_num_threads = 2
        turn_session = ort.InferenceSession(TURN_MODEL, sess_options=_opts, providers=["CPUExecutionProvider"])
        turn_features = FeatureExtractor(feature_size=80, chunk_length=8)
    except Exception as err:
        print(f"[stt] end-of-turn model unavailable: {err}", flush=True)
        turn_session = None


# ------------------------------------------------------------- whose voice
#
# CAM++ (3D-Speaker, Apache-2.0, via sherpa-onnx): a 192-number summary of a
# voice. The owner's is learned once, from ten or so things he says while
# enrolling, and kept in ~/.jarvis/voiceprint.npy; after that every clip is
# compared with it, and the HUD can ignore a wake word in someone else's voice
# — the television, a video, a visitor. Optional twice over: no model, or no
# voiceprint yet, and every clip is simply accepted as before.
SPEAKER_MODEL = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "models", "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
)
VOICEPRINT = os.path.join(os.environ.get("JARVIS_MEMORY_DIR") or os.path.join(os.path.expanduser("~"), ".jarvis"), "voiceprint.npy")
speaker = None
voiceprint = None
enrolling = []
if os.path.exists(SPEAKER_MODEL):
    try:
        import numpy as np
        import sherpa_onnx

        speaker = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=SPEAKER_MODEL, num_threads=2, provider="cpu")
        )
        if os.path.exists(VOICEPRINT):
            voiceprint = np.load(VOICEPRINT)
    except Exception as err:
        print(f"[stt] speaker model unavailable: {err}", flush=True)
        speaker = None


def voice_of(samples):
    """The unit-length voice summary of a clip, or None."""
    if speaker is None or samples is None or len(samples) < 8000:  # under half a second says little
        return None
    stream = speaker.create_stream()
    stream.accept_waveform(16000, samples)
    stream.input_finished()
    e = np.array(speaker.compute(stream), dtype=np.float32)
    n = np.linalg.norm(e)
    return e / n if n else None


def finish_enrolment():
    """Average what was collected into the voiceprint. Returns how many clips it used."""
    global voiceprint, enrolling
    clips, enrolling = enrolling, []
    if len(clips) < 3:
        return 0
    profile = np.mean(clips, axis=0)
    profile /= np.linalg.norm(profile)
    os.makedirs(os.path.dirname(VOICEPRINT), exist_ok=True)
    np.save(VOICEPRINT, profile)
    voiceprint = profile
    return len(clips)


def forget_voice():
    global voiceprint, enrolling
    voiceprint, enrolling = None, []
    if os.path.exists(VOICEPRINT):
        os.remove(VOICEPRINT)


def turn_complete(samples):
    """Probability, 0 to 1, that the speech in `samples` (16 kHz) is a finished turn."""
    if turn_session is None or samples is None or len(samples) < 1600:
        return None
    n = 8 * 16000
    # As the reference does it: the last eight seconds, padded with silence at
    # the START — the model reads the end of the window as the end of speech —
    # then normalised as Whisper's extractor does with do_normalize.
    audio = samples[-n:].astype(np.float32)
    audio = np.pad(audio, (n - len(audio), 0))
    audio = (audio - audio.mean()) / np.sqrt(audio.var() + 1e-7)
    feats = turn_features(audio, padding=0)[:, :800].astype(np.float32)
    out = turn_session.run(None, {"input_features": feats[np.newaxis]})
    return float(out[0][0][0])


def transcribe(audio: bytes, enrol=False):
    """The words, the probability the speaker had finished, and how much the
    voice is the owner's (each None when it cannot be told)."""
    samples = decode_audio(io.BytesIO(audio), sampling_rate=16000)
    complete = turn_complete(samples)
    likeness = None
    if speaker is not None and (enrol or voiceprint is not None):
        v = voice_of(samples)
        if v is not None:
            if enrol:
                enrolling.append(v)
            elif voiceprint is not None:
                likeness = float(v @ voiceprint)
    with lock:
        segments, _ = model.transcribe(
            samples,
            language=LANG,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        return " ".join(s.text.strip() for s in segments).strip(), complete, likeness


# --------------------------------------------------------------------- screen
#
# One picture of a monitor, for the bridge's look_at_screen tool. Taken only
# when that tool asks, returned in the reply, never written anywhere.


def screenshot(which="cursor", max_width=1800):
    import base64
    import ctypes.wintypes

    import mss
    from PIL import Image

    # Real pixels on a scaled display, not a shrunken virtual screen.
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass
    with mss.mss() as grab:
        monitors = sorted(grab.monitors[1:], key=lambda m: m["left"])
        if which == "all":
            area = grab.monitors[0]
        elif which.isdigit() and 1 <= int(which) <= len(monitors):
            area = monitors[int(which) - 1]
        else:
            pt = ctypes.wintypes.POINT()
            ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
            area = next(
                (m for m in monitors if m["left"] <= pt.x < m["left"] + m["width"] and m["top"] <= pt.y < m["top"] + m["height"]),
                monitors[0],
            )
        raw = grab.grab(area)
    img = Image.frombytes("RGB", raw.size, raw.rgb)
    if img.width > max_width:
        img = img.resize((max_width, round(img.height * max_width / img.width)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    return base64.b64encode(buf.getvalue()).decode(), len(monitors)


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
        if self.path == "/voice":
            return self.reply(200, {"available": speaker is not None, "enrolled": voiceprint is not None, "collecting": len(enrolling)})
        if self.path.startswith("/screen"):
            which = self.path.partition("which=")[2] or "cursor"
            try:
                data, count = screenshot(which)
            except Exception as err:
                return self.reply(500, {"error": str(err)})
            return self.reply(200, {"data": data, "mimeType": "image/jpeg", "screens": count})
        self.reply(404, {})

    def do_POST(self):
        if self.path == "/voice/finish":
            return self.reply(200, {"clips": finish_enrolment()})
        if self.path == "/voice/forget":
            forget_voice()
            return self.reply(200, {"ok": True})
        if self.path != "/stt":
            return self.reply(404, {})
        size = int(self.headers.get("content-length") or 0)
        if not 0 < size <= 25 * 1024 * 1024:
            return self.reply(400, {"error": "bad size"})
        audio = self.rfile.read(size)
        started = time.perf_counter()
        try:
            text, complete, likeness = transcribe(audio, enrol=self.headers.get("x-voice") == "enrol")
        except Exception as err:
            return self.reply(500, {"error": str(err)})
        body = {"text": text, "ms": round((time.perf_counter() - started) * 1000)}
        if complete is not None:
            body["complete"] = round(complete, 3)
        if likeness is not None:
            body["speaker"] = round(likeness, 3)
        self.reply(200, body)


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
    print(
        f"[stt] faster-whisper {MODEL} on {device}"
        + (", with end-of-turn detection" if turn_session else "")
        + (", voice recognition (" + ("enrolled" if voiceprint is not None else "not enrolled") + ")" if speaker else "")
        + f", listening on 127.0.0.1:{PORT}",
        flush=True,
    )
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
