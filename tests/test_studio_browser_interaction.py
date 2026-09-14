import json
from types import SimpleNamespace
from hermes_cli.orgo_screen_mcp import interact_with_ref


def test_input_reveals_the_correct_session_element_first():
    calls=[]
    browser=SimpleNamespace(
        _last_session_key=lambda profile:profile+':actual',
        _run_browser_command=lambda *args: calls.append(args) or {'success':True},
        browser_click=lambda *args,**kwargs: calls.append((args,kwargs)) or '{"success":true}',
        browser_type=lambda *args,**kwargs: calls.append((args,kwargs)) or '{"success":true}',
        browser_snapshot=lambda *,full,task_id:'{"success":true,"snapshot":"Confirmation visible"}')
    assert json.loads(interact_with_ref(browser,'writer','click','e21'))['snapshot']=='Confirmation visible'
    assert calls==[('writer:actual','scrollintoview',['@e21']),(('@e21',),{'task_id':'writer'})]
    calls.clear()
    assert json.loads(interact_with_ref(browser,'writer','type','@e2','Example'))['success']
    assert calls[-1]==(('@e2','Example'),{'task_id':'writer'})


def test_failed_reveal_does_not_send_input():
    def unexpected(*args,**kwargs):raise AssertionError('Input must not be attempted')
    browser=SimpleNamespace(_last_session_key=lambda profile:profile,
        _run_browser_command=lambda *args:{'success':False,'error':'Reference expired'},
        browser_click=unexpected,browser_type=unexpected)
    assert json.loads(interact_with_ref(browser,'writer','click','e3'))=={'success':False,'error':'Reference expired'}
