from __future__ import annotations

import asyncio
import json
import unittest
import uuid
from typing import Any

import bcrypt
from websockets.asyncio.client import ClientConnection, connect
from websockets.asyncio.server import serve

from capture_control_center.infrastructure.relay_bridge_client import RelayBridgeClient, RelayCredentials
from live_server.live_server import (
    AuthService,
    Config,
    ConnectionHandler,
    MessageRouter,
    RateLimiter,
    SessionRegistry,
)


class RelayIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.username = 'operator'
        self.password = 'correct-password'
        self.session_id = 'test-session'
        password_hash = bcrypt.hashpw(self.password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        config = Config(
            host='127.0.0.1',
            port=0,
            session_id=self.session_id,
            username=self.username,
            password_hash=password_hash,
            allow_plain_ws=True,
        )
        handler = ConnectionHandler(
            config,
            AuthService(self.username, password_hash),
            RateLimiter(max_failures=5, window_seconds=60),
            SessionRegistry(),
            MessageRouter(),
        )
        self.server = await serve(handler.handle, '127.0.0.1', 0, ping_interval=None)
        self.port = int(self.server.sockets[0].getsockname()[1])
        self.url = f'ws://127.0.0.1:{self.port}'
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.client: RelayBridgeClient | None = None
        self.peer: ClientConnection | None = None

    async def asyncTearDown(self) -> None:
        if self.peer is not None:
            await self.peer.close()
        if self.client is not None:
            await self.client.stop()
        self.server.close()
        await self.server.wait_closed()

    async def wait_for_event(self, name: str, timeout: float = 3.0) -> dict[str, Any]:
        async def find() -> dict[str, Any]:
            while True:
                for event_name, payload in self.events:
                    if event_name == name:
                        return payload
                await asyncio.sleep(0.01)

        return await asyncio.wait_for(find(), timeout=timeout)

    async def register_extension(self) -> ClientConnection:
        websocket = await connect(self.url, ping_interval=None)
        hello = json.loads(await websocket.recv())
        self.assertEqual(hello['type'], 'server.hello')
        await websocket.send(
            json.dumps(
                {
                    'type': 'client.register',
                    'clientId': str(uuid.uuid4()),
                    'name': 'relay-test-extension',
                    'version': 'test',
                    'role': 'extension-client',
                    'sessionId': self.session_id,
                    'capabilities': ['clipboard.write'],
                }
            )
        )
        ack = json.loads(await websocket.recv())
        self.assertEqual(ack['type'], 'register.ack')
        return websocket

    async def test_authentication_can_be_corrected_and_requests_flow(self) -> None:
        credentials = RelayCredentials(
            username=self.username,
            password='wrong-password',
            session_id=self.session_id,
        )
        self.client = RelayBridgeClient(self.url, credentials_provider=lambda: credentials)
        self.client.set_event_callback(lambda name, payload: self.events.append((name, payload)))
        await self.client.start()

        await self.wait_for_event('relay_auth_failed')
        await self.client.update_credentials(self.username, self.password, self.session_id)
        await self.wait_for_event('relay_connected')

        self.peer = await self.register_extension()
        await self.wait_for_event('client_connected')

        request_task = asyncio.create_task(self.client.request_clipboard_write('relay text', timeout_seconds=3))
        while True:
            payload = json.loads(await asyncio.wait_for(self.peer.recv(), timeout=2))
            if payload.get('type') == 'clipboard.write':
                break
        await self.peer.send(
            json.dumps(
                {
                    'type': 'clipboard.result',
                    'requestId': payload['requestId'],
                    'characterCount': 10,
                    'lineCount': 1,
                }
            )
        )
        self.assertEqual(await request_task, {'character_count': 10, 'line_count': 1})

    async def test_transport_loss_fails_in_flight_request_without_waiting_for_timeout(self) -> None:
        credentials = RelayCredentials(self.username, self.password, self.session_id)
        self.client = RelayBridgeClient(self.url, credentials_provider=lambda: credentials)
        self.client.set_event_callback(lambda name, payload: self.events.append((name, payload)))
        await self.client.start()
        await self.wait_for_event('relay_connected')

        self.peer = await self.register_extension()
        await self.wait_for_event('client_connected')
        request_task = asyncio.create_task(self.client.request_clipboard_write('lost', timeout_seconds=30))
        while True:
            payload = json.loads(await asyncio.wait_for(self.peer.recv(), timeout=2))
            if payload.get('type') == 'clipboard.write':
                break

        self.server.close()
        await self.server.wait_closed()
        with self.assertRaisesRegex(RuntimeError, 'Relay transport disconnected'):
            await asyncio.wait_for(request_task, timeout=3)


if __name__ == '__main__':
    unittest.main()
