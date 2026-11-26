#include <arpa/inet.h>
#include <atomic>
#include <cerrno>
#include <cstring>
#include <hilog/log.h>
#include <multimedia/player_framework/native_avbuffer.h>
#include <multimedia/player_framework/native_avcodec_base.h>
#include <multimedia/player_framework/native_avcodec_videoencoder.h>
#include <multimedia/player_framework/native_avformat.h>
#include <multimedia/player_framework/native_avscreen_capture.h>
#include <mutex>
#include <napi/native_api.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>
#include <vector>

#undef LOG_DOMAIN
#undef LOG_TAG
#define LOG_DOMAIN 0x3200
#define LOG_TAG "MonitorSyncStreamer"

namespace {

constexpr uint8_t FRAME_TYPE_HEARTBEAT = 0x00;
constexpr uint8_t FRAME_TYPE_H264_CONFIG = 0x02;
constexpr uint8_t FRAME_TYPE_H264_KEYFRAME = 0x03;
constexpr uint8_t FRAME_TYPE_H264_DELTA = 0x04;

bool SendAll(int fd, const uint8_t *data, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        ssize_t n = send(fd, data + sent, len - sent, MSG_NOSIGNAL);
        if (n <= 0) {
            if (errno == EINTR) continue;
            return false;
        }
        sent += static_cast<size_t>(n);
    }
    return true;
}

void WriteU32BE(uint8_t *dst, uint32_t v) {
    dst[0] = static_cast<uint8_t>((v >> 24) & 0xFF);
    dst[1] = static_cast<uint8_t>((v >> 16) & 0xFF);
    dst[2] = static_cast<uint8_t>((v >> 8) & 0xFF);
    dst[3] = static_cast<uint8_t>(v & 0xFF);
}

class ScreenStreamer {
public:
    static ScreenStreamer &Instance() {
        static ScreenStreamer inst;
        return inst;
    }

    bool Start(int32_t width, int32_t height, int32_t fps, int32_t bitrate, int32_t port) {
        Stop();

        width_ = width;
        height_ = height;
        fps_ = fps;
        bitrate_ = bitrate;
        port_ = port;
        running_.store(true);

        if (!StartTcpServer(port)) {
            OH_LOG_ERROR(LOG_APP, "Failed to start TCP server on port %{public}d", port);
            Stop();
            return false;
        }

        if (!StartEncoder()) {
            OH_LOG_ERROR(LOG_APP, "Failed to start OH_VideoEncoder");
            Stop();
            return false;
        }

        if (!StartCapture()) {
            OH_LOG_ERROR(LOG_APP, "Failed to start OH_AVScreenCapture");
            Stop();
            return false;
        }

        OH_LOG_INFO(LOG_APP, "MonitorSync 60fps H.264 streamer started (%{public}dx%{public}d @ %{public}dfps, port %{public}d)",
                    width_, height_, fps_, port_);
        return true;
    }

    void Stop() {
        running_.store(false);

        if (capture_ != nullptr) {
            OH_AVScreenCapture_StopScreenCapture(capture_);
            OH_AVScreenCapture_Release(capture_);
            capture_ = nullptr;
        }

        if (encoder_ != nullptr) {
            OH_VideoEncoder_Stop(encoder_);
            OH_VideoEncoder_Destroy(encoder_);
            encoder_ = nullptr;
        }

        if (nativeWindow_ != nullptr) {
            OH_NativeWindow_DestroyNativeWindow(nativeWindow_);
            nativeWindow_ = nullptr;
        }

        if (serverFd_ >= 0) {
            shutdown(serverFd_, SHUT_RDWR);
            close(serverFd_);
            serverFd_ = -1;
        }

        if (acceptThread_.joinable()) {
            acceptThread_.join();
        }
        if (heartbeatThread_.joinable()) {
            heartbeatThread_.join();
        }

        {
            std::lock_guard<std::mutex> lock(clientMutex_);
            if (clientFd_ >= 0) {
                shutdown(clientFd_, SHUT_RDWR);
                close(clientFd_);
                clientFd_ = -1;
            }
            cachedConfig_.clear();
        }
    }

    bool IsRunning() const {
        return running_.load();
    }

    void RequestKeyFrame() {
        if (encoder_ == nullptr || !running_.load()) return;
        OH_AVFormat *fmt = OH_AVFormat_Create();
        if (fmt != nullptr) {
            OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_REQUEST_I_FRAME, 1);
            OH_VideoEncoder_SetParameter(encoder_, fmt);
            OH_AVFormat_Destroy(fmt);
        }
    }

private:
    ScreenStreamer() = default;
    ~ScreenStreamer() { Stop(); }

    bool StartTcpServer(int32_t port) {
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        if (fd < 0) return false;

        int opt = 1;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = htons(static_cast<uint16_t>(port));

        if (bind(fd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) < 0) {
            close(fd);
            return false;
        }
        if (listen(fd, 2) < 0) {
            close(fd);
            return false;
        }

        serverFd_ = fd;
        acceptThread_ = std::thread([this]() { AcceptLoop(); });
        heartbeatThread_ = std::thread([this]() { HeartbeatLoop(); });
        return true;
    }

    void HeartbeatLoop() {
        while (running_.load()) {
            for (int i = 0; i < 30 && running_.load(); ++i) {
                usleep(100000); // 100ms x 30 = 3s
            }
            if (!running_.load()) break;
            std::lock_guard<std::mutex> lock(clientMutex_);
            if (clientFd_ >= 0) {
                uint8_t hb[5] = {FRAME_TYPE_HEARTBEAT, 0, 0, 0, 0};
                if (!SendAll(clientFd_, hb, sizeof(hb))) {
                    shutdown(clientFd_, SHUT_RDWR);
                    close(clientFd_);
                    clientFd_ = -1;
                }
            }
        }
    }

    void AcceptLoop() {
        while (running_.load()) {
            sockaddr_in clientAddr{};
            socklen_t len = sizeof(clientAddr);
            int cfd = accept(serverFd_, reinterpret_cast<sockaddr *>(&clientAddr), &len);
            if (cfd < 0) {
                if (!running_.load()) break;
                continue;
            }

            int nodelay = 1;
            setsockopt(cfd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));
            int keepalive = 1;
            setsockopt(cfd, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive));

            {
                std::lock_guard<std::mutex> lock(clientMutex_);
                if (clientFd_ >= 0) {
                    shutdown(clientFd_, SHUT_RDWR);
                    close(clientFd_);
                }
                clientFd_ = cfd;

                // Send 12-byte handshake header: "MSH1" + width(BE32) + height(BE32)
                uint8_t header[12] = {'M', 'S', 'H', '1', 0, 0, 0, 0, 0, 0, 0, 0};
                WriteU32BE(header + 4, static_cast<uint32_t>(width_));
                WriteU32BE(header + 8, static_cast<uint32_t>(height_));
                if (!SendAll(clientFd_, header, sizeof(header))) {
                    close(clientFd_);
                    clientFd_ = -1;
                    continue;
                }

                // Immediately send cached SPS/PPS if already available
                if (!cachedConfig_.empty()) {
                    SendPacketLocked(FRAME_TYPE_H264_CONFIG, cachedConfig_.data(), cachedConfig_.size());
                }
            }

            RequestKeyFrame();
        }
    }

    void SendPacketLocked(uint8_t frameType, const uint8_t *data, size_t size) {
        if (clientFd_ < 0 || size == 0) return;
        uint8_t pktHeader[5];
        pktHeader[0] = frameType;
        WriteU32BE(pktHeader + 1, static_cast<uint32_t>(size));
        if (!SendAll(clientFd_, pktHeader, sizeof(pktHeader)) || !SendAll(clientFd_, data, size)) {
            shutdown(clientFd_, SHUT_RDWR);
            close(clientFd_);
            clientFd_ = -1;
        }
    }

    static void OnCodecError(OH_AVCodec *, int32_t errorCode, void *) {
        OH_LOG_ERROR(LOG_APP, "OH_VideoEncoder error: %{public}d", errorCode);
    }

    static void OnCodecStreamChanged(OH_AVCodec *, OH_AVFormat *, void *) {}
    static void OnCodecNeedInputBuffer(OH_AVCodec *, uint32_t, OH_AVBuffer *, void *) {}

    static void OnCodecNewOutputBuffer(OH_AVCodec *codec, uint32_t index, OH_AVBuffer *buffer, void *userData) {
        auto *self = static_cast<ScreenStreamer *>(userData);
        if (self == nullptr || buffer == nullptr) {
            OH_VideoEncoder_FreeOutputBuffer(codec, index);
            return;
        }

        OH_AVCodecBufferAttr attr{};
        if (OH_AVBuffer_GetBufferAttr(buffer, &attr) == AV_ERR_OK && attr.size > 0) {
            uint8_t *addr = OH_AVBuffer_GetAddr(buffer);
            if (addr != nullptr) {
                const uint8_t *payload = addr + attr.offset;
                const size_t size = static_cast<size_t>(attr.size);

                uint8_t frameType = FRAME_TYPE_H264_DELTA;
                if ((attr.flags & AVCODEC_BUFFER_FLAGS_CODEC_DATA) != 0) {
                    frameType = FRAME_TYPE_H264_CONFIG;
                } else if ((attr.flags & AVCODEC_BUFFER_FLAGS_SYNC_FRAME) != 0) {
                    frameType = FRAME_TYPE_H264_KEYFRAME;
                }

                std::lock_guard<std::mutex> lock(self->clientMutex_);
                if (frameType == FRAME_TYPE_H264_CONFIG) {
                    self->cachedConfig_.assign(payload, payload + size);
                }
                self->SendPacketLocked(frameType, payload, size);
            }
        }

        OH_VideoEncoder_FreeOutputBuffer(codec, index);
    }

    bool StartEncoder() {
        encoder_ = OH_VideoEncoder_CreateByMime(OH_AVCODEC_MIMETYPE_VIDEO_AVC);
        if (encoder_ == nullptr) return false;

        OH_AVCodecCallback cb{};
        cb.onError = OnCodecError;
        cb.onStreamChanged = OnCodecStreamChanged;
        cb.onNeedInputBuffer = OnCodecNeedInputBuffer;
        cb.onNewOutputBuffer = OnCodecNewOutputBuffer;

        if (OH_VideoEncoder_RegisterCallback(encoder_, cb, this) != AV_ERR_OK) {
            return false;
        }

        OH_AVFormat *fmt = OH_AVFormat_Create();
        if (fmt == nullptr) return false;
        OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_WIDTH, width_);
        OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_HEIGHT, height_);
        OH_AVFormat_SetDoubleValue(fmt, OH_MD_KEY_FRAME_RATE, static_cast<double>(fps_));
        OH_AVFormat_SetLongValue(fmt, OH_MD_KEY_BITRATE, static_cast<int64_t>(bitrate_));
        OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_I_FRAME_INTERVAL, 1000);
        OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_PIXEL_FORMAT, AV_PIXEL_FORMAT_SURFACE_FORMAT);
        OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_VIDEO_ENCODE_BITRATE_MODE, VBR);

        OH_AVErrCode cfgErr = OH_VideoEncoder_Configure(encoder_, fmt);
        OH_AVFormat_Destroy(fmt);
        if (cfgErr != AV_ERR_OK) {
            OH_LOG_ERROR(LOG_APP, "OH_VideoEncoder_Configure failed: %{public}d", cfgErr);
            return false;
        }

        if (OH_VideoEncoder_GetSurface(encoder_, &nativeWindow_) != AV_ERR_OK || nativeWindow_ == nullptr) {
            OH_LOG_ERROR(LOG_APP, "OH_VideoEncoder_GetSurface failed");
            return false;
        }

        if (OH_VideoEncoder_Prepare(encoder_) != AV_ERR_OK) {
            return false;
        }

        return OH_VideoEncoder_Start(encoder_) == AV_ERR_OK;
    }

    static void OnCaptureStateChange(OH_AVScreenCapture *, OH_AVScreenCaptureStateCode stateCode, void *) {
        OH_LOG_INFO(LOG_APP, "AVScreenCapture state changed: %{public}d", static_cast<int>(stateCode));
    }

    static void OnCaptureError(OH_AVScreenCapture *, int32_t errorCode, void *) {
        OH_LOG_ERROR(LOG_APP, "AVScreenCapture error: %{public}d", errorCode);
    }

    bool StartCapture() {
        capture_ = OH_AVScreenCapture_Create();
        if (capture_ == nullptr) return false;

        OH_AVScreenCapture_SetStateCallback(capture_, OnCaptureStateChange, this);
        OH_AVScreenCapture_SetErrorCallback(capture_, OnCaptureError, this);

        OH_AVScreenCaptureConfig config{};
        config.captureMode = OH_CAPTURE_HOME_SCREEN;
        config.dataType = OH_ORIGINAL_STREAM;
        config.videoInfo.videoCapInfo.videoFrameWidth = width_;
        config.videoInfo.videoCapInfo.videoFrameHeight = height_;
        config.videoInfo.videoCapInfo.videoSource = OH_VIDEO_SOURCE_SURFACE_RGBA;
        config.videoInfo.videoEncInfo.videoCodec = OH_H264;
        config.videoInfo.videoEncInfo.videoBitrate = bitrate_;
        config.videoInfo.videoEncInfo.videoFrameRate = fps_;

        if (OH_AVScreenCapture_Init(capture_, config) != AV_SCREEN_CAPTURE_ERR_OK) {
            OH_LOG_ERROR(LOG_APP, "OH_AVScreenCapture_Init failed");
            return false;
        }

        OH_AVScreenCapture_SetMicrophoneEnabled(capture_, false);
        OH_AVScreenCapture_SetCanvasRotation(capture_, true);

        OH_AVSCREEN_CAPTURE_ErrCode startErr =
            OH_AVScreenCapture_StartScreenCaptureWithSurface(capture_, nativeWindow_);
        if (startErr != AV_SCREEN_CAPTURE_ERR_OK) {
            OH_LOG_ERROR(LOG_APP, "StartScreenCaptureWithSurface failed: %{public}d", startErr);
            return false;
        }
        return true;
    }

    std::atomic<bool> running_{false};
    int32_t width_ = 576;
    int32_t height_ = 1280;
    int32_t fps_ = 60;
    int32_t bitrate_ = 8000000;
    int32_t port_ = 27183;

    int serverFd_ = -1;
    int clientFd_ = -1;
    std::mutex clientMutex_;
    std::vector<uint8_t> cachedConfig_;
    std::thread acceptThread_;
    std::thread heartbeatThread_;

    OH_AVCodec *encoder_ = nullptr;
    OHNativeWindow *nativeWindow_ = nullptr;
    OH_AVScreenCapture *capture_ = nullptr;
};

napi_value NapiStart(napi_env env, napi_callback_info info) {
    size_t argc = 5;
    napi_value args[5];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    int32_t width = 576, height = 1280, fps = 60, bitrate = 8000000, port = 27183;
    if (argc >= 1) napi_get_value_int32(env, args[0], &width);
    if (argc >= 2) napi_get_value_int32(env, args[1], &height);
    if (argc >= 3) napi_get_value_int32(env, args[2], &fps);
    if (argc >= 4) napi_get_value_int32(env, args[3], &bitrate);
    if (argc >= 5) napi_get_value_int32(env, args[4], &port);

    bool ok = ScreenStreamer::Instance().Start(width, height, fps, bitrate, port);
    napi_value result;
    napi_get_boolean(env, ok, &result);
    return result;
}

napi_value NapiStop(napi_env env, napi_callback_info) {
    ScreenStreamer::Instance().Stop();
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

napi_value NapiIsRunning(napi_env env, napi_callback_info) {
    napi_value result;
    napi_get_boolean(env, ScreenStreamer::Instance().IsRunning(), &result);
    return result;
}

EXTERN_C_START
static napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
        {"start", nullptr, NapiStart, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stop", nullptr, NapiStop, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"isRunning", nullptr, NapiIsRunning, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}
EXTERN_C_END

static napi_module streamerModule = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = nullptr,
    .nm_register_func = Init,
    .nm_modname = "streamer",
    .nm_priv = nullptr,
    .reserved = {0},
};

extern "C" __attribute__((constructor)) void RegisterStreamerModule(void) {
    napi_module_register(&streamerModule);
}

} // namespace
