import re
import unicodedata

_STOP = {
    "a", "an", "the", "how", "do", "does", "did", "what", "is", "are", "was", "why", "when", "where",
    "explain", "me", "about", "of", "to", "in", "on", "for", "and", "work", "works", "learn", "understand",
    "tell", "can", "you", "i", "want",
}


def slugify(text: str, max_len: int = 80) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return text[:max_len].rstrip("-")


def query_key(query: str) -> str:
    """Normalized form of a search, used as an alias key (cheap exact-match cache)."""
    words = re.findall(r"[a-z0-9]+", unicodedata.normalize("NFKD", query.lower()).encode("ascii", "ignore").decode())
    kept = [w for w in words if w not in _STOP] or words
    return " ".join(kept)[:200]
