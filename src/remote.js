// What runs on the Deck. SteamOS has python3, so each step is the helper below, fed over ssh with its
// arguments (see helper() in ssh.js). It speaks to the running Steam client the way Valve's devkit
// tools do (steamos-devkit, MIT; see NOTICE.md): a "devkit-1" line written to ~/.steam/steam.pipe asks
// Steam to do something, and Steam answers in the file the request names.
//
// On the Deck:
//   ~/devkit-game/<id>/                      the game, as Valve's client lays it out
//   ~/devkit-game/<id>-argv.json, -settings.json, -env.json   how Steam starts it
//   ~/devkit-game/<id>_measure -> <id>       the same files, started with the measure flags
//   ~/.local/share/glitchless-deck/          what glitchless-deck keeps: logs, measurements, hashes

// Linux builds start through this, so what the game prints is kept for `glitchless-deck logs`.
export const RUN_WRAPPER = `#!/bin/sh
# Written by glitchless-deck: starts the game and keeps what it prints, for \`glitchless-deck logs\`.
cd "$(dirname "$0")" || exit 1
logs="$HOME/.local/share/glitchless-deck/logs"
mkdir -p "$logs"
name="$1"
shift
[ -f "$logs/$name.log" ] && mv -f "$logs/$name.log" "$logs/$name.previous.log"
exec "$@" > "$logs/$name.log" 2>&1
`;

// A web build: served on the Deck and shown full screen in the first browser installed from Discover.
// With --glitchless-intake=URL, localhost:7777 on the Deck forwards to that Glitchless server, so a game
// that sends to http://localhost:7777 reports to this computer without a change.
export const KIOSK_SH = `#!/bin/sh
# Written by glitchless-deck: serves this web build on the Deck and shows it in a browser in kiosk mode.
cd "$(dirname "$0")" || exit 1
port=8765
query=
for arg in "$@"; do
  case "$arg" in
    --port=*) port="\${arg#--port=}" ;;
    --query=*) query="\${arg#--query=}" ;;
  esac
done
python3 ./.glitchless-kiosk.py "$port" "$@" &
server=$!
trap 'kill $server 2>/dev/null' EXIT INT TERM
for i in 1 2 3 4 5 6 7 8 9 10; do
  python3 -c "import socket,sys; socket.create_connection(('127.0.0.1', int(sys.argv[1])), 0.5)" "$port" 2>/dev/null && break
  sleep 0.3
done
url="http://127.0.0.1:$port/$query"
for app in com.google.Chrome org.chromium.Chromium com.microsoft.Edge com.brave.Browser; do
  if flatpak info "$app" >/dev/null 2>&1; then
    flatpak run "$app" --user-data-dir="$HOME/.var/app/$app/glitchless-kiosk" --kiosk --start-fullscreen --no-first-run --noerrdialogs --disable-session-crashed-bubble --autoplay-policy=no-user-gesture-required --password-store=basic "$url"
    exit $?
  fi
done
if flatpak info org.mozilla.firefox >/dev/null 2>&1; then
  flatpak run org.mozilla.firefox --kiosk "$url"
  exit $?
fi
echo "glitchless-deck: no browser on the Deck. Install Google Chrome or Chromium from Discover (Desktop Mode), then start the game again." >&2
exit 1
`;

export const KIOSK_PY = `# Written by glitchless-deck: the web server for .glitchless-kiosk.sh.
import functools, http.server, os, socketserver, sys, threading, urllib.error, urllib.request

port = int(sys.argv[1])
intake = next((a.split("=", 1)[1] for a in sys.argv[2:] if a.startswith("--glitchless-intake=")), "").rstrip("/")


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Files(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


class Forward(http.server.BaseHTTPRequestHandler):
    def forward(self):
        size = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(size) if size else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "content-length", "connection")}
        request = urllib.request.Request(intake + self.path, data=body, method=self.command, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=15) as reply:
                code, got, data = reply.status, reply.headers, reply.read()
        except urllib.error.HTTPError as error:
            code, got, data = error.code, error.headers, error.read()
        except Exception as error:
            code, got, data = 502, {}, str(error).encode()
        self.send_response(code)
        for k, v in got.items():
            if k.lower() not in ("transfer-encoding", "connection", "content-length"):
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_OPTIONS = forward

    def log_message(self, *args):
        pass


if intake:
    threading.Thread(target=Server(("127.0.0.1", 7777), Forward).serve_forever, daemon=True).start()
Server(("127.0.0.1", port), functools.partial(Files, directory=os.getcwd())).serve_forever()
`;

export const HELPER = String.raw`
import base64, glob, hashlib, json, os, shutil, stat, struct, tempfile, time, urllib.parse, urllib.request

A = ARGS
HOME = os.path.expanduser("~")
GAMES = os.path.join(HOME, "devkit-game")
OURS = os.path.join(HOME, ".local", "share", "glitchless-deck")
STEAM = os.path.join(HOME, ".steam")
PROTECTED = (".glitchless-run.sh", ".glitchless-kiosk.sh", ".glitchless-kiosk.py")
ART = {"capsule": "%sp", "wide": "%s", "hero": "%s_hero", "logo": "%s_logo", "icon": "%s_icon"}


def game_dir(gameid):
    if "/" in gameid or gameid.startswith("."):
        raise RuntimeError("bad game id")
    return os.path.join(GAMES, gameid)


def inside(root, rel):
    path = os.path.normpath(os.path.join(root, rel))
    if not path.startswith(root + os.sep):
        raise RuntimeError("path outside the game: " + rel)
    return path


def steam_running():
    try:
        os.kill(int(open(os.path.join(STEAM, "steam.pid")).read().strip()), 0)
        return True
    except Exception:
        return False


def steam(command, params, wait=10):
    """Asks the running Steam client through its devkit pipe; it answers in the file named "response"."""
    if not steam_running():
        raise RuntimeError("Steam is not running on the Deck.")
    folder = tempfile.mkdtemp(prefix="glitchless-deck-")
    response = os.path.join(folder, "response")
    try:
        token = open(os.path.join(STEAM, "steam.token")).read().strip()
        query = urllib.parse.urlencode(dict([("response", response)] + list(params.items())))
        with open(os.path.realpath(os.path.join(STEAM, "steam.pipe")), "wb+", 0) as pipe:
            pipe.write(("devkit-1 steam://devkit-1/%s/%s?%s\n" % (token, command, query)).encode("utf-8"))
        deadline = time.time() + wait
        while time.time() < deadline:
            time.sleep(0.25)
            if os.path.exists(response + ".error"):
                raise RuntimeError("Steam refused: " + (open(response + ".error").read().strip() or command))
            if os.path.exists(response) and not os.path.exists(response + ".lock"):
                return open(response).read().strip()
        raise RuntimeError("Steam did not answer. Is Developer Mode still on?")
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def games_on_deck():
    if not os.path.isdir(GAMES):
        return []
    return sorted(d for d in os.listdir(GAMES) if os.path.isdir(os.path.join(GAMES, d)) and not os.path.islink(os.path.join(GAMES, d)))


def sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def cache_file(gameid):
    return os.path.join(OURS, "manifests", gameid + ".json")


def load_cache(gameid):
    try:
        return json.load(open(cache_file(gameid)))
    except Exception:
        return {}


def save_cache(gameid, cache):
    os.makedirs(os.path.dirname(cache_file(gameid)), exist_ok=True)
    with open(cache_file(gameid), "w") as f:
        json.dump(cache, f)


def manifest(gameid):
    """Every file in the game's folder with its size and hash (hashes kept between sends)."""
    root = game_dir(gameid)
    cache = load_cache(gameid)
    files, links, dirs, fresh = {}, {}, [], {}
    if os.path.isdir(root):
        for here, subdirs, names in os.walk(root):
            for d in list(subdirs):
                full = os.path.join(here, d)
                rel = os.path.relpath(full, root)
                if os.path.islink(full):
                    links[rel] = os.readlink(full)
                    subdirs.remove(d)
                else:
                    dirs.append(rel)
            for name in names:
                full = os.path.join(here, name)
                rel = os.path.relpath(full, root)
                if here == root and name in PROTECTED:
                    continue
                if os.path.islink(full):
                    links[rel] = os.readlink(full)
                    continue
                st = os.stat(full)
                known = cache.get(rel)
                digest = known[2] if known and known[0] == st.st_size and known[1] == st.st_mtime_ns else sha1(full)
                fresh[rel] = [st.st_size, st.st_mtime_ns, digest]
                files[rel] = [st.st_size, digest]
    save_cache(gameid, fresh)
    return {"files": files, "links": links, "dirs": dirs}


def prune(gameid, remove, keep_dirs, sent):
    root = game_dir(gameid)
    for rel in remove:
        path = inside(root, rel)
        if os.path.islink(path) or os.path.isfile(path):
            os.unlink(path)
        elif os.path.isdir(path):
            shutil.rmtree(path)
    keep = set(keep_dirs)
    for here, subdirs, names in os.walk(root, topdown=False):
        rel = os.path.relpath(here, root)
        if here != root and rel not in keep and not os.listdir(here):
            os.rmdir(here)
    cache = load_cache(gameid)
    for rel in remove:
        cache.pop(rel, None)
    for rel, digest in sent.items():
        path = inside(root, rel)
        if os.path.isfile(path) and not os.path.islink(path):
            st = os.stat(path)
            cache[rel] = [st.st_size, st.st_mtime_ns, digest]
    save_cache(gameid, cache)
    return {"removed": len(remove)}


def write_file(path, text, mode):
    with open(path, "w") as f:
        f.write(text)
    os.chmod(path, mode)


def install(a):
    """Writes how Steam starts the game, then asks Steam to add it (or update it) in the library."""
    gameid = a["gameid"]
    folder = game_dir(gameid)
    if a.get("link_to"):
        target = game_dir(a["link_to"])
        if not os.path.isdir(target):
            raise RuntimeError("%s is not on the Deck. Send it first." % a["link_to"])
        if os.path.islink(folder):
            os.unlink(folder)
        elif os.path.isdir(folder):
            shutil.rmtree(folder)
        os.symlink(a["link_to"], folder)
    if not os.path.isdir(folder):
        raise RuntimeError("the game's folder is not on the Deck")
    for name, text in (a.get("files") or {}).items():
        write_file(inside(folder, name), text, 0o755 if name.endswith(".sh") else 0o644)
    for rel in a.get("executable", []):
        path = inside(folder, rel)
        if os.path.isfile(path):
            os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    with open(os.path.join(GAMES, gameid + "-argv.json"), "w") as f:
        json.dump(a["argv"], f)
    settings_path = os.path.join(GAMES, gameid + "-settings.json")
    settings = {}
    try:
        settings = json.load(open(settings_path))
    except Exception:
        pass
    settings.update(a.get("settings") or {})
    with open(settings_path, "w") as f:
        json.dump(settings, f)
    env_path = os.path.join(GAMES, gameid + "-env.json")
    if a.get("env"):
        with open(env_path, "w") as f:
            json.dump(a["env"], f)
    elif os.path.exists(env_path):
        os.unlink(env_path)
    if not steam_running():
        raise RuntimeError("Steam is not running on the Deck, so it could not be added to the library. The files are in place.")
    return {"success": steam("create-shortcut", {"gameid": gameid}, a.get("wait", 10)) or "added"}


def userdata_dirs():
    roots = [os.path.join(HOME, ".local", "share", "Steam", "userdata"), os.path.join(STEAM, "steam", "userdata")]
    seen, out = set(), []
    for r in roots:
        for d in glob.glob(os.path.join(r, "*")):
            real = os.path.realpath(d)
            if os.path.isdir(real) and real not in seen and os.path.basename(d).isdigit() and os.path.basename(d) != "0":
                seen.add(real)
                out.append(real)
    return out


def parse_vdf(data, i=0):
    """Steam's binary key-value format, as in shortcuts.vdf."""
    out = {}
    while i < len(data):
        kind = data[i]
        i += 1
        if kind == 8:
            return out, i
        end = data.index(b"\0", i)
        key = data[i:end].decode("utf-8", "replace")
        i = end + 1
        if kind == 0:
            out[key], i = parse_vdf(data, i)
        elif kind == 1:
            end = data.index(b"\0", i)
            out[key] = data[i:end].decode("utf-8", "replace")
            i = end + 1
        elif kind == 2:
            out[key] = struct.unpack("<i", data[i:i + 4])[0]
            i += 4
        elif kind == 7:
            out[key] = struct.unpack("<Q", data[i:i + 8])[0]
            i += 8
        else:
            raise ValueError("unknown value type %d" % kind)
    return out, i


def shortcuts():
    found = []
    for user in userdata_dirs():
        path = os.path.join(user, "config", "shortcuts.vdf")
        try:
            tree = parse_vdf(open(path, "rb").read())[0]
        except Exception:
            continue
        for entry in (tree.get("shortcuts") or {}).values():
            lower = dict((k.lower(), v) for k, v in entry.items())
            found.append({"user": user, "appid": (lower.get("appid") or 0) & 0xFFFFFFFF, "name": lower.get("appname"), "devkit": lower.get("devkitgameid"), "exe": lower.get("exe"), "keys": sorted(entry.keys())})
    return found


def find_shortcut(gameid):
    for s in shortcuts():
        if (s["devkit"] or "").lower() == gameid.lower() or s["name"] == "Devkit Game: " + gameid:
            return s
    return None


def art(gameid, images, clear):
    shortcut = find_shortcut(gameid)
    if not shortcut or not shortcut["appid"]:
        raise RuntimeError("Steam has not written %s's library entry yet, so its artwork has nowhere to go. Send it again in a moment." % gameid)
    grid = os.path.join(shortcut["user"], "config", "grid")
    os.makedirs(grid, exist_ok=True)
    written = []
    for kind in list(images) + list(clear):
        stem = ART[kind] % shortcut["appid"]
        for old in glob.glob(os.path.join(grid, stem + ".*")):
            os.unlink(old)
    for kind, image in images.items():
        path = os.path.join(grid, (ART[kind] % shortcut["appid"]) + "." + image["ext"])
        with open(path, "wb") as f:
            f.write(base64.b64decode(image["b64"]))
        written.append(os.path.basename(path))
    return {"appid": shortcut["appid"], "written": written, "grid": grid}


def remove(gameid):
    removed, warnings = [], []
    if os.path.isdir("/proc"):
        stop(gameid, 5)
    for g in (gameid + "_measure", gameid):
        shortcut = find_shortcut(g)
        if shortcut and shortcut["appid"]:
            grid = os.path.join(shortcut["user"], "config", "grid")
            for stem in ART.values():
                for old in glob.glob(os.path.join(grid, (stem % shortcut["appid"]) + ".*")):
                    os.unlink(old)
        if os.path.lexists(game_dir(g)) and steam_running():
            try:
                steam("delete-shortcut", {"gameid": g})
            except Exception as error:
                warnings.append("%s: %s" % (g, error))
        for path in [game_dir(g)] + [os.path.join(GAMES, g + s) for s in ("-argv.json", "-settings.json", "-env.json")] + [cache_file(g)]:
            if os.path.islink(path) or os.path.isfile(path):
                os.unlink(path)
                removed.append(path)
            elif os.path.isdir(path):
                shutil.rmtree(path)
                removed.append(path)
    if not steam_running():
        warnings.append("Steam is not running, so its library still lists the game until Steam next syncs devkit games.")
    return {"removed": removed, "warnings": warnings}


def running(gameid):
    """Processes started from the game's folder (or its measure twin): the game, and the wrapper or browser it runs in."""
    roots = [os.path.realpath(game_dir(gameid))]
    pids = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit() or int(entry) == os.getpid():
            continue
        try:
            cwd = os.path.realpath(os.readlink("/proc/%s/cwd" % entry))
            cmd = open("/proc/%s/cmdline" % entry, "rb").read().split(b"\0")
        except Exception:
            continue
        if b"reaper" in cmd[0]:
            continue
        if any(cwd == r or cwd.startswith(r + os.sep) for r in roots):
            pids.append(int(entry))
    return pids


def stop(gameid, wait):
    import signal
    pids = running(gameid) + running(gameid + "_measure") if os.path.lexists(game_dir(gameid + "_measure")) else running(gameid)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    deadline = time.time() + wait
    while time.time() < deadline and any(os.path.exists("/proc/%d" % p) for p in pids):
        time.sleep(0.2)
    killed = []
    for pid in pids:
        if os.path.exists("/proc/%d" % pid):
            try:
                os.kill(pid, signal.SIGKILL)
                killed.append(pid)
            except OSError:
                pass
    return {"stopped": len(pids), "forced": len(killed)}


def tail(path, lines):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 200000))
            return "\n".join(f.read().decode("utf-8", "replace").splitlines()[-lines:])
    except Exception:
        return None


def newest(patterns, since):
    best = None
    for pattern in patterns:
        for path in glob.glob(os.path.expanduser(pattern)):
            try:
                m = os.path.getmtime(path)
            except OSError:
                continue
            if m >= since and (best is None or m > best[0]):
                best = (m, path)
    return best[1] if best else None


ENGINE_LOGS = {
    "godot": ["~/.local/share/godot/app_userdata/*/logs/godot.log", "~/.local/share/*/logs/godot.log"],
    "unity": ["~/.config/unity3d/*/*/Player.log"],
    "unreal": ["~/.config/Epic/*/Saved/Logs/*.log", "~/.local/share/Steam/steamapps/compatdata/*/pfx/drive_c/users/steamuser/AppData/Local/*/Saved/Logs/*.log", "~/devkit-game/%s/*/Saved/Logs/*.log"],
    "proton": ["~/steam-*.log"],
}


def logs(a):
    """What the last run printed (the game's or its measure run's, whichever was later), and the
    engine's own log where it says more (Godot prints all of its log, so its file is not repeated).
    With "all": every run kept, and the engine log too."""
    gameid, lines = a["gameid"], a.get("lines", 80)
    out = []
    kept = []
    for name in (gameid, gameid + "_measure"):
        for suffix in (".log", ".previous.log") if a.get("all") else (".log",):
            path = os.path.join(OURS, "logs", name + suffix)
            if os.path.exists(path):
                kept.append(path)
    kept.sort(key=os.path.getmtime, reverse=True)
    for path in kept if a.get("all") else kept[:1]:
        out.append({"path": path, "modified": os.path.getmtime(path), "text": tail(path, lines)})
    since = time.time() - 6 * 3600
    engines = [a.get("engine")] if a.get("all") or not kept or a.get("engine") != "godot" else []
    for engine in engines + (["proton"] if a.get("proton") else []):
        patterns = [p % gameid if "%s" in p else p for p in ENGINE_LOGS.get(engine or "", [])]
        path = newest(patterns, since)
        if path:
            out.append({"path": path, "modified": os.path.getmtime(path), "text": tail(path, lines)})
    return {"logs": out}


def wait_file(path, timeout, gameid, watch):
    """Waits for the game to write its measurement. With watch, a game that has quit without writing
    it (nothing runs from its folder twice running, after it had time to start) ends the wait early."""
    started = time.time()
    deadline = started + timeout
    last, gone = -1, 0
    while time.time() < deadline:
        if os.path.exists(path):
            size = os.path.getsize(path)
            if size > 0 and size == last:
                return {"content": open(path).read()}
            last = size
        elif watch and time.time() - started > 12:
            gone = gone + 1 if not running(gameid) else 0
            if gone >= 2:
                return {"error": "quit", "log": tail(os.path.join(OURS, "logs", gameid + ".log"), 25)}
        time.sleep(1)
    return {"error": "timeout", "log": tail(os.path.join(OURS, "logs", gameid + ".log"), 25)}


def http_check(url, timeout):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as reply:
            return {"ok": True, "status": reply.status}
    except Exception as error:
        return {"ok": False, "error": str(error)}


def main(a):
    do = a["do"]
    if do == "hello":
        out = {"user": os.environ.get("USER") or os.path.basename(HOME), "home": HOME, "steam": steam_running(), "games": games_on_deck()}
        if a.get("shortcuts") and out["steam"]:
            try:
                out["registered"] = json.loads(steam("list-shortcuts", {})).get("gameids", [])
            except Exception as error:
                out["registered_error"] = str(error)
        return out
    if do == "prepare":
        os.makedirs(game_dir(a["gameid"]), exist_ok=True)
        for sub in ("logs", "measure", "manifests"):
            os.makedirs(os.path.join(OURS, sub), exist_ok=True)
        return {"home": HOME, "folder": game_dir(a["gameid"])}
    if do == "manifest":
        return manifest(a["gameid"])
    if do == "prune":
        return prune(a["gameid"], a.get("remove", []), a.get("keep_dirs", []), a.get("sent", {}))
    if do == "install":
        return install(a)
    if do == "steam":
        return {"success": steam(a["command"], a.get("params", {}), a.get("wait", 10))}
    if do == "shortcuts":
        return {"shortcuts": shortcuts()}
    if do == "art":
        return art(a["gameid"], a.get("images", {}), a.get("clear", []))
    if do == "remove":
        return remove(a["gameid"])
    if do == "logs":
        return logs(a)
    if do == "running":
        return {"pids": running(a["gameid"])}
    if do == "stop":
        return stop(a["gameid"], a.get("wait", 5))
    if do == "clear":
        for path in a["paths"]:
            if os.path.exists(path):
                os.unlink(path)
        return {"ok": True}
    if do == "wait_file":
        return wait_file(a["path"], a.get("timeout", 120), a.get("gameid", ""), a.get("watch", False) and os.path.isdir("/proc"))
    if do == "http_check":
        return http_check(a["url"], a.get("timeout", 4))
    raise RuntimeError("unknown step " + do)


try:
    result = main(A)
except Exception as error:
    result = {"error": str(error)}
print(json.dumps(result))
`;
