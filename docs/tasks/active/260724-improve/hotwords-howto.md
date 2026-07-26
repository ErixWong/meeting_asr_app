
# FunASR 实时音频流传入热词说明

本文说明：**在 FunASR WebSocket 实时音频流场景下，如何在调用时传入热词表**，以及 Python / Node.js 的示例代码。

---

## 1. 结论

对于 FunASR 的实时流式识别，**热词应在 WebSocket 连接建立后的第一条消息里传入**，也就是**初始化配置帧**，不是在后续音频二进制流里传。

热词字段通常是：

- `hotwords`

其值是一个 **JSON 字符串**，内容为“热词 -> 权重”的映射。

---

## 2. 传输方式概览

WebSocket 实时识别的典型流程：

1. 建立 WebSocket 连接
2. 发送第一帧 JSON 配置消息
   - 包含 `is_speaking: true`
   - 包含 `mode: "2pass"` 或 `online`
   - 包含 `wav_name`
   - 包含 `wav_format`
   - 包含 `audio_fs`
   - 包含 `chunk_size`
   - **包含 `hotwords`**
3. 持续发送音频二进制帧
4. 结束时发送 `is_speaking: false`
5. 接收服务端识别结果

---

## 3. 热词格式

如果你的热词表是这样的：

```txt
阿里巴巴 20
达摩院 15
语音识别 10
```

那么在调用方里应转换为：

```json
{"阿里巴巴":20,"达摩院":15,"语音识别":10}
```

并作为字符串放到 `hotwords` 字段中。

---

## 4. WebSocket 首帧示例

```json
{
  "is_speaking": true,
  "mode": "2pass",
  "wav_name": "demo.wav",
  "wav_format": "pcm",
  "audio_fs": 16000,
  "chunk_size": [5, 10, 5],
  "hotwords": "{\"阿里巴巴\":20,\"达摩院\":15,\"语音识别\":10}"
}
```

---

# 5. Python 示例

下面示例使用 `websocket-client`。

## 5.1 安装依赖

```bash
pip install websocket-client
```

## 5.2 示例代码

```python
import json
import websocket

WS_URL = "ws://127.0.0.1:10095"

def main():
    ws = websocket.create_connection(WS_URL)

    # 热词表：热词 -> 权重
    hotword_map = {
        "阿里巴巴": 20,
        "达摩院": 15,
        "语音识别": 10
    }

    # 初始化消息：第一帧必须先发配置
    init_msg = {
        "is_speaking": True,
        "mode": "2pass",
        "wav_name": "demo.pcm",
        "wav_format": "pcm",
        "audio_fs": 16000,
        "chunk_size": [5, 10, 5],
        "hotwords": json.dumps(hotword_map, ensure_ascii=False)
    }

    ws.send(json.dumps(init_msg, ensure_ascii=False))

    # 发送实时音频流（这里演示从 pcm 文件读取）
    # 实际接麦克风时，把每个音频 chunk 直接发到这里即可
    with open("demo.pcm", "rb") as f:
        while True:
            chunk = f.read(3200)  # 例如每次读取 100ms 左右音频
            if not chunk:
                break
            ws.send(chunk, opcode=websocket.ABNF.OPCODE_BINARY)

    # 结束说话
    ws.send(json.dumps({
        "is_speaking": False
    }, ensure_ascii=False))

    # 接收识别结果
    while True:
        try:
            resp = ws.recv()
            if not resp:
                break
            print(resp)
        except Exception as e:
            print("WebSocket closed:", e)
            break

    ws.close()

if __name__ == "__main__":
    main()
```

---

# 6. Node.js 示例

下面示例使用 `ws`。

## 6.1 安装依赖

```bash
npm install ws
```

## 6.2 示例代码

```javascript
const WebSocket = require('ws');
const fs = require('fs');

const WS_URL = 'ws://127.0.0.1:10095';

const hotwordMap = {
  '阿里巴巴': 20,
  '达摩院': 15,
  '语音识别': 10
};

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  // 第一帧：初始化配置
  ws.send(JSON.stringify({
    is_speaking: true,
    mode: '2pass',
    wav_name: 'demo.pcm',
    wav_format: 'pcm',
    audio_fs: 16000,
    chunk_size: [5, 10, 5],
    hotwords: JSON.stringify(hotwordMap)
  }));

  // 发送实时音频流
  const stream = fs.createReadStream('demo.pcm', {
    highWaterMark: 3200
  });

  stream.on('data', (chunk) => {
    ws.send(chunk);
  });

  stream.on('end', () => {
    // 结束说话
    ws.send(JSON.stringify({
      is_speaking: false
    }));
  });
});

ws.on('message', (data) => {
  console.log('ASR:', data.toString());
});

ws.on('close', () => {
  console.log('WebSocket closed');
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err);
});
```

---

## 7. 如果你是“麦克风实时采集”

如果不是读取文件，而是麦克风实时采集，逻辑也是一样：

- 先发初始化 JSON
- 然后每次麦克风采集到一段 PCM 数据，就发一个 binary frame
- 最后发 `is_speaking: false`

也就是说，**热词不需要每个音频包都带一次，只在第一帧带一次即可**。

---

## 8. 常见注意事项

### 8.1 热词只在首帧传

不要把热词放到音频二进制流里。

### 8.2 `hotwords` 是字符串，不是对象

要注意这一点：

```json
"hotwords": "{\"阿里巴巴\":20}"
```

而不是：

```json
"hotwords": {"阿里巴巴":20}
```

### 8.3 权重不是越大越好

权重过大可能造成误召回，建议先从 10、15、20 试起。

### 8.4 `chunk_size` 影响实时性

常用：

```json
[5, 10, 5]
```

这是常见的低延迟配置，但你可以根据延迟和稳定性调节。

---

## 9. 可直接给开发同事的简短说明

> 在 FunASR 实时 WebSocket 流式识别中，热词通过第一帧初始化 JSON 消息传入，字段名为 `hotwords`，值为 JSON 字符串（热词和权重映射）。后续音频数据正常以 binary frame 发送，热词不需要重复发送。

---

如果你愿意，我还可以继续帮你补一版：

1. **更正式的项目文档版 Markdown**
2. **接麦克风的 Python 示例**
3. **接麦克风的 Node.js 示例**
4. **按你容器的实际端口和路径，写成可直接运行的部署说明**
