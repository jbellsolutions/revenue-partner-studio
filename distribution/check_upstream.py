#!/usr/bin/env python3
"""Inspect official Hermes upstream; never fetch code into or update an installation."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.parse
import urllib.request
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = 'NousResearch/hermes-agent'
DESTINATION = 'jbellsolutions/revenue-partner-studio'
TITLE = 'UPSTREAM-001: Hermes update compatibility review'


def github(endpoint, method='GET', payload=None, token=None):
    headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'Revenue-Partner-Studio-upstream-watch',
               'X-GitHub-Api-Version': '2022-11-28'}
    token = token or os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = None if payload is None else json.dumps(payload).encode()
    if data is not None:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request('https://api.github.com/' + endpoint,
                                     headers=headers, data=data, method=method)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def commit_sha(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{40}', value):
        raise ValueError('Upstream returned an invalid commit identity')
    return value


def inspect(baseline, api=github):
    if baseline.get('repository') != UPSTREAM:
        raise ValueError('Only the official Hermes repository is allowed')
    release = api(f'repos/{UPSTREAM}/releases/latest')
    tag = release.get('tag_name')
    if release.get('draft') or release.get('prerelease') or not isinstance(tag, str) or not tag:
        raise ValueError('Expected a published stable Hermes release')
    release_sha = commit_sha(api(f'repos/{UPSTREAM}/commits/{urllib.parse.quote(tag, safe="")}')['sha'])
    main_sha = commit_sha(api(f'repos/{UPSTREAM}/commits/main')['sha'])
    # A reviewed source identity is separate from an installed/tested version.
    return {'repository': UPSTREAM, 'release_tag': tag, 'release_sha': release_sha,
            'main_sha': main_sha,
            'release_review_required': release_sha != baseline.get('reviewed_release_sha'),
            'main_review_required': main_sha != baseline.get('reviewed_main_sha')}


def fetch_url(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Revenue-Partner-Studio-upstream-watch'})
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.geturl().split('#', 1)[0].rstrip('/') != url.split('#', 1)[0].rstrip('/'):
            raise ValueError('Upstream URL redirected unexpectedly')
        data = response.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise ValueError('Upstream document exceeds the watcher limit')
    return data


def inspect_registry(baseline, api=github, url_reader=fetch_url):
    """Observe every registered source without promoting or installing it."""
    if baseline.get('schema') != 2 or not isinstance(baseline.get('sources'), list):
        raise ValueError('Expected source registry schema 2')
    rows = []
    private_token = os.environ.get('UPSTREAM_READ_TOKEN')
    for source in baseline['sources']:
        identity = source.get('id')
        if not isinstance(identity, str) or not re.fullmatch(r'[a-z0-9-]{2,64}', identity):
            raise ValueError('Invalid upstream source identity')
        row = {'id': identity, 'kind': source.get('kind'), 'private': bool(source.get('private')),
               'categories': source.get('categories', []), 'review_required': False}
        try:
            if source.get('kind') == 'url':
                url = source.get('url', '')
                if not isinstance(url, str) or not url.startswith('https://'):
                    raise ValueError('Only HTTPS upstream documents are allowed')
                digest = hashlib.sha256(url_reader(url)).hexdigest()
                row.update({'sha256': digest, 'review_required': digest != source.get('reviewedSha256')})
            elif source.get('kind') in {'github_branch', 'github_release_and_branch'}:
                repository = source.get('repository', '')
                branch = source.get('branch', 'main')
                if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) or not re.fullmatch(r'[A-Za-z0-9_./-]+', branch):
                    raise ValueError('Invalid GitHub upstream')
                if source.get('private') and api is github and not private_token:
                    row.update({'status': 'maintainer_credentials_required'})
                    rows.append(row); continue
                call = (lambda endpoint: github(endpoint, token=private_token)) if source.get('private') and api is github else api
                branch_sha = commit_sha(call(f'repos/{repository}/commits/{urllib.parse.quote(branch, safe="")}')['sha'])
                row.update({'branch_sha': branch_sha,
                            'review_required': branch_sha != source.get('reviewedBranchSha')})
                if source.get('kind') == 'github_release_and_branch':
                    release = call(f'repos/{repository}/releases/latest')
                    tag = release.get('tag_name')
                    if release.get('draft') or not isinstance(tag, str) or not tag:
                        raise ValueError('Expected a published upstream release')
                    release_sha = commit_sha(call(f'repos/{repository}/commits/{urllib.parse.quote(tag, safe="")}')['sha'])
                    row.update({'release_tag': tag, 'release_sha': release_sha,
                                'review_required': row['review_required'] or release_sha != source.get('reviewedReleaseSha')})
            else:
                raise ValueError('Unknown upstream source kind')
            row['status'] = 'review_required' if row['review_required'] else 'reviewed'
        except HTTPError as exc:
            if source.get('private') and exc.code in {401, 403, 404}:
                row['status'] = 'maintainer_credentials_required'
            else: raise
        rows.append(row)
    return {'schema': 2, 'sources': rows, 'review_required': any(r['review_required'] for r in rows),
            'categories': sorted({category for row in rows if row['review_required'] for category in row['categories']})}


def registry_issue_body(report):
    lines = ['<!-- revenue-partner-studio-upstream-watch:v2 -->',
             'Registered upstream changes need compatibility review. Nothing was merged, installed, restarted, or promoted.', '']
    for row in report['sources']:
        if row['status'] == 'reviewed': continue
        detail = 'maintainer read-only credentials required' if row['status'] == 'maintainer_credentials_required' else 'change detected'
        if not row.get('private') and row.get('release_tag'): detail += f" · release `{row['release_tag']}`"
        lines.append(f"- **{row['id']}**: {detail} · categories: {', '.join(row['categories'])}")
    lines += ['', 'Required channel: compatibility suite → internal canary → backup/restore check → clean 24-hour qualification → owner-approved client update.',
              'Private reference identities and contents are intentionally omitted from this issue. Reviewers record pinned evidence in `distribution/upstream.json` only after testing.']
    return '\n'.join(lines)


def sync_registry_issue(report, api=github):
    actionable = report['review_required'] or any(r['status'] == 'maintainer_credentials_required' for r in report['sources'])
    if not actionable: return 'reviewed'
    issues = api(f'repos/{DESTINATION}/issues?state=all&per_page=100&page=1')
    matches = [i for i in issues if i.get('title') == TITLE and 'pull_request' not in i]
    body = registry_issue_body(report)
    if matches:
        issue = min(matches, key=lambda i: i['number'])
        if issue.get('body') == body and issue.get('state') == 'open': return 'unchanged'
        api(f'repos/{DESTINATION}/issues/{issue["number"]}', 'PATCH', {'body': body, 'state': 'open'})
        return 'updated'
    api(f'repos/{DESTINATION}/issues', 'POST', {'title': TITLE, 'body': body})
    return 'created'


def issue_body(report):
    base = f'https://github.com/{UPSTREAM}'
    tag = urllib.parse.quote(report['release_tag'], safe='')
    return '\n'.join([
        '<!-- grok-ish-upstream-watch:v1 -->',
        'Official Hermes source changes need compatibility review. This is **not an installed-update receipt**.', '',
        f'- Stable release: [{tag}]({base}/releases/tag/{tag})',
        f'- Release commit: `{report["release_sha"]}`',
        f'- Development head: [{report["main_sha"][:12]}]({base}/commit/{report["main_sha"]})',
        f'- Stable release review required: {report["release_review_required"]}',
        f'- Development review required: {report["main_review_required"]}', '',
        'Maintenance: inspect runtime/harness and apps/desktop changes, provider/auth changes, APIs, '
        'permissions and migrations. Port relevant changes into the independent product; test the '
        'chat, profiles/history, approvals, reconnect and screen paths. Keep development changes '
        'separate from stable deployment candidates.', '',
        'Follow [the update policy](https://github.com/jbellsolutions/revenue-partner-studio/blob/main/MAINTENANCE.md). '
        'Record reviewed identities in distribution/upstream.json only after documenting the review. '
        'Do not replace them with an observation merely to clear this issue. '
        'Keep review notes in comments; this generated body tracks the latest upstream identities.', '',
        'No merge, installation, remote restart, model call or customer-data access was performed by this watcher.'
    ])


def sync_issue(report, api=github):
    if not (report['release_review_required'] or report['main_review_required']):
        return 'reviewed'
    # Search all issue states so closed/unresolved reviews reopen rather than duplicate.
    matches = []
    page = 1
    while True:
        issues = api(f'repos/{DESTINATION}/issues?state=all&per_page=100&page={page}')
        matches.extend(i for i in issues if i.get('title') == TITLE and 'pull_request' not in i)
        if len(issues) < 100:
            break
        page += 1
    body = issue_body(report)
    if matches:
        issue = min(matches, key=lambda i: i['number'])
        if issue.get('body') == body and issue.get('state') == 'open':
            return 'unchanged'
        api(f'repos/{DESTINATION}/issues/{issue["number"]}', 'PATCH', {'body': body, 'state': 'open'})
        return 'updated'
    api(f'repos/{DESTINATION}/issues', 'POST', {'title': TITLE, 'body': body})
    return 'created'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publish', action='store_true', help='Create/update the repository review issue')
    args = parser.parse_args()
    baseline = json.loads((ROOT / 'distribution/upstream.json').read_text())
    report = inspect_registry(baseline) if baseline.get('schema') == 2 else inspect(baseline)
    if args.publish:
        # Never allow forks to publish to the product repository using copied automation.
        if os.environ.get('GITHUB_REPOSITORY') != DESTINATION:
            raise RuntimeError('Publishing requires the product GitHub Actions repository context')
        report['issue_result'] = sync_registry_issue(report) if report.get('schema') == 2 else sync_issue(report)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
