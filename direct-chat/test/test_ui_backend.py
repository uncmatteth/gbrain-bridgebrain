"""Unit tests for desktop validation. Never move the host computer's mouse."""
import importlib.util
from pathlib import Path
import os
import unittest
from unittest.mock import Mock, patch
spec = importlib.util.spec_from_file_location("ui_backend", Path(__file__).resolve().parents[1] / "ui_backend.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class DesktopValidation(unittest.TestCase):
    def setUp(self):
        self.backend = module.Backend("unused-state")
        self.gui = Mock()
        self.gui.size.return_value = (1920, 1080)
        self.gui.KEYBOARD_KEYS = ["ctrl", "c", "enter"]
        self.backend.gui = self.gui
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
    def tearDown(self):
        self.env.stop()
    def test_click_uses_native_coordinates(self):
        self.backend.desktop({"operation": "click", "x": 100, "y": 200})
        self.gui.click.assert_called_once_with(100, 200, clicks=1, interval=0.1, button="left")
    def test_invalid_coordinates_are_not_executed(self):
        with self.assertRaises(ValueError):
            self.backend.desktop({"operation": "move", "x": 1920, "y": 0})
        self.gui.moveTo.assert_not_called()
    def test_hotkey_validation(self):
        with self.assertRaises(ValueError):
            self.backend.desktop({"operation": "hotkey", "keys": ["made-up"]})
        self.gui.hotkey.assert_not_called()
        self.backend.desktop({"operation": "hotkey", "keys": ["ctrl", "c"]})
        self.gui.hotkey.assert_called_once_with("ctrl", "c")
    def test_unicode_desktop_typing_is_not_faked(self):
        with self.assertRaises(ValueError):
            self.backend.desktop({"operation": "type", "text": "café"})
        self.gui.write.assert_not_called()
    def test_wayland_fails_explicitly(self):
        with patch.dict(os.environ, {"WAYLAND_DISPLAY": "wayland-0"}):
            with self.assertRaisesRegex(ValueError, "Wayland"):
                self.backend.desktop({"operation": "status"})
    def test_status_does_not_claim_multiple_monitors(self):
        self.assertTrue(self.backend.desktop({"operation": "status"})["primary_display_only"])


@unittest.skipUnless(os.environ.get("BRIDGEBRAIN_UI_TESTS") == "1", "Optional real Chromium test")
class BrowserFixture(unittest.TestCase):
    def test_real_browser_actions_on_in_memory_fixture(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            backend = module.Backend(directory, os.environ.get("BRIDGEBRAIN_TEST_CHROMIUM"))
            try:
                backend.browser({"operation": "start", "headless": True})
                page = backend.tab()
                page.set_content('''<!doctype html><title>Fixture</title><input id="name"><button id="go" onclick="document.getElementById('out').textContent=document.getElementById('name').value">Go</button><div id="out"></div><input type="file" id="file"><select id="pick"><option value="a">A</option><option value="b">B</option></select><a id="download" download="fixture.txt">Download</a>''')
                page.evaluate("document.getElementById('download').href = URL.createObjectURL(new Blob(['download fixture'], {type:'text/plain'}))")
                backend.browser({"operation": "fill", "selector": "#name", "text": "Unicode works: café"})
                backend.browser({"operation": "click", "selector": "#go"})
                self.assertIn("Unicode works: café", backend.browser({"operation": "snapshot"})["text"])
                backend.browser({"operation": "select", "selector": "#pick", "text": "b"})
                self.assertEqual(page.locator("#pick").input_value(), "b")
                upload = Path(directory) / "upload.txt"
                upload.write_text("upload fixture")
                backend.browser({"operation": "upload", "selector": "#file", "file": str(upload)})
                self.assertEqual(page.locator("#file").evaluate("e => e.files[0].name"), "upload.txt")
                target = Path(directory) / "download.txt"
                backend.browser({"operation": "download", "selector": "#download", "file": str(target), "path": "download.txt"})
                self.assertEqual(target.read_text(), "download fixture")
                with self.assertRaises(ValueError):
                    backend.browser({"operation": "download", "selector": "#download", "file": str(target), "path": "download.txt"})
                shot = backend.browser({"operation": "screenshot"})
                self.assertEqual(shot["native_width"], 1440)
                self.assertTrue(shot["_image"])
            finally:
                backend.close_browser()

if __name__ == "__main__":
    unittest.main()
