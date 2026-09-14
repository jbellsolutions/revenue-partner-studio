import base64
import hashlib
import json
import pytest
from studio.cloud_files import Files
from studio.cloud_connector import Connector
from tests.test_cloud_coordination import make_service


def upload(files, content=b'Useful attachment', name='notes.txt', request='one'):
    params={'name':name,'size':len(content),'sha256':hashlib.sha256(content).hexdigest()}
    value=files.begin(params,request)
    files.append(value['id'],0,base64.b64encode(content).decode())
    return files.finish(value['id'])


def test_partial_retry_and_restart_preserve_one_file(tmp_path):
    files=Files(tmp_path,'computer','default','conversation');data=b'First and second'
    params={'name':'metadata.json','size':len(data),'sha256':hashlib.sha256(data).hexdigest()}
    value=files.begin(params,'request')
    files.append(value['id'],0,base64.b64encode(data[:5]).decode())
    reopened=Files(tmp_path,'computer','default','conversation')
    assert reopened.begin(params,'request')['offset']==5
    reopened.append(value['id'],0,base64.b64encode(data).decode())
    assert reopened.finish(value['id'])['ready']
    assert base64.b64decode(reopened.read(value['id'])['data'])==data
    assert len(list(tmp_path.glob('attachments/studio/*/metadata.json')))==1
    with pytest.raises(ValueError,match='different'):
        reopened.append(value['id'],0,base64.b64encode(b'Wrong').decode())


@pytest.mark.parametrize('owner',[('other','default','conversation'),('computer','other','conversation'),('computer','default','other')])
def test_foreign_attachment_is_rejected(tmp_path,owner):
    value=upload(Files(tmp_path,'computer','default','conversation'))
    with pytest.raises(ValueError,match='another'):
        Files(tmp_path,*owner).resolve([value['id']])


def test_format_paths_and_post_upload_changes_are_rejected(tmp_path):
    files=Files(tmp_path,'c','a','s')
    for name in ['../notes.txt','script.sh','a/b.txt','x\n.txt']:
        with pytest.raises(ValueError):upload(files,name=name)
    with pytest.raises(ValueError,match='format'):upload(files,name='fake.pdf',request='pdf')
    value=upload(files)
    files.path(value).write_text('changed')
    with pytest.raises(ValueError,match='changed'):files.resolve([value['id']])


def test_uploaded_document_is_durable_before_dispatch_and_recovery(tmp_path,monkeypatch):
    from hermes_cli import orgo_screens
    from studio import recovery
    monkeypatch.setattr(orgo_screens,'verify_binding',lambda:'computer')
    service=make_service(tmp_path)
    service.server._sessions['r']={'session_key':'s','profile_home':tmp_path}
    value=upload(Files(tmp_path,'computer','default','s'))
    params={'operation':'submit_chat','runtime_id':'r','recipient':'default','message':'Read it',
            'request_id':'task','attachmentIds':[value['id']]}
    service.operation('user',params);service.operation('user',params)
    delivery=service.store.rows('SELECT * FROM deliveries')[0]
    assert json.loads(delivery['attachments'])[0]['id']==value['id']
    with pytest.raises(ValueError,match='different content'):
        service.operation('user',{**params,'attachmentIds':[]})
    service.store.state('task','needs_review','Interrupted')
    token=recovery.inspect(service,'task')['inspection_token']
    restored=recovery.resume(service,'task',token)
    assert restored['stored_id']=='s' and json.loads(restored['attachments'])[0]['id']==value['id']


def test_symlink_cannot_redirect_upload(tmp_path):
    files=Files(tmp_path,'c','a','s');value=upload(files)
    destination=tmp_path/'private.txt';destination.write_text('Do not change')
    files.path(value).unlink();files.path(value).symlink_to(destination)
    with pytest.raises(ValueError,match='path'):files.read(value['id'])
    assert destination.read_text()=='Do not change'


def test_listing_survives_restart_and_only_lists_this_conversation(tmp_path):
    value=upload(Files(tmp_path,'c','a','s'))
    upload(Files(tmp_path,'c','a','other'),request='foreign')
    files=Files(tmp_path,'c','a','s')
    assert files.listing()['files']==[{k:value[k] for k in ('id','name','size','sessionId')}]
    with pytest.raises(ValueError):files.resolve([{}])


def test_image_dispatch_uses_only_the_owned_file_and_clears_previous_images(tmp_path,monkeypatch):
    from hermes_cli import orgo_screens
    monkeypatch.setattr(orgo_screens,'verify_binding',lambda:'computer')
    service=make_service(tmp_path)
    service.server._sessions['r']={'session_key':'s','profile_home':tmp_path,'attached_images':['wrong-image']}
    image=upload(Files(tmp_path,'computer','default','s'),b'\x89PNG\r\n\x1a\nfixture','fixture.png')
    service.operation('user',{'operation':'submit_chat','runtime_id':'r','recipient':'default','message':'Describe',
        'request_id':'image-task','attachmentIds':[image['id']]})
    calls=[]
    def rpc(method,params):
        calls.append((method,params,service.server._sessions['r']['attached_images'][:]))
        service.stopped.set()
        return {}
    service.rpc=rpc;service.dispatch()
    prompt=[c for c in calls if c[0]=='prompt.submit'][0]
    assert prompt[2]==[str(Files(tmp_path,'computer','default','s').path(image))]
    assert '@file:' in prompt[1]['text'] and 'wrong-image' not in prompt[1]['text']
    receipt=service.operation('user',{'operation':'chat_receipt','request_id':'image-task','recipient':'default'})
    assert receipt['accepted']
    with pytest.raises(ValueError,match='identity'):service.operation('user',{'operation':'chat_receipt','request_id':'image-task','recipient':'other'})
