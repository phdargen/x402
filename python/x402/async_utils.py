"""Internal helpers for bridging sync and async x402 drivers."""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable
from concurrent.futures import ThreadPoolExecutor
from typing import TypeVar

T = TypeVar("T")

_THREAD_EXECUTOR: ThreadPoolExecutor | None = None


def _get_thread_executor() -> ThreadPoolExecutor:
    global _THREAD_EXECUTOR
    if _THREAD_EXECUTOR is None:
        _THREAD_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="x402-async")
    return _THREAD_EXECUTOR


async def await_if_needed(value: T | Awaitable[T]) -> T:
    """Await *value* when it is awaitable; otherwise return it unchanged."""
    if inspect.isawaitable(value):
        return await value
    return value


def _run_in_new_loop(awaitable: Awaitable[T]) -> T:
    async def _wrapper() -> T:
        return await awaitable

    return asyncio.run(_wrapper())


def run_awaitable_sync(value: T | Awaitable[T]) -> T:
    """Run an awaitable synchronously with explicit event-loop behavior.

    When no loop is running, uses ``asyncio.run``. When a loop is already
    active, runs unbound coroutines/custom awaitables in an isolated worker
    thread. Futures owned by another running loop are completed via
    ``asyncio.run_coroutine_threadsafe``. Futures owned by the current loop
    raise a clear error to avoid deadlocks.
    """
    if not inspect.isawaitable(value):
        return value

    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        return _run_in_new_loop(value)

    if asyncio.isfuture(value):
        owner_loop = value.get_loop()
        if owner_loop is running_loop:
            if asyncio.iscoroutine(value):
                value.close()
            raise RuntimeError(
                "Cannot synchronously await a Future owned by the currently running "
                "event loop. Use the async driver instead."
            )
        if owner_loop.is_running():

            async def _await_future() -> T:
                return await value

            return asyncio.run_coroutine_threadsafe(_await_future(), owner_loop).result()

    return _get_thread_executor().submit(_run_in_new_loop, value).result()


def run_sync_or_return_awaitable(value: Awaitable[T]) -> T | Awaitable[T]:
    """Resolve *value* immediately when no loop is running; otherwise return it."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return run_awaitable_sync(value)
    return value


__all__ = ["await_if_needed", "run_awaitable_sync", "run_sync_or_return_awaitable"]
