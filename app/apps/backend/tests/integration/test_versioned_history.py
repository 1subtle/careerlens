"""Concurrent JD edits and immutable private analysis snapshots."""
import asyncio

from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services import career_ai, career_diagnosis
from tests.integration.test_tenant_isolation import hosted  # noqa: F401


async def test_jd_optimistic_update_rejects_stale_writer():
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        job=(await client.post('/api/v1/career/jobs',json={'title':'Initial','text':'SQL Python'})).json()
        path=f"/api/v1/career/jobs/{job['job_id']}"
        assert job['version']==1
        missing=await client.put(path,json={'title':'Missing version','text':'SQL'})
        assert missing.status_code==422
        responses=await asyncio.gather(*[
            client.put(path,json={'title':title,'text':'SQL','expected_version':1})
            for title in ('First editor','Second editor')
        ])
        assert sorted(r.status_code for r in responses)==[200,409]
        winner=next(r.json() for r in responses if r.status_code==200)
        saved=(await client.get(path)).json()
        assert saved['version']==2 and saved['title']==winner['title']
        assert (await client.put(path,json={'title':'Next','text':'SQL','expected_version':2})).json()['version']==3


async def test_histories_survive_source_deletion_and_are_private(hosted,monkeypatch):
    _,(a,b),_=hosted
    monkeypatch.setattr(career_ai,'model_info',lambda:{'configured':True,'provider':'mock','model':'test'})
    async def recommend(evidence,jobs):
        return {'summary':'分析完成','directions':[], 'saved_jobs':[], 'fact_check':{'status':'sources_linked'}}
    monkeypatch.setattr(career_diagnosis,'recommend_directions',recommend)
    async with AsyncClient(transport=ASGITransport(app=app),base_url='https://careerlens.example',headers={'Origin':'https://careerlens.example'}) as client:
        resume=(await client.post('/api/v1/career/resumes',headers=a[1],json={'title':'Source','data':{'personalInfo':{'name':'A'},'summary':'使用 SQL 分析记录。'}})).json()
        job=(await client.post('/api/v1/career/jobs',headers=a[1],json={'title':'JD','text':'SQL','source_type':'manual'})).json()
        direction=await client.post('/api/v1/career/directions',headers=a[1],json={'resume_id':resume['id'],'use_ai':True})
        assert direction.status_code==200,direction.text
        market=await client.post('/api/v1/career/market/analyze',headers=a[1],json={'question':'岗位统计','use_ai':False})
        assert market.status_code==200,market.text
        assert market.json()['summary']['count']==1
        dpath=f"/api/v1/career/directions/history/{direction.json()['history_id']}"
        mpath=f"/api/v1/career/market/history/{market.json()['history_id']}"
        originals={path:(await client.get(path,headers=a[1])).json() for path in (dpath,mpath)}
        for path in (dpath,mpath):
            assert (await client.get(path,headers=b[1])).status_code==404
            assert (await client.delete(path,headers=b[1])).status_code==404
        assert (await client.put(f"/api/v1/career/jobs/{job['job_id']}",headers=b[1],json={'title':'Cross account','text':'SQL','expected_version':1})).status_code==404
        assert (await client.delete(f"/api/v1/career/resumes/{resume['id']}",headers=a[1])).status_code==200
        assert (await client.delete(f"/api/v1/career/jobs/{job['job_id']}",headers=a[1])).status_code==200
        for path in (dpath,mpath):
            assert (await client.get(path,headers=a[1])).json()==originals[path]
        for kind in ('directions','market'):
            path=f'/api/v1/career/{kind}/history'
            assert len((await client.get(path,headers=a[1])).json())==1
            assert (await client.get(path,headers=b[1])).json()==[]
        for path in (dpath,mpath):
            assert (await client.delete(path,headers=a[1])).status_code==200
            assert (await client.get(path,headers=a[1])).status_code==404
