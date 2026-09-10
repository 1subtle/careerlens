"""Verify the deployed STAR save/diagnose/rewrite/apply/history flow in temporary storage.

Requires --live. Uses only synthetic material and an isolated account; at most
three provider attempts. The configured model incurs provider usage.
"""
import argparse
import asyncio
import json
import logging
import os
import secrets
import tempfile
from datetime import date
from pathlib import Path


async def probe(directory):
    from app.config import settings
    from app.auth import get_auth_store
    from app.hosting import current_user_id
    from app.credits import account_balance
    from app import llm
    from app.routers import career
    from app.schemas.career import ResumeInput, JobInput, MatchInput, RewriteInput, ApplyInput, MarketFilter
    assert settings.data_dir.resolve() == Path(directory).resolve()
    store=get_auth_store();store.initialize()
    challenge,code=store.prepare('flow-probe@example.test','synthetic-flow')
    store.delivery(challenge,True)
    user,_=store.verify('flow-probe@example.test',challenge,code,None)
    token=current_user_id.set(user['id'])
    database=career.db._database()
    assert database.db_path.resolve().is_relative_to(Path(directory).resolve())
    database._ensure_initialized()
    router,_=llm.get_router();original=router.make_call;attempts=0
    async def counted(*args,**kwargs):
        nonlocal attempts
        if attempts>=3:raise RuntimeError('synthetic_probe_budget_exhausted')
        attempts+=1
        return await original(*args,**kwargs)
    router.make_call=counted
    try:
        original_text='参与校园活动，帮忙整理反馈，也写了报告。'
        resume=await career.create_resume(ResumeInput.model_validate({'title':'合成验证简历','data':{'personalInfo':{'name':'合成验证同学'},'summary':original_text}}))
        job=await career.save_job(JobInput(title='产品助理',text='整理用户需求，协助撰写需求说明，跟进用户反馈；具备沟通与文档整理能力，了解 SQL。',source_type='synthetic',category='产品设计',published_at=date.today()))
        matched=await career.calculate_match(MatchInput(resume_id=resume['id'],job_id=job['job_id']))
        section=next(item for item in matched['evidence'] if item['kind']=='summary')
        rewrite=await career.create_rewrite(RewriteInput(match_id=matched['id'],section_id=section['id'],facts=['访谈了5名报名者，形成问题清单，并协助整理调研报告。'],use_ai=True))
        assert {item['stage'] for item in rewrite['star']}==set('STAR')
        assert rewrite['keyword_suggestions'] and rewrite['quantification_suggestions']
        assert '5' in rewrite['draft']
        saved=await career.get_match(matched['id'])
        assert saved['rewrites'][0]['star']==rewrite['star']
        applied=await career.apply_rewrite(rewrite['id'],ApplyInput(confirmed=True))
        repeated=await career.apply_rewrite(rewrite['id'],ApplyInput(confirmed=True))
        assert applied['resume']['id']==repeated['resume']['id']!=resume['id']
        assert applied['resume']['data']['summary']==rewrite['draft']
        after=await career.state()
        assert len(after['resumes'])==2
        assert next(r for r in after['resumes'] if r['id']==resume['id'])['data']['summary']==original_text
        market=await career.get_market(MarketFilter(include_demo=True))
        assert market['job_ids']==[job['job_id']] and market['coverage']['published_count']==1
        final=await career.get_match(matched['id'])
        assert final['rewrites'][0]['status']=='accepted'
        print(json.dumps({'event':'deployed_flow','status':'passed','temporary_storage':True,'provider_attempts':attempts,'original':original_text,'draft':rewrite['draft'],'star':rewrite['star'],'saved_versions':len(after['resumes']),'repeat_apply_same_version':True,'market_count':market['count'],'synthetic_credits':account_balance(user['id'])},ensure_ascii=False),flush=True)
    finally:
        router.make_call=original
        await career.db.close()
        current_user_id.reset(token)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--live',action='store_true');args=parser.parse_args()
    if not args.live:parser.error('Pass --live to run the bounded synthetic model check')
    logging.disable(logging.CRITICAL)
    with tempfile.TemporaryDirectory(prefix='careerlens-flow-probe-') as directory:
        os.environ.update(DATA_DIR=directory,CAREERLENS_MODE='hosted',CAREERLENS_AUTH_SECRET=secrets.token_urlsafe(32),CAREERLENS_SIGNUP_CREDITS='20')
        asyncio.run(asyncio.wait_for(probe(directory),timeout=180))
