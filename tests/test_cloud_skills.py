import copy
import json
from pathlib import Path
import pytest
from studio.cloud_skills import build, preview
from studio.cloud_import import apply_bundle, digest
from studio.cloud_library import Library

COMPUTER='10000000-0000-4000-8000-000000000001'
SCOPE={'sourceProfile':'default','skillIds':['writing/email'],'targetAgent':'email'}

def homes(tmp_path):
    source=tmp_path/'mac';dest=tmp_path/'orgo';target=dest/'profiles/email'
    for p in [source,dest,target]:
        p.mkdir(parents=True,exist_ok=True);(p/'config.yaml').write_text('model: keep\n')
    skill=source/'skills/writing/email';skill.mkdir(parents=True)
    (skill/'SKILL.md').write_text('Write clear email')
    (skill/'helper.sh').write_text('touch NEVER_EXECUTE')
    (skill/'.env').write_text('excluded')
    (source/'skills/other').mkdir();(source/'skills/other/SKILL.md').write_text('Not selected')
    for name in ['SOUL.md','state.db','auth.json','profile.yaml']:(target/name).write_text('keep '+name)
    return source,dest,target,skill

def test_only_selected_skills_reach_existing_agent_and_hash_updates_preserve_conflicts(tmp_path):
    source,dest,target,skill=homes(tmp_path)
    before={p.name:p.read_bytes() for p in target.iterdir()}
    bundle=build(source,COMPUTER,SCOPE)
    assert set(bundle['profiles']['default']['files'])=={'skills/writing/email/SKILL.md','skills/writing/email/helper.sh'}
    assert preview(dest,COMPUTER,bundle)['profiles'][0]['added']==2
    result=apply_bundle(dest,COMPUTER,bundle)
    assert result['scope']=='skills' and result['profiles'][0]['target']=='email'
    assert {p.name:p.read_bytes() for p in target.iterdir() if p.is_file()}==before
    assert not (target/'NEVER_EXECUTE').exists()
    assert list((dest/'profiles').iterdir())==[target]
    # One-way update replaces the last imported version with backup.
    (skill/'SKILL.md').write_text('Clearer email')
    apply_bundle(dest,COMPUTER,build(source,COMPUTER,SCOPE))
    assert (target/'skills/writing/email/SKILL.md').read_text()=='Clearer email'
    # Cloud edits survive, and conflicts preserve the entire incoming skill.
    (target/'skills/writing/email/SKILL.md').write_text('Cloud edit')
    (skill/'helper.sh').write_text('echo source change')
    updated=build(source,COMPUTER,SCOPE)
    result=apply_bundle(dest,COMPUTER,updated)
    assert len(result['conflicts'])==2
    assert (target/'skills/writing/email/SKILL.md').read_text()=='Cloud edit'
    assert (target/'skills/writing/email/helper.sh').read_text()=='touch NEVER_EXECUTE'
    assert all(Path(c['incoming']).is_file() for c in result['conflicts'])
    apply_bundle(dest,COMPUTER,updated)
    assert (target/'skills/writing/email/SKILL.md').read_text()=='Cloud edit'

def test_skills_import_rejects_wrong_computer_profile_escape_secrets_links_checksum_and_busy_agent(tmp_path):
    source,dest,target,skill=homes(tmp_path);bundle=build(source,COMPUTER,SCOPE)
    with pytest.raises(ValueError,match='destination'):apply_bundle(dest,'other',bundle)
    with pytest.raises(ValueError,match='working'):apply_bundle(dest,COMPUTER,bundle,['email'])
    for key in ['config.yaml','skills/other/SKILL.md','skills/writing/email/.env','skills/writing/email/../../auth.json']:
        bad=copy.deepcopy(bundle);bad['profiles']['default']['files'][key]={'sha256':'a'*64,'data':'eA=='}
        with pytest.raises(ValueError):apply_bundle(dest,COMPUTER,bad)
    bad=copy.deepcopy(bundle);bad['profiles']['default']['files']['skills/writing/email/SKILL.md']['sha256']='b'*64
    with pytest.raises(ValueError,match='checksum'):apply_bundle(dest,COMPUTER,bad)
    assert not (target/'skills').exists()
    (target/'skills').symlink_to(source/'skills')
    with pytest.raises(ValueError,match='Linked'):apply_bundle(dest,COMPUTER,bundle)
    assert (skill/'SKILL.md').read_text()=='Write clear email'

def test_export_resume_binds_scope_target_and_skills_and_archive_roundtrip(tmp_path):
    from studio.cloud_archive import Uploads, apply_archive
    source,dest,target,skill=homes(tmp_path);library=Library(source)
    result=library.export(COMPUTER,['default'],'request',SCOPE)
    assert result['manifest']['scope']=='skills'
    assert library.export(COMPUTER,['default'],'request',SCOPE)==result
    with pytest.raises(ValueError,match='another selection'):library.export(COMPUTER,['default'],'request')
    uploads=Uploads(dest,COMPUTER);upload=uploads.begin(result['size'],result['sha256'])
    chunk=library.chunk(result['exportId'],0)
    uploads.append(upload['uploadId'],0,chunk['data'],chunk['sha256'])
    apply_archive(dest,COMPUTER,uploads.finish(upload['uploadId']))
    assert (target/'skills/writing/email/SKILL.md').read_text()=='Write clear email'
