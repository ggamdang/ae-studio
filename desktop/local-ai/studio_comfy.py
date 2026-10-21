"""Unified Studio launcher. Original adapter; upstream ComfyUI is unmodified.

Only the owning desktop process can call this loopback service. Cloud/API nodes,
custom nodes, updates, and Python outbound network connections are disabled.
Watching the parent process also stops this worker after a desktop crash.
"""
import json
import os
import pathlib
import runpy
import secrets
import socket
import sys
import threading
import faulthandler

faulthandler.enable()
faulthandler.dump_traceback_later(60)

settings = json.loads(sys.stdin.readline())
token = settings.pop("token")
session_id = settings.pop("session")
parent_pid = int(settings.pop("parentPid"))
if len(token) < 40:
    raise RuntimeError("Missing private desktop session")


def parent_watch():
    # A permanently blocked Python stdin reader can deadlock native NumPy DLL
    # initialization on Windows. Watch the actual parent process handle instead.
    if os.name != "nt":
        import time
        while os.getppid() == parent_pid:
            time.sleep(1)
        os._exit(0)
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    handle = kernel.OpenProcess(0x00100000, False, parent_pid)
    if not handle:
        os._exit(1)
    kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
    os._exit(0)


threading.Thread(target=parent_watch, daemon=True).start()
allowed_hosts = {None, "localhost", "127.0.0.1", "::1", b"localhost", b"127.0.0.1", b"::1"}
original_lookup = socket.getaddrinfo
original_connect = socket.socket.connect
original_connect_ex = socket.socket.connect_ex


def local_lookup(host, *args, **kwargs):
    if host not in allowed_hosts:
        raise PermissionError("Unified Studio local AI cannot access the internet")
    return original_lookup(host, *args, **kwargs)


def local_connect(self, address):
    if self.family in (socket.AF_INET, socket.AF_INET6) and address[0] not in allowed_hosts:
        raise PermissionError("Unified Studio local AI cannot access the internet")
    return original_connect(self, address)


def local_connect_ex(self, address):
    if self.family in (socket.AF_INET, socket.AF_INET6) and address[0] not in allowed_hosts:
        raise PermissionError("Unified Studio local AI cannot access the internet")
    return original_connect_ex(self, address)


socket.getaddrinfo = local_lookup
socket.socket.connect = local_connect
socket.socket.connect_ex = local_connect_ex
for key, value in {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1", "TOKENIZERS_PARALLELISM": "false"}.items():
    os.environ[key] = value

from aiohttp import web


@web.middleware
async def desktop_only(request, handler):
    if request.headers.get("Origin") or not secrets.compare_digest(request.headers.get("X-Studio-Session", ""), token):
        return web.json_response({"error": "Private desktop service"}, status=403)
    route = request.path
    read = request.method == "GET" and (route in {"/system_stats", "/queue", "/object_info/CheckpointLoaderSimple", "/view"} or route.startswith("/history/"))
    write = request.method == "POST" and route in {"/prompt", "/queue", "/interrupt"}
    if not (read or write):
        return web.json_response({"error": "Not exposed by Unified Studio"}, status=403)
    if route == "/prompt":
        body = await request.json()
        graph = body.get("prompt", {})
        allowed = {"CheckpointLoaderSimple", "CLIPTextEncode", "EmptyLatentImage", "KSampler", "VAEDecode", "SaveImage"}
        if not isinstance(graph, dict) or not 1 <= len(graph) <= 8 or any(node.get("class_type") not in allowed for node in graph.values()):
            return web.json_response({"error": "Only the local image workflow is enabled"}, status=400)
    response = await handler(request)
    response.headers["X-Studio-Instance"] = session_id
    return response


original_app_init = web.Application.__init__


def private_app_init(self, *args, **kwargs):
    faulthandler.cancel_dump_traceback_later()
    kwargs["middlewares"] = [desktop_only, *kwargs.get("middlewares", [])]
    return original_app_init(self, *args, **kwargs)


web.Application.__init__ = private_app_init
comfy_root = pathlib.Path(__file__).resolve().parent / "runtime" / ("ComfyUI_windows_portable/ComfyUI" if os.name == "nt" else "ComfyUI")
sys.path.insert(0, str(comfy_root))
sys.argv = [str(comfy_root / "main.py"), *sys.argv[1:]]
runpy.run_path(str(comfy_root / "main.py"), run_name="__main__")
