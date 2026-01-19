import pytest
import json
import base64
from unittest.mock import AsyncMock, MagicMock, patch
from httpx import Request, Response
from eth_account import Account
from x402.clients.httpx import HttpxHooks, x402_payment_hooks, x402HttpxClient
from x402.clients.base import (
    PaymentError,
)
from x402.types import PaymentRequirements, x402PaymentRequiredResponse


@pytest.fixture
def account():
    return Account.create()


@pytest.fixture
def payment_requirements():
    return PaymentRequirements(
        scheme="exact",
        network="base-sepolia",
        asset="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        pay_to="0x0000000000000000000000000000000000000000",
        max_amount_required="10000",
        resource="https://example.com",
        description="test",
        max_timeout_seconds=1000,
        mime_type="text/plain",
        output_schema=None,
        extra={
            "name": "USD Coin",
            "version": "2",
        },
    )


@pytest.fixture
def hooks(account):
    hooks_dict = x402_payment_hooks(account)
    return hooks_dict["response"][0].__self__


async def test_on_response_success(hooks):
    # Test successful response (200)
    response = Response(200)
    result = await hooks.on_response(response)
    assert result == response


async def test_on_response_non_402(hooks):
    # Test non-402 response
    response = Response(404)
    result = await hooks.on_response(response)
    assert result == response


async def test_on_response_retry(hooks):
    # Test retry response
    response = Response(402)
    hooks._is_retry = True
    result = await hooks.on_response(response)
    assert result == response


async def test_on_response_missing_request(hooks):
    # Test missing request configuration
    response = Response(402)
    # Don't set response.request at all to simulate missing request
    with pytest.raises(
        PaymentError,
        match="Failed to handle payment: The request instance has not been set on this response.",
    ):
        await hooks.on_response(response)


async def test_on_response_payment_flow(hooks, payment_requirements):
    # Mock the payment required response
    payment_response = x402PaymentRequiredResponse(
        x402_version=1,
        accepts=[payment_requirements],
        error="Payment Required",  # Add required error field
    )

    # Create initial 402 response
    response = Response(402)
    response.request = Request("GET", "https://example.com")
    response._content = json.dumps(payment_response.model_dump(by_alias=True)).encode()

    # Mock the retry response with payment response header
    payment_result = {
        "success": True,
        "transaction": "0x1234",
        "network": "base-sepolia",
        "payer": "0x5678",
    }
    retry_response = Response(200)
    retry_response.headers = {
        "X-Payment-Response": base64.b64encode(
            json.dumps(payment_result).encode()
        ).decode()
    }

    # Mock the AsyncClient
    mock_client = AsyncMock()
    mock_client.send.return_value = retry_response
    mock_client.__aenter__.return_value = mock_client

    # Mock both required methods
    hooks.client.select_payment_requirements = MagicMock(
        return_value=payment_requirements
    )
    mock_header = "mock_payment_header"
    hooks.client.create_payment_header = MagicMock(return_value=mock_header)

    with patch("x402.clients.httpx.AsyncClient", return_value=mock_client):
        result = await hooks.on_response(response)

        # Verify the result
        assert result.status_code == 200

        # Verify the retry request was made
        assert mock_client.send.called
        retry_request = mock_client.send.call_args[0][0]
        assert retry_request.headers["X-Payment"] == mock_header
        assert (
            retry_request.headers["Access-Control-Expose-Headers"]
            == "X-Payment-Response"
        )

        # Verify the mocked methods were called with correct arguments
        hooks.client.select_payment_requirements.assert_called_once_with(
            [payment_requirements]
        )
        hooks.client.create_payment_header.assert_called_once_with(
            payment_requirements, 1
        )


async def test_on_response_payment_error(hooks, payment_requirements):
    # Mock the payment required response with unsupported scheme
    payment_requirements.scheme = "unsupported"
    payment_response = x402PaymentRequiredResponse(
        x402_version=1,
        accepts=[payment_requirements],
        error="Payment Required",  # Add required error field
    )

    # Create initial 402 response
    response = Response(402)
    response.request = Request("GET", "https://example.com")
    response._content = json.dumps(payment_response.model_dump(by_alias=True)).encode()

    # Test payment error handling
    with pytest.raises(PaymentError):
        await hooks.on_response(response)

    # Verify retry flag is reset
    assert not hooks._is_retry


async def test_on_response_general_error(hooks):
    # Create initial 402 response with invalid JSON
    response = Response(402)
    response.request = Request("GET", "https://example.com")
    response._content = b"invalid json"

    # Test general error handling
    with pytest.raises(PaymentError):
        await hooks.on_response(response)

    # Verify retry flag is reset
    assert not hooks._is_retry


def test_x402_payment_hooks(account):
    # Test hooks dictionary creation
    hooks_dict = x402_payment_hooks(account)
    assert "request" in hooks_dict
    assert "response" in hooks_dict
    assert len(hooks_dict["request"]) == 1
    assert len(hooks_dict["response"]) == 1

    # Test hooks instance
    hooks_instance = hooks_dict["response"][0].__self__
    assert isinstance(hooks_instance, HttpxHooks)
    assert hooks_instance.client.account == account
    assert hooks_instance.client.max_value is None

    # Test with max_value
    hooks_dict = x402_payment_hooks(account, max_value=1000)
    hooks_instance = hooks_dict["response"][0].__self__
    assert hooks_instance.client.max_value == 1000

    # Test with custom selector
    def custom_selector(accepts, network_filter=None, scheme_filter=None):
        return accepts[0]

    hooks_dict = x402_payment_hooks(
        account, payment_requirements_selector=custom_selector
    )
    hooks_instance = hooks_dict["response"][0].__self__
    assert (
        hooks_instance.client.select_payment_requirements
        != hooks_instance.client.__class__.select_payment_requirements
    )


def test_x402_httpx_client(account):
    # Test client initialization
    client = x402HttpxClient(account=account)
    assert "request" in client.event_hooks
    assert "response" in client.event_hooks

    # Get the hooks instance
    hooks_instance = client.event_hooks["response"][0].__self__

    # Test client configuration
    assert hooks_instance.client.account == account
    assert hooks_instance.client.max_value is None

    # Test with max_value
    client = x402HttpxClient(account=account, max_value=1000)
    hooks_instance = client.event_hooks["response"][0].__self__
    assert hooks_instance.client.max_value == 1000

    # Test with custom selector
    def custom_selector(accepts, network_filter=None, scheme_filter=None):
        return accepts[0]

    client = x402HttpxClient(
        account=account, payment_requirements_selector=custom_selector
    )
    hooks_instance = client.event_hooks["response"][0].__self__
    assert (
        hooks_instance.client.select_payment_requirements
        != hooks_instance.client.__class__.select_payment_requirements
    )


# =============================================================================
# Concurrent Payment Tests
# =============================================================================


async def test_concurrent_payment_requests(hooks, payment_requirements):
    """Test that concurrent payment requests are handled properly without shared state conflicts."""
    import asyncio

    # Mock the payment required response
    payment_response = x402PaymentRequiredResponse(
        x402_version=1,
        accepts=[payment_requirements],
        error="Payment Required",
    )

    # Create multiple 402 responses for concurrent requests
    responses = []
    for i in range(5):
        response = Response(402)
        response.request = Request("GET", f"https://example.com/request-{i}")
        response._content = json.dumps(payment_response.model_dump(by_alias=True)).encode()
        responses.append(response)

    # Mock successful retry responses
    retry_response = Response(200)
    retry_response.headers = {"X-Payment-Response": "success"}
    retry_response._content = b'{"success": true}'

    # Mock the AsyncClient
    mock_client = AsyncMock()
    mock_client.send.return_value = retry_response
    mock_client.__aenter__.return_value = mock_client

    # Mock the client methods
    hooks.client.select_payment_requirements = MagicMock(
        return_value=payment_requirements
    )
    hooks.client.create_payment_header = MagicMock(return_value="mock_payment_header")

    # Process all requests concurrently
    with patch("x402.clients.httpx.AsyncClient", return_value=mock_client):
        tasks = [hooks.on_response(response) for response in responses]
        results = await asyncio.gather(*tasks)

        # Verify all requests succeeded
        for i, result in enumerate(results):
            assert result.status_code == 200, f"Request {i} failed with status {result.status_code}"

        # Verify all retry requests were made
        assert mock_client.send.call_count == 5

        # Verify payment headers were added to all retry requests
        for call_args in mock_client.send.call_args_list:
            retry_request = call_args[0][0]
            assert retry_request.headers["X-Payment"] == "mock_payment_header"


async def test_concurrent_requests_independent_retry_state(hooks, payment_requirements):
    """Test that each concurrent request has independent retry state."""
    import asyncio

    payment_response = x402PaymentRequiredResponse(
        x402_version=1,
        accepts=[payment_requirements],
        error="Payment Required",
    )

    # Track retry requests per URL
    retry_tracking = {}
    lock = asyncio.Lock()

    async def mock_send(request):
        url = str(request.url)
        async with lock:
            if url not in retry_tracking:
                retry_tracking[url] = []
            retry_tracking[url].append(True)  # Track that retry was called
        
        response = Response(200)
        response.headers = {"X-Payment-Response": "success"}
        return response

    # Create responses for different URLs
    responses = []
    for i in range(3):
        response = Response(402)
        response.request = Request("GET", f"https://example.com/concurrent-{i}")
        response._content = json.dumps(payment_response.model_dump(by_alias=True)).encode()
        responses.append(response)

    mock_client = AsyncMock()
    mock_client.send = mock_send
    mock_client.__aenter__.return_value = mock_client

    hooks.client.select_payment_requirements = MagicMock(return_value=payment_requirements)
    hooks.client.create_payment_header = MagicMock(return_value="mock_payment_header")

    with patch("x402.clients.httpx.AsyncClient", return_value=mock_client):
        tasks = [hooks.on_response(response) for response in responses]
        results = await asyncio.gather(*tasks)

        # All should succeed
        assert all(r.status_code == 200 for r in results)

        # Each URL should have exactly one retry request
        for url, calls in retry_tracking.items():
            assert len(calls) == 1, f"URL {url} should have exactly 1 retry call"


async def test_consecutive_payment_requests(hooks, payment_requirements):
    """Test that consecutive (sequential) payment requests all succeed."""
    # Mock the payment required response
    payment_response = x402PaymentRequiredResponse(
        x402_version=1,
        accepts=[payment_requirements],
        error="Payment Required",
    )

    # Mock successful retry response
    retry_response = Response(200)
    retry_response.headers = {"X-Payment-Response": "success"}
    retry_response._content = b'{"success": true}'

    mock_client = AsyncMock()
    mock_client.send.return_value = retry_response
    mock_client.__aenter__.return_value = mock_client

    hooks.client.select_payment_requirements = MagicMock(return_value=payment_requirements)
    hooks.client.create_payment_header = MagicMock(return_value="mock_payment_header")

    with patch("x402.clients.httpx.AsyncClient", return_value=mock_client):
        # Make 3 consecutive requests
        for i in range(3):
            response = Response(402)
            response.request = Request("GET", f"https://example.com/request-{i}")
            response._content = json.dumps(payment_response.model_dump(by_alias=True)).encode()
            
            result = await hooks.on_response(response)
            assert result.status_code == 200, f"Request {i} failed with status {result.status_code}"

        # All 3 payment requests should have been made
        assert mock_client.send.call_count == 3
        assert hooks.client.create_payment_header.call_count == 3


async def test_concurrent_mixed_free_and_paid_requests(hooks, payment_requirements):
    """Test concurrent requests with mixed free (200) and paid (402) responses."""
    import asyncio

    payment_response = x402PaymentRequiredResponse(
        x402_version=1,
        accepts=[payment_requirements],
        error="Payment Required",
    )

    # Create mix of 200 and 402 responses
    responses = []
    
    # Free responses (200)
    for i in range(2):
        response = Response(200)
        response._content = b'{"free": true}'
        responses.append(("free", response))

    # Paid responses (402)
    for i in range(3):
        response = Response(402)
        response.request = Request("GET", f"https://example.com/paid-{i}")
        response._content = json.dumps(payment_response.model_dump(by_alias=True)).encode()
        responses.append(("paid", response))

    retry_response = Response(200)
    retry_response.headers = {"X-Payment-Response": "success"}
    retry_response._content = b'{"success": true}'

    mock_client = AsyncMock()
    mock_client.send.return_value = retry_response
    mock_client.__aenter__.return_value = mock_client

    hooks.client.select_payment_requirements = MagicMock(return_value=payment_requirements)
    hooks.client.create_payment_header = MagicMock(return_value="mock_payment_header")

    with patch("x402.clients.httpx.AsyncClient", return_value=mock_client):
        tasks = [hooks.on_response(resp) for _, resp in responses]
        results = await asyncio.gather(*tasks)

        # All should succeed (200)
        assert all(r.status_code == 200 for r in results)

        # Only paid requests (3) should trigger payment creation
        assert hooks.client.create_payment_header.call_count == 3
