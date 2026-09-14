"""Cancellation REST contract: stop intent is not proof of stopped workers."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from hermes_cli import kanban_db as kb
from plugins.kanban.dashboard.plugin_api import router


@pytest.fixture
def client(tmp_path, monkeypatch):
    home = tmp_path / "hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    app = FastAPI()
    app.include_router(router, prefix="/kanban")
    with TestClient(app) as client:
        yield client


def test_cancel_endpoint_retains_history_and_reports_verified_cleanup(client):
    with kb.connect_closing() as conn:
        task_id = kb.create_task(conn, title="Stop queued task", assignee="default")
        kb.add_comment(conn, task_id, "default", "Preserve this discussion")
    response = client.post(f"/kanban/tasks/{task_id}/cancel", json={"reason": "User requested stop"})
    assert response.status_code == 200
    assert response.json()["worker_stopped"] is True
    detail = client.get(f"/kanban/tasks/{task_id}").json()
    assert detail["task"]["status"] == "cancelled"
    assert detail["task"]["cancellation_supported"] is True
    assert detail["task"]["cancellation_pending"] is False
    assert detail["comments"][0]["body"] == "Preserve this discussion"
    assert detail["events"][-1]["kind"] == "cancel_cleanup"
    assert detail["events"][-1]["payload"]["worker_stopped"] is True
    assert client.post(f"/kanban/tasks/{task_id}/cancel", json={}).json()["ok"]


def test_cancel_endpoint_reports_pending_without_a_false_error_or_success(client):
    with kb.connect_closing() as conn:
        task_id = kb.create_task(conn, title="Worker startup pending", assignee="default")
        assert kb.claim_task(conn, task_id)
    response = client.post(f"/kanban/tasks/{task_id}/cancel", json={})
    assert response.status_code == 200  # intent committed; not an HTTP rollback
    assert response.json()["status"] == "cancelled"
    assert response.json()["worker_stopped"] is False
    assert response.json()["ok"] is False
    detail = client.get(f"/kanban/tasks/{task_id}").json()["task"]
    assert detail["cancellation_pending"] is True
    events = client.get(f"/kanban/tasks/{task_id}").json()["events"]
    assert events[-1]["kind"] == "cancel_cleanup" and events[-1]["payload"]["worker_stopped"] is False
    assert client.patch(f"/kanban/tasks/{task_id}", json={"status": "ready"}).status_code == 409
    assert client.delete(f"/kanban/tasks/{task_id}").status_code == 409


def test_cancel_endpoint_is_board_scoped_and_cannot_rewrite_finished_work(client):
    kb.create_board("other")
    with kb.connect_closing() as conn:
        task_id = kb.create_task(conn, title="Default board task", assignee="default")
    assert client.post(f"/kanban/tasks/{task_id}/cancel?board=other", json={}).status_code == 404
    with kb.connect_closing() as conn:
        assert kb.get_task(conn, task_id).status == "ready"
        assert kb.complete_task(conn, task_id, summary="Keep completed result")
    assert client.post(f"/kanban/tasks/{task_id}/cancel", json={}).status_code == 409
    assert client.get(f"/kanban/tasks/{task_id}").json()["task"]["status"] == "done"
