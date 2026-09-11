"""Quick exports retain a saved template and explicit preview controls override it."""
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.routers import resumes
from app.schemas.template_settings import TemplateSettings


@pytest.mark.parametrize('query,template,top', [('lang=zh', 'latex', 18), ('template=modern&marginTop=7&lang=zh', 'modern', 7)])
async def test_pdf_saved_template_and_explicit_overrides(monkeypatch, query, template, top):
    render = AsyncMock(return_value=b'%PDF-test')
    monkeypatch.setattr(resumes, 'render_resume_pdf', render)
    settings = TemplateSettings(template='latex', pageSize='LETTER')
    settings.margins.top = 18
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        saved = await client.post('/api/v1/career/resumes', json={
            'title': 'PDF layout regression', 'data': {'personalInfo': {'name': 'Test'}},
            'template_settings': settings.model_dump(),
        })
        result = await client.get(f"/api/v1/resumes/{saved.json()['id']}/pdf?{query}")
    assert result.status_code == 200, result.text
    url, paper = render.call_args.args
    params = parse_qs(urlsplit(url).query)
    assert params['template'] == [template]
    assert params['marginTop'] == [str(top)]
    assert params['lang'] == ['zh']
    assert paper == 'LETTER'
    assert render.call_args.kwargs['margins']['top'] == top
