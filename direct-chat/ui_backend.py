#!/usr/bin/env python3
"""Optional local GUI tools. No AI client, credential extraction or web proxy."""
import argparse
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys


def doctor():
    return {
        "python": sys.version.split()[0],
        "playwright_installed": importlib.util.find_spec("playwright") is not None,
        "pyautogui_installed": importlib.util.find_spec("pyautogui") is not None,
        "pillow_installed": importlib.util.find_spec("PIL") is not None,
        "wayland_detected": bool(os.environ.get("WAYLAND_DISPLAY")),
        "display_detected": bool(os.environ.get("DISPLAY")) or sys.platform in ("darwin", "win32"),
        "browser_and_desktop_live_verification": "not performed by doctor",
    }


def image_result(image):
    width, height = image.size
    image = image.convert("RGB")
    image.thumbnail((1920, 1920))
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=75)
    return {
        "_image": base64.b64encode(output.getvalue()).decode("ascii"),
        "mimeType": "image/jpeg",
        "native_width": width, "native_height": height,
        "image_width": image.width, "image_height": image.height,
        "coordinate_note": "Mouse tools use native screen coordinates, not resized image coordinates.",
    }


class Backend:
    def __init__(self, state, executable=None):
        self.state = Path(state)
        self.executable = executable
        self.driver = None
        self.context = None
        self.browser_process = None
        self.pages = {}
        self.next_tab = 0
        self.gui = None

    def tab(self, identifier=None):
        if not self.context:
            raise ValueError("Browser is not started. Call browser with operation=start first.")
        self.refresh_tabs()
        if identifier is None and self.pages:
            return next(iter(self.pages.values()))
        if identifier not in self.pages:
            raise ValueError("Unknown tab. Call browser with operation=tabs.")
        return self.pages[identifier]

    def refresh_tabs(self):
        self.pages = {key: page for key, page in self.pages.items() if not page.is_closed()}
        if self.context:
            for page in self.context.pages:
                if page not in self.pages.values():
                    self.next_tab += 1
                    self.pages[str(self.next_tab)] = page

    def browser(self, a):
        op = a["operation"]
        if op == "start":
            if not self.context:
                from playwright.sync_api import sync_playwright
                self.driver = sync_playwright().start()
                options = {"headless": a.get("headless", False)}
                if self.executable:
                    options["executable_path"] = self.executable
                try:
                    self.browser_process = self.driver.chromium.launch(**options)
                    self.context = self.browser_process.new_context(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
                    self.context.new_page()
                    self.context.set_default_timeout(20000)
                except Exception:
                    self.driver.stop()
                    self.driver = None
                    raise
            op = "tabs"
        if op == "stop":
            self.close_browser()
            return {"stopped": True}
        if not self.context:
            raise ValueError("Start the browser first. Optional Playwright and its Chromium runtime are required.")
        if op == "tabs":
            self.refresh_tabs()
            return [{"tab": key, "url": page.url, "title": page.title()} for key, page in self.pages.items()]
        if op == "new_tab":
            page = self.context.new_page()
            if a.get("url"):
                self.navigate(page, a["url"])
            self.refresh_tabs()
            return {"tab": next(key for key, value in self.pages.items() if value is page), "url": page.url}
        page = self.tab(a.get("tab"))
        if op == "navigate":
            self.navigate(page, a["url"])
        elif op == "snapshot":
            return {
                "url": page.url, "title": page.title(),
                "text": page.locator("body").inner_text()[:24000],
                "elements": page.evaluate("""() => [...document.querySelectorAll('a,button,input,textarea,select,[role=button]')].slice(0,100).map((e,i) => {
                    e.setAttribute('data-bb-ref', String(i));
                    return {selector:'[data-bb-ref="'+i+'"]',tag:e.tagName.toLowerCase(),type:e.getAttribute('type'),name:(e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.textContent||'').slice(0,160)};
                })"""),
            }
        elif op == "screenshot":
            from PIL import Image
            return image_result(Image.open(io.BytesIO(page.screenshot(type="png", animations="disabled"))))
        elif op == "click":
            page.locator(a["selector"]).click()
        elif op == "fill":
            page.locator(a["selector"]).fill(a["text"])
        elif op == "press":
            if a.get("selector"):
                page.locator(a["selector"]).press(a["key"])
            else:
                page.keyboard.press(a["key"])
        elif op == "select":
            page.locator(a["selector"]).select_option(a["text"])
        elif op == "scroll":
            page.mouse.wheel(a.get("x", 0), a.get("y", 500))
        elif op == "upload":
            page.locator(a["selector"]).set_input_files(a["file"])
        elif op == "download":
            target = Path(a["file"])
            if target.exists():
                raise ValueError("Download destination already exists")
            with page.expect_download() as pending:
                page.locator(a["selector"]).click()
            download = pending.value
            failure = download.failure()
            if failure:
                raise RuntimeError("Browser download failed")
            # Exclusive creation avoids silently replacing a concurrent local edit.
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(descriptor, "wb") as output, open(download.path(), "rb") as source:
                    shutil.copyfileobj(source, output)
            except Exception:
                target.unlink(missing_ok=True)
                raise
            return {"saved": a["path"], "bytes": target.stat().st_size}
        elif op == "close_tab":
            page.close()
            self.refresh_tabs()
            return {"closed": True}
        else:
            raise ValueError("Unsupported browser operation")
        return {"operation": op, "url": page.url, "completed": True}

    @staticmethod
    def navigate(page, url):
        from urllib.parse import urlsplit
        if urlsplit(url).scheme not in ("http", "https"):
            raise ValueError("Navigation only supports HTTP(S), not local file or javascript URLs")
        page.goto(url, wait_until="domcontentloaded", timeout=20000)

    def desktop(self, a):
        if os.environ.get("WAYLAND_DISPLAY"):
            raise ValueError("This desktop backend does not support Wayland. Use an X11 session or another explicitly authorized backend.")
        if self.gui is None:
            import pyautogui
            self.gui = pyautogui
            self.gui.FAILSAFE = True
        gui = self.gui
        op = a["operation"]
        width, height = gui.size()
        if op == "status":
            return {"width": width, "height": height, "failsafe": True, "primary_display_only": True}
        if op == "screenshot":
            return image_result(gui.screenshot())
        if op in ("move", "click", "double_click", "drag"):
            x, y = a["x"], a["y"]
            if not (0 <= x < width and 0 <= y < height):
                raise ValueError("Coordinates are outside the primary screen")
            if op == "move":
                gui.moveTo(x, y, duration=0.2)
            elif op == "drag":
                gui.dragTo(x, y, duration=0.4, button=a.get("button", "left"))
            else:
                gui.click(x, y, clicks=2 if op == "double_click" else 1, interval=0.1, button=a.get("button", "left"))
        elif op == "scroll":
            gui.scroll(a.get("amount", 1))
        elif op == "press":
            if a["key"] not in gui.KEYBOARD_KEYS:
                raise ValueError("Unsupported key name")
            gui.press(a["key"])
        elif op == "hotkey":
            keys = a["keys"]
            if not keys or any(key not in gui.KEYBOARD_KEYS for key in keys):
                raise ValueError("Unsupported hotkey")
            gui.hotkey(*keys)
        elif op == "type":
            if not a["text"].isascii():
                raise ValueError("Desktop typing supports ASCII; use browser fill for Unicode. Clipboard contents are not read or replaced.")
            gui.write(a["text"], interval=0.01)
        else:
            raise ValueError("Unsupported desktop operation")
        return {"operation": op, "completed": True}

    def close_browser(self):
        if self.context:
            self.context.close()
        if self.browser_process:
            self.browser_process.close()
        if self.driver:
            self.driver.stop()
        self.context = None
        self.browser_process = None
        self.driver = None
        self.pages = {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state")
    parser.add_argument("--chromium-executable")
    parser.add_argument("--doctor", action="store_true")
    args = parser.parse_args()
    if args.doctor:
        print(json.dumps(doctor()))
        return
    backend = Backend(args.state, args.chromium_executable)
    try:
        for line in sys.stdin:
            if len(line) > 4 * 1024 * 1024:
                break
            message = {}
            try:
                message = json.loads(line)
                result = backend.browser(message) if message["kind"] == "browser" else backend.desktop(message)
                response = {"id": message["id"], "result": result}
            except Exception as error:
                # Playwright exception details can include typed input, URLs and
                # paths; return the class plus a safe, actionable generic error.
                detail = str(error) if isinstance(error, (ValueError, ModuleNotFoundError)) else "Local UI action failed. Check optional dependencies, visible desktop/OS permissions, selector, and browser state."
                response = {"id": message.get("id"), "error": f"{type(error).__name__}: {detail}"}
            print(json.dumps(response), flush=True)
    finally:
        backend.close_browser()


if __name__ == "__main__":
    main()
