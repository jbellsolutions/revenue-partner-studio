"""Computer-local conversation discovery and explicit legacy-session recovery.

The catalog never uploads a database or scans outside known Hermes locations.
Active and preserved stores are opened read-only. A legacy conversation is
copied into its selected native profile only after the owner opens it with
``resume`` mode; the source store remains untouched.
"""
from __future__ import annotations

import base64
import contextlib
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time


PROFILE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")
LEGACY_NAME = re.compile(r"hermes|ai.?guy|korg|grok|studio", re.I)
AUTOMATION_SOURCES = {"cron", "scheduled", "automation", "heartbeat", "qualification"}


def _store_id(kind: str, path: Path) -> str:
    return hashlib.sha256((kind + "\n" + str(path.resolve())).encode()).hexdigest()[:24]


def _safe_text(value, limit=280):
    if isinstance(value, bytes):
        return "[Attachment retained on this computer]"
    text = str(value or "")
    if text.startswith("\x00json:"):
        try:
            parts = json.loads(text[6:])
            parts = parts if isinstance(parts, list) else [parts]
            text = "\n".join(
                part if isinstance(part, str) else str(part.get("text") or "")
                for part in parts if isinstance(part, (str, dict))
            )
        except (ValueError, TypeError):
            text = "[Structured message retained on this computer]"
    return text.replace("\x00", "")[:limit]


def _timestamp(value):
    if value is None:
        return 0.0
    try:
        number = float(value)
        return number / 1000 if number > 100000000000 else number
    except (TypeError, ValueError):
        try:
            from datetime import datetime
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
        except (TypeError, ValueError):
            return 0.0


def _columns(db, table):
    return {row[1] for row in db.execute("PRAGMA table_info(" + table + ")")}


def _db_identity(path: Path):
    stat = path.stat()
    return stat.st_dev, stat.st_ino


class HistoryCatalog:
    def __init__(self, connector):
        self.connector = connector
        self.home = connector.home
        self.computer = connector.computer
        self._stores = []
        self._scanned = 0.0

    def _active(self):
        result = []
        for agent in self.connector.agents()["agents"]:
            profile = agent["id"]
            path = self.connector.profile(profile) / "state.db"
            if path.is_file():
                result.append({"kind": "active", "storeId": _store_id("active", path),
                    "path": path, "profileId": profile, "profileName": agent["name"],
                    "label": agent["name"], "readOnly": False})
        return result

    def _imported(self):
        result = []
        base = self.home / "studio" / "imports"
        if not base.is_dir():
            return result
        for path in sorted(base.glob("*/[a-zA-Z0-9_-]*/state.db.*.incoming"), reverse=True):
            try:
                source, profile = path.parent.parent.name, path.parent.name
                checksum = path.name.split(".")[2]
            except (IndexError, ValueError):
                continue
            if (path.resolve() != path or not PROFILE.fullmatch(profile) or
                    not re.fullmatch(r"[a-f0-9]{24}", source) or
                    not re.fullmatch(r"[a-f0-9]{10}", checksum)):
                continue
            try:
                self.connector.profile(profile)
            except ValueError:
                continue
            result.append({"kind": "imported", "storeId": _store_id("imported", path),
                "path": path, "profileId": profile, "profileName": profile,
                "sourceBundle": source, "checksum": checksum,
                "label": "Preserved Hermes import", "readOnly": True})
        return result

    def _legacy_candidates(self):
        roots = []
        parent = self.home.parent
        with contextlib.suppress(OSError):
            for child in parent.iterdir():
                if child.is_dir() and LEGACY_NAME.search(child.name):
                    roots.append(child)
        for container in (parent / ".config", parent / "Library" / "Application Support"):
            if not container.is_dir():
                continue
            with contextlib.suppress(OSError):
                roots.extend(child for child in container.iterdir()
                    if child.is_dir() and LEGACY_NAME.search(child.name))
        found = []
        for root in roots[:80]:
            for candidate in [root / "state.db", *root.glob("profiles/*/state.db")]:
                if candidate.is_file():
                    found.append(candidate.resolve())
        return found

    def scan(self, force=False):
        if self._stores and not force and time.monotonic() - self._scanned < 30:
            return list(self._stores)
        stores = self._active() + self._imported()
        seen = set()
        for store in stores:
            with contextlib.suppress(OSError):
                seen.add(_db_identity(store["path"]))
        active_profiles = {s["profileId"] for s in stores if s["kind"] == "active"}
        for path in self._legacy_candidates():
            try:
                identity = _db_identity(path)
            except OSError:
                continue
            if identity in seen or "backup" in {part.lower() for part in path.parts}:
                continue
            seen.add(identity)
            suggested = path.parent.name if path.parent.parent.name == "profiles" else "default"
            profile = suggested if suggested in active_profiles else "default"
            stores.append({"kind": "legacy", "storeId": _store_id("legacy", path),
                "path": path, "profileId": profile, "profileName": suggested,
                "label": "Older Hermes app", "readOnly": True})
        self._stores, self._scanned = stores, time.monotonic()
        return list(stores)

    def _store_status(self, store):
        try:
            with contextlib.closing(sqlite3.connect(store["path"].as_uri() + "?mode=ro", uri=True)) as db:
                if not {"sessions", "messages"}.issubset({r[0] for r in db.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'")}):
                    raise sqlite3.DatabaseError("conversation tables unavailable")
                indexed = bool(db.execute("SELECT 1 FROM sqlite_master WHERE name='messages_fts'").fetchone())
                count = int(db.execute("SELECT count(*) FROM sessions").fetchone()[0])
            rebuild = None
            if store["kind"] == "active":
                with contextlib.suppress(Exception):
                    from hermes_state import SessionDB
                    native = SessionDB(db_path=store["path"], read_only=True)
                    try: rebuild = native.fts_rebuild_status()
                    finally: native.close()
            return {"storeId": store["storeId"], "kind": store["kind"],
                "profileId": store["profileId"], "label": store["label"],
                "status": "indexing" if rebuild else "ready", "sessions": count,
                "search": "full-text" if indexed else "compatible", "index": rebuild}
        except (OSError, sqlite3.Error, ValueError) as exc:
            return {"storeId": store["storeId"], "kind": store["kind"],
                "profileId": store["profileId"], "label": store["label"],
                "status": "unavailable", "error": type(exc).__name__}

    def sources(self):
        stores = self.scan(True)
        return {"computerId": self.computer, "scannedAt": int(time.time() * 1000),
            "stores": [self._store_status(store) for store in stores]}

    def _fallback_rows(self, store, query, limit=250):
        path = store["path"]
        with contextlib.closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
            db.row_factory = sqlite3.Row
            session_cols, message_cols = _columns(db, "sessions"), _columns(db, "messages")
            title = "title" if "title" in session_cols else "id"
            source = "s.source" if "source" in session_cols else "''"
            started = "started_at" if "started_at" in session_cols else "rowid"
            last = "last_activity_at" if "last_activity_at" in session_cols else started
            if query:
                if not {"session_id", "content"}.issubset(message_cols):
                    return []
                title_match = f" OR lower(CAST(s.{title} AS TEXT)) LIKE ?" if "title" in session_cols else ""
                values = ["%" + query.lower() + "%"]
                if title_match:
                    values.append(values[0])
                values.append(limit)
                rows = db.execute(
                    f"SELECT s.id,s.{title} AS title,{source} AS source,s.{started} AS started_at,"
                    f"s.{last} AS last_active,m.content AS preview "
                    "FROM messages m JOIN sessions s ON s.id=m.session_id "
                    f"WHERE (lower(CAST(m.content AS TEXT)) LIKE ?{title_match}) "
                    "GROUP BY s.id ORDER BY max(m.id) DESC LIMIT ?",
                    values).fetchall()
            else:
                preview = "(SELECT content FROM messages m WHERE m.session_id=s.id AND m.role='user' ORDER BY m.id LIMIT 1)" if "role" in message_cols else "''"
                rows = db.execute(
                    f"SELECT s.id,s.{title} AS title,{source} AS source,s.{started} AS started_at,"
                    f"s.{last} AS last_active,{preview} AS preview FROM sessions s "
                    f"ORDER BY s.{last} DESC LIMIT ?", (limit,)).fetchall()
            return [dict(row) for row in rows]

    def _native_rows(self, store, query):
        try:
            from hermes_state import SessionDB
            native = SessionDB(db_path=store["path"], read_only=True)
            try:
                if not query:
                    return native.list_sessions_rich(limit=250, order_by_last_active=True,
                        compact_rows=True, include_archived=True)
                hits = native.search_messages(query=query, role_filter=["user", "assistant"],
                    limit=250, sort="newest", fields=("id", "session_id", "role", "snippet",
                    "source", "model", "session_started"))
                rows, seen = [], set()
                for hit in hits:
                    sid = hit.get("session_id")
                    if not sid or sid in seen:
                        continue
                    seen.add(sid)
                    meta = native.get_session(sid) or {}
                    rows.append({"id": sid, "title": meta.get("title"),
                        "source": meta.get("source") or hit.get("source"),
                        "started_at": meta.get("started_at") or hit.get("session_started"),
                        "last_active": meta.get("last_activity_at") or meta.get("started_at"),
                        "preview": hit.get("snippet") or ""})
                for row in native.list_sessions_rich(limit=100, order_by_last_active=True,
                        compact_rows=True, include_archived=True, search_query=query):
                    if row.get("id") not in seen:
                        rows.append(row); seen.add(row.get("id"))
                return rows
            finally:
                native.close()
        except Exception:
            return self._fallback_rows(store, query)

    @staticmethod
    def _cursor(value, fingerprint):
        if not value:
            return 0
        try:
            data = json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
            if data.get("fingerprint") != fingerprint:
                raise ValueError
            return max(0, int(data["offset"]))
        except (ValueError, TypeError, json.JSONDecodeError):
            raise ValueError("History cursor belongs to a different search")

    def search(self, params, own_profile=None):
        query = str(params.get("query") or "").strip()[:500]
        requested = params.get("profiles")
        if own_profile:
            profiles = {own_profile}
        elif isinstance(requested, list) and requested:
            profiles = {str(value) for value in requested if PROFILE.fullmatch(str(value))}
        else:
            profiles = None
        sources = {str(value).lower() for value in (params.get("sources") or []) if value}
        after, before = _timestamp(params.get("after")), _timestamp(params.get("before"))
        limit = max(1, min(50, int(params.get("limit") or 30)))
        fingerprint = hashlib.sha256(json.dumps([query, sorted(profiles or []), sorted(sources), after, before]).encode()).hexdigest()[:16]
        offset = self._cursor(params.get("cursor"), fingerprint)
        results = []
        for store in self.scan():
            if profiles is not None and store["profileId"] not in profiles:
                continue
            try:
                rows = self._native_rows(store, query)
            except (OSError, sqlite3.Error, ValueError):
                continue
            for rank, row in enumerate(rows):
                source = str(row.get("source") or "unknown").lower()
                started = _timestamp(row.get("started_at"))
                last_active = _timestamp(row.get("last_active") or row.get("last_activity_at")) or started
                if sources and source not in sources:
                    continue
                if after and max(started, last_active) < after:
                    continue
                if before and started > before:
                    continue
                sid = str(row.get("id") or "")
                if not sid:
                    continue
                results.append({"computerId": self.computer, "profileId": store["profileId"],
                    "profileName": store["profileName"], "storeId": store["storeId"],
                    "storeKind": store["kind"], "sessionId": sid,
                    "title": row.get("title") or "Untitled conversation",
                    "preview": _safe_text(row.get("preview")), "source": source,
                    "startedAt": int(started * 1000) if started else None,
                    "lastActive": int(last_active * 1000) if last_active else None,
                    "readOnly": bool(store["readOnly"]), "resumeRequiresImport": store["kind"] == "legacy",
                    "_rank": rank, "_automated": source in AUTOMATION_SOURCES})
        results.sort(key=lambda row: (row["_automated"], row["_rank"], -(row["lastActive"] or 0), row["storeId"], row["sessionId"]))
        page = results[offset:offset + limit]
        for row in page:
            row.pop("_rank", None); row.pop("_automated", None)
            row["ref"] = {key: row[key] for key in ("computerId", "profileId", "storeId", "sessionId")}
        next_offset = offset + len(page)
        cursor = None
        if next_offset < len(results):
            cursor = base64.urlsafe_b64encode(json.dumps({"offset": next_offset,
                "fingerprint": fingerprint}, separators=(",", ":")).encode()).decode().rstrip("=")
        return {"computerId": self.computer, "results": page, "nextCursor": cursor,
            "searchedProfiles": len({s["profileId"] for s in self.scan() if profiles is None or s["profileId"] in profiles}),
            "scannedAt": int(time.time() * 1000)}

    def resolve(self, ref):
        if not isinstance(ref, dict) or ref.get("computerId") != self.computer:
            raise ValueError("Conversation belongs to a different computer")
        profile, store_id, session = str(ref.get("profileId") or ""), str(ref.get("storeId") or ""), str(ref.get("sessionId") or "")
        if not PROFILE.fullmatch(profile) or not store_id or not session or len(session) > 300:
            raise ValueError("Invalid conversation reference")
        store = next((item for item in self.scan() if item["storeId"] == store_id and item["profileId"] == profile), None)
        if not store:
            raise ValueError("Conversation source is no longer available")
        with contextlib.closing(sqlite3.connect(store["path"].as_uri() + "?mode=ro", uri=True)) as db:
            if not db.execute("SELECT 1 FROM sessions WHERE id=?", (session,)).fetchone():
                raise ValueError("Conversation is no longer available in this source")
        return store, session

    @staticmethod
    def _fingerprint(db, sessions):
        digest = hashlib.sha256()
        message_columns = _columns(db, "messages")
        timestamp = "timestamp" if "timestamp" in message_columns else "rowid"
        for sid in sessions:
            for row in db.execute(
                    f"SELECT role,content,{timestamp} FROM messages WHERE session_id=? ORDER BY rowid", (sid,)):
                digest.update(json.dumps([row[0], _safe_text(row[1], 1000000), row[2]], ensure_ascii=False, separators=(",", ":")).encode())
        return digest.hexdigest()

    def materialize(self, store, session, profile):
        if store["kind"] != "legacy":
            raise ValueError("Only an older-app conversation needs recovery")
        destination = self.connector.profile(profile) / "state.db"
        with contextlib.closing(sqlite3.connect(store["path"].as_uri() + "?mode=ro", uri=True)) as source:
            source.row_factory = sqlite3.Row
            source.execute("BEGIN")  # One immutable view even if the older app is still writing.
            lineage = [session]
            if "parent_session_id" in _columns(source, "sessions"):
                cursor = session
                for _ in range(100):
                    row = source.execute("SELECT parent_session_id FROM sessions WHERE id=?", (cursor,)).fetchone()
                    if not row or not row[0] or row[0] in lineage:
                        break
                    lineage.append(str(row[0])); cursor = str(row[0])
                lineage.reverse()
            fingerprint = self._fingerprint(source, lineage)
            with contextlib.closing(sqlite3.connect(self.connector.ledger.path, timeout=30)) as journal:
                mapped = journal.execute(
                    "SELECT destination,fingerprint FROM history_imports WHERE store=? AND source=? AND agent=?",
                    (store["storeId"], session, profile)).fetchone()
            if mapped and mapped[1] == fingerprint:
                return mapped[0]
            source_session = dict(source.execute("SELECT * FROM sessions WHERE id=?", (session,)).fetchone())
            messages = []
            for sid in lineage:
                messages.extend(dict(row) for row in source.execute(
                    "SELECT * FROM messages WHERE session_id=? ORDER BY rowid", (sid,)))

        from hermes_state import SessionDB
        native = SessionDB(db_path=destination)
        try:
            dest_session_columns = _columns(native._conn, "sessions")
            dest_message_columns = _columns(native._conn, "messages")
            base_id = session
            existing = native.get_session(base_id)
            already_present = False
            if existing:
                with contextlib.closing(sqlite3.connect(destination.as_uri() + "?mode=ro", uri=True)) as current:
                    current_fp = self._fingerprint(current, [base_id])
                if current_fp == fingerprint:
                    target, already_present = base_id, True
                else:
                    target = base_id + "-import-" + fingerprint[:10]
                    if native.get_session(target):
                        with contextlib.closing(sqlite3.connect(destination.as_uri() + "?mode=ro", uri=True)) as current:
                            already_present = self._fingerprint(current, [target]) == fingerprint
                        if not already_present:
                            raise ValueError("A recovered conversation identity already belongs to different history")
            else:
                target = base_id

            if not already_present:
                title = source_session.get("title") or source_session.get("display_name")
                if title and native.get_session_by_title(str(title)):
                    title = str(title) + " · recovered " + fingerprint[:6]
                payload = {key: value for key, value in source_session.items()
                    if key in dest_session_columns and key not in {
                        "user_id", "session_key", "chat_id", "chat_type", "thread_id",
                        "parent_session_id", "system_prompt", "system_prompt_hash"}}
                payload.update({"id": target, "source": "studio-import", "title": title,
                    "started_at": _timestamp(source_session.get("started_at")) or time.time(),
                    "messages": [{key: value for key, value in message.items()
                        if key in dest_message_columns and key not in {"id", "session_id"}}
                        for message in messages]})
                imported = native.import_sessions([payload])
                if not imported.get("ok") or not imported.get("imported"):
                    raise ValueError("The older conversation could not be recovered safely")
                provenance = json.dumps({"studioLegacyStore": store["storeId"],
                    "sourceSession": session}, separators=(",", ":"))
                native._execute_write(lambda conn: conn.execute(
                    "UPDATE sessions SET source='studio-import',profile_name=?,origin_json=? WHERE id=?",
                    (profile, provenance, target)), patience_s=30)
        finally:
            native.close()
        with contextlib.closing(sqlite3.connect(self.connector.ledger.path, timeout=30)) as journal:
            journal.execute("INSERT OR REPLACE INTO history_imports VALUES(?,?,?,?,?,?)",
                (store["storeId"], session, profile, target, fingerprint, time.time()))
            journal.commit()
        return target


def search_profile(home: Path, computer: str, profile: str, query: str, limit=5):
    """Search only the running agent's profile for the read-only Studio tool."""
    path = home if profile == "default" else home / "profiles" / profile
    dbpath = path / "state.db"
    if not PROFILE.fullmatch(profile) or path.resolve() != path or not dbpath.is_file():
        raise ValueError("Current agent history is unavailable")
    stub = type("HistoryConnector", (), {})()
    stub.home, stub.computer = home, computer
    stub.agents = lambda: {"agents": [{"id": profile, "name": profile}]}
    stub.profile = lambda name: path if name == profile else (_ for _ in ()).throw(ValueError("Profile access denied"))
    catalog = HistoryCatalog(stub)
    store = {"kind": "active", "storeId": _store_id("active", dbpath), "path": dbpath,
        "profileId": profile, "profileName": profile, "label": profile, "readOnly": False}
    catalog._stores, catalog._scanned = [store], time.monotonic()
    return catalog.search({"query": query, "profiles": [profile], "limit": max(1, min(10, int(limit)))}, own_profile=profile)
