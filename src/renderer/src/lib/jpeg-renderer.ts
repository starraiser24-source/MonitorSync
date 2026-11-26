/**
 * Low-latency JPEG frame renderer with automatic stale-frame dropping.
 */
export class JpegFrameRenderer {
  private busy = false
  private pendingBytes: Uint8Array | null = null
  private disposed = false

  constructor(private onBitmap: (bitmap: ImageBitmap) => void) {}

  push(jpegBytes: Uint8Array): void {
    if (this.disposed) return
    if (this.busy) {
      // Drop older queued frame and keep only the latest
      this.pendingBytes = jpegBytes
      return
    }
    void this.decode(jpegBytes)
  }

  private async decode(bytes: Uint8Array): Promise<void> {
    this.busy = true
    try {
      const copy = new Uint8Array(bytes)
      const blob = new Blob([copy], { type: 'image/jpeg' })
      const bitmap = await createImageBitmap(blob)
      if (!this.disposed) {
        this.onBitmap(bitmap)
      } else {
        bitmap.close()
      }
    } catch {
      // Ignore corrupt/partial JPEG frames
    } finally {
      this.busy = false
      if (!this.disposed && this.pendingBytes) {
        const next = this.pendingBytes
        this.pendingBytes = null
        void this.decode(next)
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.pendingBytes = null
  }
}
