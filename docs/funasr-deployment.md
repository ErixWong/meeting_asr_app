# FunASR 本地部署指南

> 部署自建 FunASR 在线服务（2pass WebSocket），供本系统 ASR Gateway 使用。
> 应用本身的部署参见 [deployment-guide.md](./deployment-guide.md)。

## 1. 部署模型

```text
宿主机 (Linux)
└── <模型目录>/               # 模型下载/存放目录，挂载到容器 /workspace/models
    └── damo/                # FunASR 模型（首次启动自动下载）
```

- 镜像：阿里云容器镜像仓库官方镜像 `funasr-runtime-sdk-online-cpu`（CPU 在线 2pass 版本）
- 服务：`funasr-wss-server-2pass`，监听 `10095` 端口，WebSocket 路径 `/ws`
- 模型：首次启动自动下载到挂载目录；如需固定具体模型，使用注释中的带参命令

## 2. 前置条件

- Docker Engine + Compose v2
- 已开放端口：`10095`
- 模型目录磁盘空间充足（PARAFORMER + VAD + 标点模型合计约数 GB）

## 3. docker-compose 配置

将以下内容保存为独立部署目录下的 `docker-compose.yml`（不并入本应用 compose，作为独立服务管理）：

```yaml
services:
  funasr:
    image: registry.cn-hangzhou.aliyuncs.com/funasr_repo/funasr:funasr-runtime-sdk-online-cpu-0.1.13
    container_name: funasr-online
    restart: unless-stopped
    privileged: true
    ports:
      - "10095:10095"
    volumes:
      - <宿主机模型目录>:/workspace/models
    environment:
      DOWNLOAD_MODEL_DIR: /workspace/models
    command: "/workspace/FunASR/runtime/websocket/build/bin/funasr-wss-server-2pass --download-model-dir /workspace/models --certfile 0 --port 10095"
    # 如需固定具体模型（VAD/离线/在线/标点），改用以下命令：
    #command: >
    #  /workspace/FunASR/runtime/websocket/build/bin/funasr-wss-server-2pass
    #  --download-model-dir /workspace/models
    #  --vad-dir damo/speech_fsmn_vad_zh-cn-16k-common-onnx
    #  --model-dir damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx
    #  --online-model-dir damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online-onnx
    #  --punc-dir damo/punc_ct-transformer_cn-en-common-vocab471067-large-onnx
    #  --certfile 0
    #  --port 10095
    healthcheck:
      test: ["CMD-SHELL", "sh -c 'nc -z 127.0.0.1 10095'"]
      interval: 10s
      timeout: 5s
      retries: 60
      start_period: 300s
```

> 网络说明：如需加入自定义 overlay 网络供其他服务直连，可追加 `networks:` 与 `ipv4_address` 指定固定内网 IP；普通部署（宿主机端口映射）可省略网络配置，上面的清单已按最简形式给出。

> `privileged: true` 为镜像官方要求；如部署环境不允许特权模式，需自行验证功能完整性。

## 4. 部署步骤

```bash
mkdir -p /docker/funasr/models
cd /docker/funasr
# 将上面的 compose 内容保存为 docker-compose.yml，把 <宿主机模型目录> 替换为实际路径
docker compose up -d
docker compose ps          # 状态应为 running (healthy)
```

- 首次启动会下载模型，`start_period` 已按 300s 配置；模型已存在时启动很快
- 查看日志确认服务就绪：

```bash
docker compose logs -f funasr
```

## 5. 验证

```bash
# 宿主机端口监听检查
nc -z 127.0.0.1 10095 && echo OK

# 使用项目探针脚本验证（TCP/HTTP/WS）
npm run probe:service -- <host> 10095
```

浏览器/客户端可直接连接 `ws://<host>:10095/ws`。

## 6. 接入本系统

后台管理 → ASR 配置：

- Provider 类型：`local_funasr`
- Endpoint 地址：`http://<host>:10095`（Gateway 会自动转换为 `ws://<host>:10095/ws`）

配置保存后即可在主页进行录音转写。

## 7. 常见问题

| 现象 | 原因与处理 |
|:---|:---|
| 容器反复重启 / healthcheck 不通过 | 首次模型下载未完成，查看 `docker compose logs funasr`；确认网络可访问模型仓库 |
| 转写无结果或连接失败 | 确认 `10095` 端口已开放、`probe:service` 通过；检查后台 Endpoint 是否含端口 |
| 内存占用高 | CPU 版 2pass 默认加载离线+在线两套模型；可改用固定模型命令按需裁剪 |
