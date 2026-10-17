from ..config import get_settings
from .base import GenerationError, MissingCredentials, Provider, ProviderUnavailable, Reply, Turn


def get_provider() -> Provider:
    """The configured provider. Raises MissingCredentials if its key isn't set."""
    if get_settings().llm_provider == "anthropic":
        from .anthropic import AnthropicProvider
        return AnthropicProvider()
    from .gemini import GeminiProvider
    return GeminiProvider()


__all__ = ["GenerationError", "MissingCredentials", "Provider", "ProviderUnavailable", "Reply", "Turn", "get_provider"]
