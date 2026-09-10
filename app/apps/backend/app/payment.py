"""Wechat Pay Native API v3, using merchant RSA and a pinned Wechat public key.

Protocol: https://pay.wechatpay.cn/doc/v3/merchant/4012791877
Signatures: https://pay.wechatpay.cn/doc/v3/merchant/4012365336
Public keys: https://pay.wechatpay.cn/doc/v3/merchant/4012154180
"""

import base64
import json
import re
import secrets
import time
from datetime import UTC, datetime
from functools import lru_cache
from urllib.parse import urlencode, urlsplit

import httpx
from cryptography.exceptions import InvalidSignature, InvalidTag, UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, SecretStr, TypeAdapter
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.hosting import get_hosting_settings


class PaymentError(HTTPException):
    """Only sanitized, customer-actionable payment errors leave this boundary."""


class CreditPackage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    name: str = Field(min_length=1, max_length=80)
    credits: int = Field(strict=True, gt=0, le=1_000_000)
    amount_fen: int = Field(strict=True, gt=0, le=100_000_000)
    currency: str = Field(default="CNY", pattern="^CNY$")


class PaymentSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CAREERLENS_WECHAT_", env_file=".env", extra="ignore")
    appid: str = ""
    mchid: str = ""
    merchant_serial: str = ""
    merchant_private_key: SecretStr = SecretStr("")
    api_v3_key: SecretStr = SecretStr("")
    platform_key_id: str = ""
    platform_public_key: SecretStr = SecretStr("")
    notify_url: str = ""
    packages_json: str = Field(default="[]", validation_alias="CAREERLENS_CREDIT_PACKAGES")

    def packages(self) -> list[CreditPackage]:
        packages = TypeAdapter(list[CreditPackage]).validate_json(self.packages_json)
        if len(packages) > 20 or len({item.id for item in packages}) != len(packages):
            raise ValueError("Invalid credit package catalog")
        return packages


@lru_cache(maxsize=1)
def get_payment_settings():
    return PaymentSettings()


class WechatPay:
    def __init__(self, options: PaymentSettings):
        self.options = options
        self.notify_url = options.notify_url or get_hosting_settings().public_origin + "/api/v1/billing/wechat/notify"
        address = urlsplit(self.notify_url)
        if (
            not re.fullmatch(r"[A-Za-z0-9]{1,32}", options.appid)
            or not re.fullmatch(r"[0-9]{1,32}", options.mchid)
            or not re.fullmatch(r"[A-Fa-f0-9]{1,64}", options.merchant_serial)
            or not re.fullmatch(r"PUB_KEY_ID_[A-Za-z0-9_]{1,100}", options.platform_key_id)
            or address.scheme != "https" or not address.hostname
            or address.username or address.password or address.fragment
            or len(options.api_v3_key.get_secret_value().encode()) != 32
        ):
            raise ValueError("Incomplete Wechat payment configuration")
        self.private_key = serialization.load_pem_private_key(
            options.merchant_private_key.get_secret_value().replace("\\n", "\n").encode(), password=None
        )
        self.platform_key = serialization.load_pem_public_key(
            options.platform_public_key.get_secret_value().replace("\\n", "\n").encode()
        )
        if not isinstance(self.private_key, rsa.RSAPrivateKey) or self.private_key.key_size < 2048:
            raise ValueError("Merchant RSA key must be at least 2048 bits")
        if not isinstance(self.platform_key, rsa.RSAPublicKey) or self.platform_key.key_size < 2048:
            raise ValueError("Wechat RSA key must be at least 2048 bits")

    def authorization(self, method: str, path: str, body: bytes) -> str:
        stamp, nonce = str(int(time.time())), secrets.token_hex(16)
        message = f"{method}\n{path}\n{stamp}\n{nonce}\n".encode() + body + b"\n"
        signature = base64.b64encode(self.private_key.sign(message, padding.PKCS1v15(), hashes.SHA256())).decode()
        return (
            f'WECHATPAY2-SHA256-RSA2048 mchid="{self.options.mchid}",nonce_str="{nonce}",'
            f'timestamp="{stamp}",serial_no="{self.options.merchant_serial}",signature="{signature}"'
        )

    def verify_signature(self, headers, body: bytes) -> None:
        try:
            stamp, nonce = headers["Wechatpay-Timestamp"], headers["Wechatpay-Nonce"]
            if headers["Wechatpay-Serial"] != self.options.platform_key_id:
                raise ValueError("Unknown signing key")
            if not re.fullmatch(r"[0-9]{1,12}", stamp) or abs(time.time() - int(stamp)) > 300:
                raise ValueError("Expired signature")
            if not nonce or len(nonce) > 128 or "\n" in nonce or "\r" in nonce:
                raise ValueError("Invalid nonce")
            signature = base64.b64decode(headers["Wechatpay-Signature"], validate=True)
            message = f"{stamp}\n{nonce}\n".encode() + body + b"\n"
            self.platform_key.verify(signature, message, padding.PKCS1v15(), hashes.SHA256())
        except (KeyError, ValueError, TypeError, InvalidSignature):
            raise PaymentError(400, "微信支付签名校验失败") from None

    async def request(self, method: str, path: str, payload=None) -> dict:
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        try:
            async with httpx.AsyncClient(timeout=20, follow_redirects=False, trust_env=False) as client:
                result = await client.request(
                    method, "https://api.mch.weixin.qq.com" + path, content=body,
                    headers={"Authorization": self.authorization(method, path, body),
                             "Wechatpay-Serial": self.options.platform_key_id,
                             "Accept": "application/json", "Content-Type": "application/json",
                             "User-Agent": "CareerLens/1.0"},
                )
            self.verify_signature(result.headers, result.content)
            if result.status_code not in (200, 201):
                raise PaymentError(503, "微信支付暂未受理请求，请稍后查询订单状态")
            value = result.json()
            if not isinstance(value, dict):
                raise ValueError("Invalid payment response")
            return value
        except PaymentError as error:
            if error.status_code == 400:
                raise PaymentError(503, "微信支付响应未通过验证，请稍后查询订单状态") from None
            raise
        except (httpx.HTTPError, ValueError, TypeError):
            raise PaymentError(503, "微信支付暂不可用，请稍后查询订单状态") from None

    async def create_native(self, order: dict) -> str:
        result = await self.request("POST", "/v3/pay/transactions/native", {
            "appid": order["appid"], "mchid": order["mchid"],
            "description": order["description"], "out_trade_no": order["id"],
            "notify_url": self.notify_url,
            "time_expire": datetime.fromtimestamp(order["expires_at"], UTC).isoformat(),
            "amount": {"total": order["amount_fen"], "currency": order["currency"]},
        })
        code_url = result.get("code_url")
        if not isinstance(code_url, str) or len(code_url) > 512 or not code_url.startswith("weixin://wxpay/bizpayurl?"):
            raise PaymentError(503, "微信支付未返回有效付款二维码，请稍后查询订单")
        return code_url

    async def query(self, order: dict) -> dict:
        result = await self.request("GET", "/v3/pay/transactions/out-trade-no/" + order["id"]
                                    + "?" + urlencode({"mchid": order["mchid"]}))
        if result.get("out_trade_no") != order["id"]:
            raise PaymentError(503, "微信支付返回的订单不一致，请稍后查询")
        return result

    def decrypt_notification(self, headers, body: bytes) -> dict:
        self.verify_signature(headers, body)
        try:
            value = json.loads(body)
            resource = value["resource"]
            if (value["event_type"] != "TRANSACTION.SUCCESS"
                    or resource["algorithm"] != "AEAD_AES_256_GCM"
                    or resource.get("original_type") != "transaction"):
                raise ValueError("Unsupported notification")
            nonce = resource["nonce"].encode()
            if len(nonce) != 12:
                raise ValueError("Invalid GCM nonce")
            plaintext = AESGCM(self.options.api_v3_key.get_secret_value().encode()).decrypt(
                nonce, base64.b64decode(resource["ciphertext"], validate=True),
                resource.get("associated_data", "").encode(),
            )
            transaction = json.loads(plaintext)
            if not isinstance(transaction, dict) or transaction.get("trade_state") != "SUCCESS":
                raise ValueError("Unsupported payment state")
            return transaction
        except (KeyError, ValueError, TypeError, AttributeError, InvalidTag):
            raise PaymentError(400, "微信支付通知内容无效") from None


def get_wechat_pay(*, require_packages=True) -> WechatPay:
    try:
        options = get_payment_settings()
        if require_packages and not options.packages():
            raise ValueError("No credit packages configured")
        return WechatPay(options)
    except (ValueError, TypeError, UnsupportedAlgorithm):
        raise PaymentError(503, "微信支付暂未开通，请稍后再试") from None


def payment_catalog() -> dict:
    try:
        packages = [item.model_dump() for item in get_payment_settings().packages()]
        get_wechat_pay()
        enabled = True
    except (ValueError, TypeError, PaymentError):
        packages, enabled = [], False
    return {"payment_enabled": enabled, "packages": packages}
