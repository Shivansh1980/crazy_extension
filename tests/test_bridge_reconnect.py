from __future__ import annotations

import asyncio
import json
import unittest
import uuid
from typing import Any

from websockets.asyncio.client import ClientConnection, connect

from capture_control_center.infrastructure.bridge_server import BridgeServer


class BridgeReconnectTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.server = BridgeServer('127.0.0.1', 0)
        self.server.set_event_callback(lambda name, payload: self.events.append((name, payload)))
        await self.server.start()
        self.url = f'ws://127.0.0.1:{self.server.bound_port}'
        self.connections: list[ClientConnection] = []

    async def asyncTearDown(self) -> None:
        for websocket in self.connections:
            try:
                await websocket.close()
            except Exception:
                pass
        await self.server.stop()

    async def register(self, role: str, capabilities: list[str]) -> ClientConnection:
        websocket = await connect(self.url, ping_interval=None)
        self.connections.append(websocket)
        await websocket.send(
            json.dumps(
                {
                    'type': 'client.register',
                    'clientId': str(uuid.uuid4()),
                    'name': f'test-{role}',
                    'version': 'test',
                    'role': role,
                    'sessionId': 'default',
                    'capabilities': capabilities,
                }
            )
        )
        ack = json.loads(await asyncio.wait_for(websocket.recv(), timeout=2))
        self.assertEqual(ack['type'], 'register.ack')
        return websocket

    async def test_in_flight_request_completes_after_extension_reconnect(self) -> None:
        first_extension = await self.register('extension-client', ['clipboard.write'])
        pending = asyncio.create_task(self.server.request_clipboard_write('hello', timeout_seconds=3))
        request = json.loads(await asyncio.wait_for(first_extension.recv(), timeout=2))
        self.assertEqual(request['type'], 'clipboard.write')

        await first_extension.close()
        replacement = await self.register('extension-client', ['clipboard.write'])
        await replacement.send(
            json.dumps(
                {
                    'type': 'clipboard.result',
                    'requestId': request['requestId'],
                    'characterCount': 5,
                    'lineCount': 1,
                }
            )
        )

        self.assertEqual(await pending, {'character_count': 5, 'line_count': 1})

    async def test_stream_role_does_not_replace_extension_and_reconnects_cleanly(self) -> None:
        extension = await self.register('extension-client', ['clipboard.write'])
        stream = await self.register('screen-share-stream', ['screen-share.stream'])
        await stream.close()
        await asyncio.sleep(0)

        pending = asyncio.create_task(self.server.request_clipboard_write('still connected', timeout_seconds=3))
        request = json.loads(await asyncio.wait_for(extension.recv(), timeout=2))
        await extension.send(
            json.dumps(
                {
                    'type': 'clipboard.result',
                    'requestId': request['requestId'],
                    'characterCount': 15,
                    'lineCount': 1,
                }
            )
        )
        self.assertEqual((await pending)['character_count'], 15)
        self.assertTrue(any(name == 'screen_share_stream_interrupted' for name, _ in self.events))

    async def test_native_role_without_os_input_does_not_replace_extension(self) -> None:
        extension = await self.register('extension-client', ['clipboard.write', 'screen-share.input'])
        await self.register('native-input-client', ['screen-capture', 'native-popup'])

        pending = asyncio.create_task(self.server.request_clipboard_write('browser-owned', timeout_seconds=3))
        request = json.loads(await asyncio.wait_for(extension.recv(), timeout=2))
        self.assertEqual(request['type'], 'clipboard.write')
        await extension.send(
            json.dumps(
                {
                    'type': 'clipboard.result',
                    'requestId': request['requestId'],
                    'characterCount': 13,
                    'lineCount': 1,
                }
            )
        )
        self.assertEqual((await pending)['character_count'], 13)

        input_pending = asyncio.create_task(
            self.server.request_screen_share_input('click', 0.25, 0.75, timeout_seconds=3)
        )
        input_request = json.loads(await asyncio.wait_for(extension.recv(), timeout=2))
        self.assertEqual(input_request['type'], 'screen-share.input')
        await extension.send(
            json.dumps(
                {
                    'type': 'screen-share.input-result',
                    'requestId': input_request['requestId'],
                    'message': 'extension handled input',
                }
            )
        )
        self.assertEqual((await input_pending)['message'], 'extension handled input')

        extension_event = next(payload for name, payload in self.events if name == 'client_connected')
        self.assertIn('screen-share.input', extension_event['capabilities'])

    async def test_malformed_registered_frame_is_isolated_without_disconnect(self) -> None:
        extension = await self.register('extension-client', ['clipboard.write'])
        await extension.send('{not-json')
        pending = asyncio.create_task(self.server.request_clipboard_write('after malformed', timeout_seconds=3))
        request = json.loads(await asyncio.wait_for(extension.recv(), timeout=2))
        await extension.send(
            json.dumps(
                {
                    'type': 'clipboard.result',
                    'requestId': request['requestId'],
                    'characterCount': 15,
                    'lineCount': 1,
                }
            )
        )
        self.assertEqual((await pending)['character_count'], 15)


if __name__ == '__main__':
    unittest.main()
