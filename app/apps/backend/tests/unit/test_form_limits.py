"""Uploaded form limits also apply to URL-encoded request bodies."""

import pytest
from fastapi import FastAPI, Request
from httpx import ASGITransport, AsyncClient


@pytest.mark.parametrize("body", ["a=1&b=2&c=3", "a=12345"])
async def test_urlencoded_forms_enforce_field_count_and_size(body):
    app = FastAPI()

    @app.post("/form")
    async def read_form(request: Request):
        await request.form(max_fields=2, max_part_size=4)
        return {"accepted": True}

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/form",
            content=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    assert response.status_code == 400
