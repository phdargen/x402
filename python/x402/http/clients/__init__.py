"""HTTP client wrappers with automatic x402 payment handling.

Provides wrappers for httpx (async) and requests (sync) that
automatically handle 402 Payment Required responses.

Note: Import specific client modules directly to avoid
requiring all client dependencies:

    from x402.http.clients.httpx import x402HttpxClient
    from x402.http.clients.requests import x402_requests

Or install the specific extras you need:

    uv add "x402[httpx]"     # for httpx client
    uv add "x402[requests]"  # for requests client
    uv add "x402[clients]"   # for all clients
"""

import importlib
import importlib.util

# Cache for imported modules to avoid repeated imports
_module_cache: dict[str, object] = {}


def _get_httpx_module():
    """Get the httpx client module, caching the result."""
    if "httpx" not in _module_cache:
        _module_cache["httpx"] = importlib.import_module(
            ".httpx", "x402.http.clients"
        )
    return _module_cache["httpx"]


def _get_requests_module():
    """Get the requests client module, caching the result."""
    if "requests" not in _module_cache:
        _module_cache["requests"] = importlib.import_module(
            ".requests", "x402.http.clients"
        )
    return _module_cache["requests"]


def __getattr__(name: str):
    """Lazy import to avoid requiring all client dependencies.

    Tries to find the requested attribute in available client modules.
    If a module isn't installed, provides a helpful error message.
    """
    httpx_available = importlib.util.find_spec("httpx") is not None
    requests_available = importlib.util.find_spec("requests") is not None

    # Try httpx module if available
    if httpx_available:
        _httpx = _get_httpx_module()
        if hasattr(_httpx, name):
            return getattr(_httpx, name)

    # Try requests module if available
    if requests_available:
        _requests = _get_requests_module()
        if hasattr(_requests, name):
            return getattr(_requests, name)

    # Attribute not found - determine the best error message
    if not httpx_available and not requests_available:
        # Neither package installed
        raise ImportError(
            f"'{name}' not found. No HTTP client packages installed. "
            'Install with: uv add "x402[httpx]" or uv add "x402[requests]"'
        )

    if httpx_available and requests_available:
        # Both installed, but neither has this attribute - it doesn't exist
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    # One package installed (and doesn't have it), one not installed
    # The attribute might be in the uninstalled package
    if not httpx_available:
        raise ImportError(
            f"'{name}' not found. It may be in the httpx client module. "
            'Install with: uv add "x402[httpx]"'
        )

    # not requests_available
    raise ImportError(
        f"'{name}' not found. It may be in the requests client module. "
        'Install with: uv add "x402[requests]"'
    )


def __dir__():
    """Return list of available attributes for autocomplete."""
    result = []

    if importlib.util.find_spec("httpx") is not None:
        _httpx = _get_httpx_module()
        result.extend(getattr(_httpx, "__all__", dir(_httpx)))

    if importlib.util.find_spec("requests") is not None:
        _requests = _get_requests_module()
        result.extend(getattr(_requests, "__all__", dir(_requests)))

    return list(set(result))
