import {
  FRAME_TYPE_H264_CONFIG,
  FRAME_TYPE_H264_DELTA,
  FRAME_TYPE_H264_KEYFRAME
} from '@shared/types'

/**
 * Extract `avc1.PPCCLL` codec string from an H.264 Annex-B SPS NAL unit.
 */
function extractAvcCodecFromAnnexB(data: Uint8Array): string {
  for (let i = 0; i < data.length - 6; i++) {
    let nalStart = -1
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      nalStart = i + 3
    } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      nalStart = i + 4
    }
    if (nalStart >= 0 && nalStart + 3 < data.length) {
      const nalType = data[nalStart] & 0x1f
      if (nalType === 7) {
        // SPS NAL unit: bytes +1, +2, +3 are profile_idc, constraint_flags, level_idc
        const profile = data[nalStart + 1].toString(16).padStart(2, '0')
        const constraints = data[nalStart + 2].toString(16).padStart(2, '0')
        const level = data[nalStart + 3].toString(16).padStart(2, '0')
        return `avc1.${profile}${constraints}${level}`
      }
    }
  }
  return 'avc1.640028'
}

/**
 * Hardware-accelerated H.264 Annex-B decoder using WebCodecs VideoDecoder.
 */
export class H264CanvasDecoder {
  private decoder: VideoDecoder | null = null
  private configPacket: Uint8Array | null = null
  private currentCodec = 'avc1.640028'
  private configured = false
  private waitingForKeyframe = true
  private timestamp = 0

  constructor(
    private onFrame: (frame: VideoFrame) => void,
    private onError?: (err: Error) => void
  ) {}

  private ensureDecoder(): void {
    if (this.decoder && this.decoder.state !== 'closed') return
    if (typeof VideoDecoder === 'undefined') {
      this.onError?.(new Error('当前环境不支持 WebCodecs VideoDecoder'))
      return
    }

    this.configured = false
    this.waitingForKeyframe = true
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.onFrame(frame)
      },
      error: (err) => {
        this.configured = false
        this.waitingForKeyframe = true
        this.onError?.(err)
      }
    })
  }

  private configureDecoder(codec: string): void {
    if (!this.decoder || this.decoder.state === 'closed') return
    this.currentCodec = codec
    this.decoder.configure({
      codec,
      optimizeForLatency: true
    })
    this.configured = true
    this.waitingForKeyframe = true
  }

  feed(frameType: number, payload: Uint8Array): void {
    this.ensureDecoder()
    if (!this.decoder || this.decoder.state === 'closed') return

    if (frameType === FRAME_TYPE_H264_CONFIG) {
      this.configPacket = new Uint8Array(payload)
      const codec = extractAvcCodecFromAnnexB(this.configPacket)
      if (!this.configured || codec !== this.currentCodec) {
        this.configureDecoder(codec)
      }
      return
    }

    if (!this.configured) {
      this.configureDecoder(this.currentCodec)
    }

    const isKey = frameType === FRAME_TYPE_H264_KEYFRAME
    if (this.waitingForKeyframe) {
      if (!isKey) return
      this.waitingForKeyframe = false
    }

    // Drop delta frames if decoder queue backs up to maintain low latency
    if (!isKey && this.decoder.decodeQueueSize > 8) {
      return
    }

    let data = payload
    if (isKey && this.configPacket) {
      const merged = new Uint8Array(this.configPacket.length + payload.length)
      merged.set(this.configPacket, 0)
      merged.set(payload, this.configPacket.length)
      data = merged
    }

    if (frameType === FRAME_TYPE_H264_KEYFRAME || frameType === FRAME_TYPE_H264_DELTA) {
      const chunk = new EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp: this.timestamp,
        data
      })
      this.timestamp += 16666
      try {
        if (this.decoder.state === 'configured') {
          this.decoder.decode(chunk)
        }
      } catch (err) {
        this.waitingForKeyframe = true
        this.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }

  close(): void {
    try {
      this.decoder?.close()
    } catch {
      // ignore
    }
    this.decoder = null
    this.configured = false
    this.waitingForKeyframe = true
    this.configPacket = null
  }
}
