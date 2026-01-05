"""HTTP middleware for x402 payment handling.

Provides server-side middleware for FastAPI and Flask that
protects endpoints with x402 payment requirements.

Note: Import specific middleware modules directly to avoid
requiring all framework dependencies:

    from x402.http.middleware.fastapi import payment_middleware
    from x402.http.middleware.flask import PaymentMiddleware

Or install the specific extras you need:

    uv add "x402[fastapi]"   # for FastAPI middleware
    uv add "x402[flask]"     # for Flask middleware
    uv add "x402[servers]"   # for all server frameworks
"""

import importlib
import importlib.util

# Cache for imported modules to avoid repeated imports
_module_cache: dict[str, object] = {}


def _get_fastapi_module():
    """Get the fastapi middleware module, caching the result."""
    if "fastapi" not in _module_cache:
        _module_cache["fastapi"] = importlib.import_module(
            ".fastapi", "x402.http.middleware"
        )
    return _module_cache["fastapi"]


def _get_flask_module():
    """Get the flask middleware module, caching the result."""
    if "flask" not in _module_cache:
        _module_cache["flask"] = importlib.import_module(
            ".flask", "x402.http.middleware"
        )
    return _module_cache["flask"]


def __getattr__(name: str):
    """Lazy import to avoid requiring all framework dependencies.

    Tries to find the requested attribute in available middleware modules.
    If a module isn't installed, provides a helpful error message.
    """
    fastapi_available = importlib.util.find_spec("fastapi") is not None
    flask_available = importlib.util.find_spec("flask") is not None

    # Try fastapi module if available
    if fastapi_available:
        _fastapi = _get_fastapi_module()

        # Map convenience aliases to actual names
        attr_map = {
            "fastapi_payment_middleware": "payment_middleware",
            "fastapi_payment_middleware_from_config": "payment_middleware_from_config",
        }
        actual_name = attr_map.get(name, name)

        if hasattr(_fastapi, actual_name):
            return getattr(_fastapi, actual_name)

    # Try flask module if available
    if flask_available:
        _flask = _get_flask_module()

        # Map convenience aliases to actual names
        attr_map = {
            "FlaskPaymentMiddleware": "PaymentMiddleware",
            "flask_payment_middleware": "payment_middleware",
            "flask_payment_middleware_from_config": "payment_middleware_from_config",
        }
        actual_name = attr_map.get(name, name)

        if hasattr(_flask, actual_name):
            return getattr(_flask, actual_name)

    # Attribute not found - determine the best error message
    if not fastapi_available and not flask_available:
        # Neither package installed
        raise ImportError(
            f"'{name}' not found. No server framework packages installed. "
            'Install with: uv add "x402[fastapi]" or uv add "x402[flask]"'
        )

    if fastapi_available and flask_available:
        # Both installed, but neither has this attribute - it doesn't exist
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    # One package installed (and doesn't have it), one not installed
    # The attribute might be in the uninstalled package
    if not fastapi_available:
        raise ImportError(
            f"'{name}' not found. It may be in the fastapi middleware module. "
            'Install with: uv add "x402[fastapi]"'
        )

    # not flask_available
    raise ImportError(
        f"'{name}' not found. It may be in the flask middleware module. "
        'Install with: uv add "x402[flask]"'
    )


def __dir__():
    """Return list of available attributes for autocomplete."""
    result = []

    if importlib.util.find_spec("fastapi") is not None:
        result.extend([
            "FastAPIAdapter",
            "PaymentMiddlewareASGI",
            "fastapi_payment_middleware",
            "fastapi_payment_middleware_from_config",
        ])

    if importlib.util.find_spec("flask") is not None:
        result.extend([
            "FlaskAdapter",
            "FlaskPaymentMiddleware",
            "ResponseWrapper",
            "flask_payment_middleware",
            "flask_payment_middleware_from_config",
        ])

    return result
