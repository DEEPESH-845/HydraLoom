"""LLM provider abstraction.

Providers only turn a system prompt and a user prompt into text.
They never see images or model weights: the caller sends aggregated evidence only.
API keys are read from the environment at call time and are never logged, stored or returned.
"""

from __future__ import annotations

import os
import re
from abc import ABC, abstractmethod

import httpx

DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"
DEFAULT_OLLAMA_MODEL = "llama3.1"
DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"


class ProviderError(Exception):
    """Any provider failure. Messages are scrubbed of credentials."""


def _scrub(text: str, *secrets: str | None) -> str:
    out = text
    for s in secrets:
        if s:
            out = out.replace(s, "***")
    return re.sub(r"(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+", r"\1***", out)[:500]


class LLMProvider(ABC):
    name: str = "base"
    deterministic: bool = False

    @property
    @abstractmethod
    def model(self) -> str | None: ...

    @abstractmethod
    def configured(self) -> bool: ...

    @abstractmethod
    def complete(self, system: str, user: str, timeout_s: float) -> str: ...

    def __repr__(self) -> str:  # never include credentials
        return f"<{type(self).__name__} model={self.model!r}>"


class AnthropicProvider(LLMProvider):
    """Claude via the Anthropic Messages API over httpx (no SDK dependency)."""

    name = "anthropic"
    url = "https://api.anthropic.com/v1/messages"

    @property
    def model(self) -> str:
        return os.environ.get("GANTRYLAB_ANTHROPIC_MODEL", "").strip() or DEFAULT_ANTHROPIC_MODEL

    def configured(self) -> bool:
        return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())

    def complete(self, system: str, user: str, timeout_s: float) -> str:
        key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
        if not key:
            raise ProviderError("ANTHROPIC_API_KEY is not set")
        body = {
            "model": self.model,
            "max_tokens": 16000,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
        try:
            r = httpx.post(self.url, json=body, headers=headers, timeout=timeout_s)
        except httpx.HTTPError as exc:
            raise ProviderError(_scrub(f"anthropic request failed: {type(exc).__name__}: {exc}", key)) from None
        if r.status_code != 200:
            raise ProviderError(_scrub(f"anthropic HTTP {r.status_code}: {r.text[:300]}", key))
        data = r.json()
        if data.get("stop_reason") == "refusal":
            raise ProviderError("anthropic declined the request (stop_reason=refusal)")
        if data.get("stop_reason") == "max_tokens":
            raise ProviderError("anthropic response truncated (stop_reason=max_tokens)")
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        if not text.strip():
            raise ProviderError("anthropic returned no text")
        return text


class OpenAIProvider(LLMProvider):
    name = "openai"
    url = "https://api.openai.com/v1/chat/completions"

    @property
    def model(self) -> str:
        return os.environ.get("GANTRYLAB_OPENAI_MODEL", "").strip() or DEFAULT_OPENAI_MODEL

    def configured(self) -> bool:
        return bool(os.environ.get("OPENAI_API_KEY", "").strip())

    def complete(self, system: str, user: str, timeout_s: float) -> str:
        key = os.environ.get("OPENAI_API_KEY", "").strip()
        if not key:
            raise ProviderError("OPENAI_API_KEY is not set")
        body = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "response_format": {"type": "json_object"},
        }
        try:
            r = httpx.post(self.url, json=body, headers={"authorization": f"Bearer {key}"}, timeout=timeout_s)
        except httpx.HTTPError as exc:
            raise ProviderError(_scrub(f"openai request failed: {type(exc).__name__}: {exc}", key)) from None
        if r.status_code != 200:
            raise ProviderError(_scrub(f"openai HTTP {r.status_code}: {r.text[:300]}", key))
        try:
            return r.json()["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError("openai response missing content") from exc


class OllamaProvider(LLMProvider):
    name = "ollama"

    @property
    def model(self) -> str:
        return os.environ.get("GANTRYLAB_OLLAMA_MODEL", "").strip() or DEFAULT_OLLAMA_MODEL

    @property
    def base_url(self) -> str:
        return (os.environ.get("GANTRYLAB_OLLAMA_URL", "").strip() or DEFAULT_OLLAMA_URL).rstrip("/")

    def configured(self) -> bool:
        # Configured only when explicitly enabled; "auto" never probes the network.
        return bool(os.environ.get("GANTRYLAB_OLLAMA_MODEL", "").strip() or os.environ.get("GANTRYLAB_OLLAMA_URL", "").strip())

    def complete(self, system: str, user: str, timeout_s: float) -> str:
        body = {
            "model": self.model,
            "stream": False,
            "format": "json",
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        try:
            r = httpx.post(f"{self.base_url}/api/chat", json=body, timeout=timeout_s)
        except httpx.HTTPError as exc:
            raise ProviderError(f"ollama request failed: {type(exc).__name__}") from None
        if r.status_code != 200:
            raise ProviderError(f"ollama HTTP {r.status_code}: {r.text[:300]}")
        try:
            return r.json()["message"]["content"]
        except (KeyError, TypeError) as exc:
            raise ProviderError("ollama response missing content") from exc


class DeterministicProvider(LLMProvider):
    """No-network fallback. Narrative is generated from templates over the evidence."""

    name = "deterministic"
    deterministic = True

    @property
    def model(self) -> str:
        return "gantrylab-rules-1"

    def configured(self) -> bool:
        return True

    def complete(self, system: str, user: str, timeout_s: float) -> str:  # pragma: no cover - not used
        raise ProviderError("the deterministic provider does not complete prompts")


PROVIDER_CLASSES: dict[str, type[LLMProvider]] = {
    "anthropic": AnthropicProvider,
    "openai": OpenAIProvider,
    "ollama": OllamaProvider,
    "deterministic": DeterministicProvider,
}
AUTO_ORDER = ("anthropic", "openai", "ollama")


def provider_status() -> dict[str, bool]:
    return {name: cls().configured() for name, cls in PROVIDER_CLASSES.items()}


def select_provider(requested: str | None, default: str) -> tuple[LLMProvider, str | None]:
    """Return (provider, note). Unknown or unconfigured providers fall back to deterministic with a note."""
    choice = (requested or default or "auto").strip().lower()
    if choice == "auto":
        for name in AUTO_ORDER:
            p = PROVIDER_CLASSES[name]()
            if p.configured():
                return p, None
        return DeterministicProvider(), "no LLM provider configured; used deterministic provider"
    cls = PROVIDER_CLASSES.get(choice)
    if cls is None:
        return DeterministicProvider(), f"unknown provider {choice!r}; used deterministic provider"
    p = cls()
    if not p.configured():
        return DeterministicProvider(), f"provider {choice!r} is not configured; used deterministic provider"
    return p, None
