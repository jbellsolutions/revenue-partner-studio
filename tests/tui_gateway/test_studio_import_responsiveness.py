import threading


def test_slow_import_keeps_native_status_and_websocket_dispatch_responsive(monkeypatch):
    from tui_gateway import server
    started=threading.Event();release=threading.Event();finished=threading.Event()
    class Transport:
        def write(self,response):finished.set()
    def slow(rid,params):
        started.set();release.wait(3)
        return server._ok(rid,{'profiles':[]})
    monkeypatch.setitem(server._methods,'studio.operation',slow)
    monkeypatch.setitem(server._methods,'studio.capabilities',lambda rid,p:server._ok(rid,{'connected':True}))
    try:
        assert server.dispatch({'id':'import','method':'studio.operation','params':{}},Transport()) is None
        assert started.wait(1)
        assert server.dispatch({'id':'status','method':'studio.capabilities','params':{}})['result']['connected']
        assert not finished.is_set()
    finally:
        release.set();assert finished.wait(2)
