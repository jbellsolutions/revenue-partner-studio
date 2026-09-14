from studio.cloud_runtime import mcp_servers,tool_selection


def test_legacy_profile_keeps_credentials_and_other_integrations_but_uses_owned_screen(monkeypatch,tmp_path):
    import hermes_constants
    from studio import service
    monkeypatch.setenv('HERMES_STUDIO_RUNTIME','1')
    monkeypatch.setattr(hermes_constants,'get_hermes_home',lambda:tmp_path/'profiles'/'email')
    monkeypatch.setattr(service,'screen_config',lambda profile:{'profile':profile,'computer':'verified'})
    original={'orgo-agent':{'command':'old-computer-route'},'crm':{'token':'existing-private-credential'}}
    cfg={'toolsets':['hermes-cli'],'mcp_servers':original}
    result=mcp_servers(cfg,original)
    assert result['orgo-screen']['profile']=='email'
    assert result['crm'] is original['crm'] and 'orgo-agent' not in result
    assert 'orgo-agent' in original and 'orgo-screen' not in original
    enabled,disabled=tool_selection(cfg,['hermes-cli','mcp-orgo-agent','crm'])
    assert 'orgo-screen' in enabled and 'mcp-orgo-agent' not in enabled
    assert 'browser' in disabled and 'crm' in enabled


def test_file_only_grants_do_not_gain_screen_tools_and_rollback_runtime_is_untouched(monkeypatch):
    cfg={'tools':{'enabled_toolsets':['file']}}
    monkeypatch.setenv('HERMES_STUDIO_RUNTIME','1')
    assert mcp_servers(cfg,{})=={}
    cfg['mcp_servers']={'orgo-agent':{'command':'old-route'}}
    assert mcp_servers(cfg,cfg['mcp_servers'])=={}
    assert 'orgo-screen' not in tool_selection(cfg,['file'])[0]
    monkeypatch.delenv('HERMES_STUDIO_RUNTIME')
    original={'orgo-agent':{'command':'original'}}
    assert mcp_servers({'mcp_servers':original},original) is original
    assert tool_selection(cfg,['file'])==(['file'],None)


def test_explicit_browser_disable_is_preserved(monkeypatch):
    monkeypatch.setenv('HERMES_STUDIO_RUNTIME','1')
    cfg={'toolsets':['hermes-cli'],'agent':{'disabled_toolsets':['browser','cronjob']}}
    assert mcp_servers(cfg,{})=={}
    enabled,disabled=tool_selection(cfg,['hermes-cli'])
    assert 'orgo-screen' not in enabled
    assert {'browser','cronjob','computer_use'}.issubset(disabled)


def test_explicit_managed_screen_grant_keeps_generic_browser_and_other_tools_disabled(monkeypatch,tmp_path):
    import hermes_constants
    from studio import service
    monkeypatch.setenv('HERMES_STUDIO_RUNTIME','1')
    monkeypatch.setattr(hermes_constants,'get_hermes_home',lambda:tmp_path/'profiles'/'team-support')
    monkeypatch.setattr(service,'screen_config',lambda profile:{'profile':profile})
    cfg={'toolsets':['agent_team','orgo-screen'],'agent':{'disabled_toolsets':['browser','terminal','file']}}
    assert mcp_servers(cfg,{})['orgo-screen']['profile']=='team-support'
    enabled,disabled=tool_selection(cfg,cfg['toolsets'])
    assert 'orgo-screen' in enabled and {'browser','terminal','file','computer_use'}.issubset(disabled)
    cfg['agent']['disabled_toolsets'].append('orgo-screen')
    assert mcp_servers(cfg,{})=={}
