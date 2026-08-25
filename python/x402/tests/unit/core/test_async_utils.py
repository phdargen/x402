"""Unit tests for x402.async_utils."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Generator

import pytest

from x402.async_utils import await_if_needed, run_awaitable_sync, run_sync_or_return_awaitable


class _CustomAwaitable:
    def __init__(self, value: object) -> None:
        self._value = value

    def __await__(self) -> Generator[None, None, object]:
        yield
        return self._value


@pytest.mark.asyncio
async def test_await_if_needed_returns_plain_value() -> None:
    assert await await_if_needed(42) == 42


@pytest.mark.asyncio
async def test_await_if_needed_awaits_coroutine() -> None:
    async def inner() -> str:
        return "ok"

    assert await await_if_needed(inner()) == "ok"


@pytest.mark.asyncio
async def test_await_if_needed_awaits_custom_awaitable() -> None:
    assert await await_if_needed(_CustomAwaitable("custom")) == "custom"


@pytest.mark.asyncio
async def test_await_if_needed_awaits_future() -> None:
    loop = asyncio.get_running_loop()
    future: asyncio.Future[str] = loop.create_future()
    future.set_result("future")
    assert await await_if_needed(future) == "future"


def test_run_awaitable_sync_returns_plain_value() -> None:
    assert run_awaitable_sync(7) == 7


def test_run_awaitable_sync_runs_coroutine_without_loop() -> None:
    async def inner() -> int:
        return 99

    assert run_awaitable_sync(inner()) == 99


def test_run_awaitable_sync_runs_custom_awaitable_without_loop() -> None:
    assert run_awaitable_sync(_CustomAwaitable("sync-custom")) == "sync-custom"


def test_run_awaitable_sync_runs_completed_future_without_loop() -> None:
    loop = asyncio.new_event_loop()
    try:
        future: asyncio.Future[int] = loop.create_future()
        future.set_result(3)
        assert run_awaitable_sync(future) == 3
    finally:
        loop.close()


@pytest.mark.asyncio
async def test_run_awaitable_sync_from_active_loop_uses_worker_thread() -> None:
    async def inner() -> str:
        return "threaded"

    assert run_awaitable_sync(inner()) == "threaded"


def test_run_awaitable_sync_with_uvloop_active() -> None:
    pytest.importorskip("uvloop")
    import uvloop as uvloop_module

    async def inner() -> str:
        return "uvloop"

    async def runner() -> str:
        return run_awaitable_sync(inner())

    uvloop_module.install()
    assert asyncio.run(runner()) == "uvloop"


@pytest.mark.asyncio
async def test_run_awaitable_sync_rejects_future_owned_by_current_loop() -> None:
    loop = asyncio.get_running_loop()
    future: asyncio.Future[None] = loop.create_future()

    with pytest.raises(RuntimeError, match="currently running"):
        run_awaitable_sync(future)


def test_run_awaitable_sync_propagates_exception() -> None:
    async def inner() -> None:
        raise ValueError("boom")

    with pytest.raises(ValueError, match="boom"):
        run_awaitable_sync(inner())


def test_run_sync_or_return_awaitable_resolves_without_loop() -> None:
    async def inner() -> int:
        return 5

    assert run_sync_or_return_awaitable(inner()) == 5


@pytest.mark.asyncio
async def test_run_sync_or_return_awaitable_returns_awaitable_under_loop() -> None:
    async def inner() -> int:
        return 6

    value = run_sync_or_return_awaitable(inner())
    assert isinstance(value, Awaitable)
    assert await value == 6
