#!/usr/bin/env python3
"""Inspect official Hermes upstream; never fetch code into or update an installation."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = 'NousResearch/hermes-agent'
DESTINATION = 'jbellsolutions/revenue-partner-studio'
TITLE = 'UPSTREAM-001: Hermes update compatibility review'


def github(endpoint, method='GET', payload=None):
    headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'Revenue-Partner-Studio-upstream-watch',
               'X-GitHub-Api-Version': '2022-11-28'}
    token = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
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
    report = inspect(json.loads((ROOT / 'distribution/upstream.json').read_text()))
    if args.publish:
        # Never allow forks to publish to the product repository using copied automation.
        if os.environ.get('GITHUB_REPOSITORY') != DESTINATION:
            raise RuntimeError('Publishing requires the product GitHub Actions repository context')
        report['issue_result'] = sync_issue(report)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
