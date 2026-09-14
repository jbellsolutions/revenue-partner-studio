"""Browser-first MCP controls for the worker's assigned cloud screen only."""
from __future__ import annotations

import io
import json
import time
from contextlib import contextmanager
import os
import subprocess
from typing import Literal

try:
    from mcp.server.mcpserver import MCPServer
    from mcp.server.mcpserver.utilities.types import Image
except ImportError:  # MCP 1.x managed installations.
    from mcp.server.fastmcp import FastMCP as MCPServer
    from mcp.server.fastmcp.utilities.types import Image

from hermes_cli.orgo_screens import action, ensure


def refresh_browser_binding(browser, profile, identity, previous):
    if identity != previous:
        # A slot may now belong to a different Chrome process. Never send a
        # close command to the old URL: it may be another agent's assigned port.
        browser._stop_cdp_supervisor(profile)
        with browser._cleanup_lock:
            browser._active_sessions.pop(profile, None)
    return identity


def interact_with_ref(browser, profile, operation, ref, value=''):
    # agent-browser 0.26 can acknowledge offscreen clicks without changing the
    # page. Scroll the real referenced element before dispatching input.
    if not ref: raise ValueError('A reference from a fresh snapshot is required')
    ref='@'+ref.lstrip('@')
    result=browser._run_browser_command(browser._last_session_key(profile),'scrollintoview',[ref])
    if not result.get('success'):
        return json.dumps({'success':False,'error':result.get('error') or 'Could not reveal the referenced element; no input sent'})
    raw=browser.browser_click(ref,task_id=profile) if operation=='click' else browser.browser_type(ref,value,task_id=profile)
    result=json.loads(raw)
    if result.get('success'):
        # Capture transient confirmations immediately, before another model turn
        # can outlast a toast. This is observation, never a retry of the action.
        try:
            observed=json.loads(browser.browser_snapshot(full=True, task_id=profile))
            if observed.get('success'):
                result.update({key:observed[key] for key in ('snapshot','element_count') if key in observed})
            else: result['verification_error']=observed.get('error','Snapshot unavailable')
        except Exception as exc: result['verification_error']=str(exc)
    return json.dumps(result)


def build_server():
    profile = os.environ.get("ORGO_AGENT_PROFILE", "default")
    info = None
    browser_identity = None
    os.environ["AGENT_BROWSER_ENGINE"] = "chrome"
    os.environ["AGENT_BROWSER_HEADED"] = "true"
    from tools import browser_tool as browser

    server = MCPServer("orgo-screen", instructions=(
        "Operate the assigned visible Chrome browser on this Orgo computer. "
        "Prefer browser_action and use desktop_action only when browser controls cannot do the work. "
        "After success verify the page/screen. A paused or unavailable screen is a blocker, not permission "
        "to switch computers, use another tool provider, or instruct the human to execute commands."
    ))
    @contextmanager
    def surface():
        nonlocal info, browser_identity
        deadline = time.monotonic() + 90
        while True:
            try:
                info = ensure(profile, browser=True)
                break
            except RuntimeError as exc:
                if 'screens are assigned' not in str(exc) or time.monotonic() >= deadline:
                    if 'screens are assigned' in str(exc):
                        from hermes_cli.orgo_screens import cancel_wait
                        cancel_wait(profile)
                    raise
                time.sleep(1)
        os.environ["DISPLAY"] = info["display"]
        os.environ["BROWSER_CDP_URL"] = f"http://127.0.0.1:{info['cdpPort']}"
        with action(info):
            browser_identity = refresh_browser_binding(browser, profile, info['browserId'], browser_identity)
            yield

    def capture():
        from PIL import ImageGrab
        image = ImageGrab.grab(xdisplay=info["display"])
        output = io.BytesIO()
        image.save(output, format="PNG")
        return Image(data=output.getvalue(), format="png")

    @server.tool()
    def browser_action(operation: Literal["navigate", "snapshot", "click", "type", "press", "scroll", "back"],
                       value: str = "", ref: str = "") -> str:
        """Control visible Chrome. Navigate uses value=URL; click/type use snapshot ref;
        type uses value=text; press uses value=key; scroll uses value=up/down.
        Click/type reveal the referenced control and return a complete page snapshot, including non-interactive confirmations.
        """
        with surface():
            if operation == "navigate":
                if not value.startswith(("https://", "http://")):
                    raise ValueError("Navigate requires an HTTP(S) URL")
                return browser.browser_navigate(value, task_id=profile)
            if operation == "snapshot":
                return browser.browser_snapshot(full=True, task_id=profile)
            if operation == "click":
                return interact_with_ref(browser, profile, operation, ref)
            if operation == "type":
                return interact_with_ref(browser, profile, operation, ref, value)
            if operation == "press":
                return browser.browser_press(value, task_id=profile)
            if operation == "scroll":
                return browser.browser_scroll(value, task_id=profile)
            return browser.browser_back(task_id=profile)

    @server.tool()
    def desktop_action(operation: Literal["capture", "click", "type", "key", "scroll"],
                       x: int = 0, y: int = 0, text: str = "", direction: Literal["up", "down"] = "down") -> Image:
        """Capture or operate only this agent's real Orgo screen. Returns a screenshot.
        Use coordinates from a fresh capture. Type and key use text. Never supply secrets.
        """
        with surface():
            command = None
            if operation == "click":
                from PIL import ImageGrab
                width, height = ImageGrab.grab(xdisplay=info["display"]).size
                if not (0 <= x < width and 0 <= y < height):
                    raise ValueError("Click is outside this screen")
                command = ["xdotool", "mousemove", str(x), str(y), "click", "1"]
            elif operation == "type":
                command = ["xdotool", "type", "--clearmodifiers", "--", text]
            elif operation == "key":
                command = ["xdotool", "key", "--clearmodifiers", "--", text]
            elif operation == "scroll":
                command = ["xdotool", "click", "--repeat", "3", "4" if direction == "up" else "5"]
            if command:
                subprocess.run(command, check=True, timeout=15, capture_output=True,
                               env={**os.environ, "DISPLAY": info["display"]})
            return capture()

    return server


if __name__ == "__main__":
    build_server().run(transport="stdio")
