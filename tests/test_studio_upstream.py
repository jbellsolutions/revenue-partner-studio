import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('studio_upstream', Path(__file__).resolve().parents[1] / 'distribution/check_upstream.py')
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)


def source_api(endpoint):
    if endpoint.endswith('releases/latest'):
        return {'tag_name': 'v1', 'draft': False, 'prerelease': False}
    return {'sha': ('b' if endpoint.endswith('/main') else 'a') * 40}


def test_unknown_baseline_requires_review_and_does_not_claim_installed():
    report = watch.inspect({'repository': watch.UPSTREAM}, source_api)
    assert report['release_review_required'] and report['main_review_required']
    assert 'installed_version' not in report


def test_release_identity_detects_retag_and_main_is_separate():
    baseline = {'repository': watch.UPSTREAM, 'reviewed_release_sha': 'a' * 40, 'reviewed_main_sha': 'c' * 40}
    report = watch.inspect(baseline, source_api)
    assert not report['release_review_required'] and report['main_review_required']
    baseline['reviewed_release_sha'] = 'c' * 40
    assert watch.inspect(baseline, source_api)['release_review_required']


def test_errors_fail_without_publishing():
    with pytest.raises(ValueError):
        watch.inspect({'repository': 'someone/else'}, source_api)
    with pytest.raises(ValueError):
        watch.inspect({'repository': watch.UPSTREAM}, lambda _: {'tag_name': 'v1', 'prerelease': True})
    with pytest.raises(ValueError):
        watch.commit_sha('not a commit')
    def unavailable(_):
        raise TimeoutError('API unavailable')
    with pytest.raises(TimeoutError):
        watch.inspect({'repository': watch.UPSTREAM}, unavailable)


@pytest.mark.parametrize('state,body,expected', [('open', None, 'unchanged'), ('closed', None, 'updated'), ('open', 'old', 'updated')])
def test_existing_issue_deduplicates_or_reopens(state, body, expected):
    report = watch.inspect({'repository': watch.UPSTREAM}, source_api)
    writes = []
    def api(endpoint, method='GET', payload=None):
        if method == 'GET':
            return [{'number': 12, 'title': watch.TITLE, 'state': state, 'body': watch.issue_body(report) if body is None else body}]
        writes.append((endpoint, method, payload))
    assert watch.sync_issue(report, api) == expected
    assert len(writes) == (0 if expected == 'unchanged' else 1)
    if writes:
        assert writes[0][1] == 'PATCH'


def test_no_changes_no_issue_api_and_new_change_creates_issue():
    report = watch.inspect({'repository': watch.UPSTREAM}, source_api)
    calls = []
    def api(endpoint, method='GET', payload=None):
        calls.append(method)
        return []
    assert watch.sync_issue(report, api) == 'created'
    assert calls == ['GET', 'POST']
    report.update(release_review_required=False, main_review_required=False)
    calls.clear()
    assert watch.sync_issue(report, api) == 'reviewed'
    assert not calls


def test_registry_classifies_changes_and_sanitizes_private_references(monkeypatch):
    monkeypatch.setenv('UPSTREAM_READ_TOKEN','read-only-placeholder')
    baseline={'schema':2,'sources':[
        {'id':'public-doc','kind':'url','url':'https://example.test/docs','categories':['installation'],'reviewedSha256':None},
        {'id':'private-reference','kind':'github_branch','repository':'owner/private','branch':'main','private':True,
         'categories':['profiles'],'reviewedBranchSha':None}]}
    report=watch.inspect_registry(baseline,lambda _:{'sha':'a'*40},lambda _:b'changed documentation')
    assert report['review_required'] and report['categories']==['installation','profiles']
    body=watch.registry_issue_body(report)
    assert 'private-reference' in body and 'a'*40 not in body


def test_registry_private_sources_require_dedicated_credentials(monkeypatch):
    monkeypatch.delenv('UPSTREAM_READ_TOKEN',raising=False)
    baseline={'schema':2,'sources':[{'id':'private-reference','kind':'github_branch','repository':'owner/private',
        'branch':'main','private':True,'categories':['security'],'reviewedBranchSha':None}]}
    report=watch.inspect_registry(baseline)
    assert report['sources'][0]['status']=='maintainer_credentials_required'
