// Binary envelope: 4-byte big-endian length prefix + UTF-8 JSON metadata + raw payload.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace PageSignal.NativeAgent
{
    internal static class WireProtocol
    {
        private static readonly JavaScriptSerializer _json = new JavaScriptSerializer();

        static WireProtocol()
        {
            _json.MaxJsonLength = int.MaxValue;
        }

        public static string SerializeJson(object value) { return _json.Serialize(value); }

        public static IDictionary<string, object> ParseJsonObject(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            object obj = _json.DeserializeObject(text);
            return obj as IDictionary<string, object>;
        }

        public static byte[] BuildBinaryEnvelope(IDictionary<string, object> metadata, byte[] payload)
        {
            byte[] metaBytes = Encoding.UTF8.GetBytes(_json.Serialize(metadata));
            byte[] prefix = new byte[4];
            // big-endian length
            uint n = (uint)metaBytes.Length;
            prefix[0] = (byte)((n >> 24) & 0xFF);
            prefix[1] = (byte)((n >> 16) & 0xFF);
            prefix[2] = (byte)((n >> 8) & 0xFF);
            prefix[3] = (byte)(n & 0xFF);
            byte[] result = new byte[prefix.Length + metaBytes.Length + (payload != null ? payload.Length : 0)];
            Buffer.BlockCopy(prefix, 0, result, 0, prefix.Length);
            Buffer.BlockCopy(metaBytes, 0, result, prefix.Length, metaBytes.Length);
            if (payload != null && payload.Length > 0)
                Buffer.BlockCopy(payload, 0, result, prefix.Length + metaBytes.Length, payload.Length);
            return result;
        }

        public static bool TryDecodeBinaryEnvelope(byte[] frame, out IDictionary<string, object> metadata, out byte[] payload)
        {
            metadata = null; payload = null;
            if (frame == null || frame.Length < 4) return false;
            uint len = ((uint)frame[0] << 24) | ((uint)frame[1] << 16) | ((uint)frame[2] << 8) | frame[3];
            if (4 + len > frame.Length) return false;
            string metaStr = Encoding.UTF8.GetString(frame, 4, (int)len);
            metadata = ParseJsonObject(metaStr);
            int payloadOffset = 4 + (int)len;
            int payloadLen = frame.Length - payloadOffset;
            payload = new byte[payloadLen];
            Buffer.BlockCopy(frame, payloadOffset, payload, 0, payloadLen);
            return metadata != null;
        }
    }
}
