import contextlib
from hermes_state import SessionDB


def test_cloud_history_pages_all_conversations_without_internal_runs(tmp_path,monkeypatch):
    from tui_gateway import server
    db=SessionDB(tmp_path/'history.db')
    try:
        for index in range(135):
            db.create_session('s'+str(index),'studio' if index%2 else 'cli')
        for index in range(20):db.create_session('tool'+str(index),'tool')
        @contextlib.contextmanager
        def profile(_):yield db
        monkeypatch.setattr(server,'_profile_db',profile)
        offset=0;seen=[]
        while offset is not None:
            result=server._methods['session.list']('id',{'paged':True,'offset':offset,'limit':60})['result']
            seen.extend(row['id'] for row in result['sessions']);offset=result['nextOffset']
        assert len(seen)==135 and len(set(seen))==135
        assert all(not value.startswith('tool') for value in seen)
    finally:db.close()
